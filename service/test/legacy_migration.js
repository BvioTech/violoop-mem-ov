const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Database = require('better-sqlite3')
const { linkedLegacyDatabase } = require('./fixtures/legacy')
const { readLegacySnapshot, observationHash, hash } = require('../legacy_source')
const { planMigration, countMessages } = require('../legacy_migration_plan')
const { LegacyMigration } = require('../legacy_migration')
const { IngestJournal } = require('../openviking_adapter')
const { writeJson } = require('../durable_json')
const root = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-migrate-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir }
const time = '2023-05-07T01:02:03.000Z'
const entity = (id, observations = []) => ({ id, name: id, type: 'person', aliases: [], observations, properties: {}, domains: [], created_at: time })
const memory = (id, content = id) => ({ id, key: id, title: id, content, created_at: time })
function snapshot() { return { memories: [memory('a'), memory('b'), memory('orphan')], entities: [entity('hub', ['from a', 'from b', 'unlinked']), entity('other')], relations: [{ id: 'r', source: 'hub', target: 'other', relation_type: 'knows', created_at: time, properties: {} }], associations: {
  a: { observations: { hub: [observationHash('from a')] }, relations: ['r'] },
  b: { observations: { hub: [observationHash('from b')] }, relations: ['r'] },
} } }
function sourceDb(dir) { return linkedLegacyDatabase(path.join(dir, 'graph.db')) }

test('read-only snapshot preserves stored observation provenance and never modifies legacy DB', t => {
  const dir = root(t), file = sourceDb(dir)
  const before = hash(fs.readFileSync(file))
  const s = readLegacySnapshot(file)
  assert.equal(hash(fs.readFileSync(file)), before)
  const hub = s.entities.find(e => e.name === 'hub')
  assert.equal(s.associations.a.observations[hub.id][0], observationHash('linked'))
  assert.equal(s.associations.a.relations.length, 1)
  assert.deepEqual(hub.observations, ['linked', 'residual'])
  const plan = planMigration(s)
  const payload = plan.batches.flatMap(b => b.messages).map(m => JSON.parse(m.content.slice(m.content.indexOf('{'))))
  assert.equal(payload[0].entry.key, 'a')
  assert.deepEqual(payload[0].entities.find(e => e.id === hub.id).observations, ['linked'])
  assert.deepEqual(payload.find(p => p.id === hub.id).observations, ['residual'])
})

test('linked groups stay intact, residual observations survive, shared edge not repeated in residual pass', () => {
  const p = planMigration(snapshot(), { maxTokens: 1 })
  assert.deepEqual(p.batches.slice(0, 2).map(b => b.groups), [['memory:a'], ['memory:b']])
  assert.equal(p.batches.flatMap(b => b.groups).filter(g => g === 'relation:r').length, 0)
  const residual = p.batches.find(b => b.groups.includes('entity:hub'))
  assert.match(residual.messages[0].content, /unlinked/)
  assert.doesNotMatch(residual.messages[0].content, /from a|from b/)
  assert.equal(p.resources.length, 6)
  assert.ok(p.batches.flatMap(b => b.messages).every(m => m.createdAt === time && m.id.startsWith('violoop-legacy-migration:')))
  assert.ok(p.batches.every(b => b.messages.length === 1))
})

test('high-degree nodes batch by whole edges; no whole adjacency expansion and no truncation', () => {
  const hub = entity('hub', ['fact'])
  const s = { memories: [], entities: [hub, entity('other')], associations: {}, relations: Array.from({ length: 1800 }, (_, i) => ({ id: 'r' + i, source: 'hub', target: 'other', relation_type: 'knows', properties: {}, created_at: time })) }
  const p = planMigration(s)
  assert.ok(p.batches.length > 1)
  assert.ok(p.batches.every(b => b.tokens <= 5000 && b.tokens === countMessages(b.messages)))
  const edges = p.batches.flatMap(b => b.groups).filter(g => g.startsWith('relation:'))
  assert.equal(edges.length, 1800); assert.equal(new Set(edges).size, 1800)
  assert.ok(p.batches.flatMap(b => b.messages).filter(m => m.content.includes('旧关系')).every(m => !m.content.includes('"observations"')))
})

test('greedy batching and oversized indivisible note preserve all source text', () => {
  const content = '完整原文😀'.repeat(4000)
  const p = planMigration({ memories: [memory('small'), memory('large', content), memory('last')], entities: [], relations: [], associations: {} })
  assert.equal(p.batches.length, 3)
  assert.ok(p.batches[1].tokens > 5000)
  assert.ok(p.batches[1].messages[0].content.includes(content))
  assert.deepEqual(p.batches[1].groups, ['memory:large'])
  assert.throws(() => planMigration({ ...snapshot(), entities: [entity('hub')] }), /missing endpoint/)
})

test('journal lookup is read-only, durable terminal receipts survive missing upstream tasks', async t => {
  const dir = root(t); let added = 0, committed = 0, reads = 0
  const client = { scope: 'scope', addMessages: async () => added++, commit: async () => { committed++; return { task_id: 't', archive_uri: 'viking://archive' } },
    task: async () => ({ status: 'completed' }), read: async () => { reads++; return JSON.stringify({ ending_message_id: 'last' }) } }
  const body = { episode: { sessionId: 'old', messages: [{ id: 'one', role: 'user', content: 'fact', createdAt: time }] } }
  const j = new IngestJournal(client, dir)
  assert.equal((await j.lookup(body)).status, 'not_found'); assert.equal(added, 0)
  const receipt = await j.ingest(body)
  assert.equal((await j.lookup(body)).status, 'completed')
  client.task = async () => { throw Object.assign(new Error('missing'), { upstreamStatus: 404 }) }
  assert.equal((await new IngestJournal(client, dir).lookup(body)).status, 'completed')
  assert.equal(reads, 0); assert.equal(added, 1); assert.equal(committed, 1)
  const recordFile = path.join(dir, 'openviking-adapter/ingests', receipt.ingestId + '.json')
  const record = JSON.parse(fs.readFileSync(recordFile)); delete record.terminal; writeJson(recordFile, record)
  assert.equal((await j.lookup(body)).status, 'completed'); assert.equal(reads, 1)
})

test('unconfirmed journal writes report failed without replaying the same attempt; pre-write state is retryable', async t => {
  const dir = root(t)
  const client = { scope: 'scope', addMessages: async () => { throw new Error('lost response') } }
  const j = new IngestJournal(client, dir)
  const body = { episode: { messages: [{ role: 'user', content: 'fact' }] } }
  await assert.rejects(j.ingest(body), /lost response/)
  const receipt = await j.lookup(body)
  assert.equal(receipt.status, 'failed')
  assert.match(receipt.error, /lost response/)
  await assert.rejects(j.ingest(body), e => e.code === 'ingest_failed')
  const file = path.join(j.dir, receipt.ingestId + '.json')
  const record = JSON.parse(fs.readFileSync(file)); record.phase = 'new'; writeJson(file, record)
  assert.equal((await j.lookup(body)).status, 'retryable')
})

const waitFor = async condition => { const end = Date.now() + 3000; while (!condition()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 5)) } }
test('new installations without an old database report zero without creating one', t => {
  const dir = root(t)
  const svc = new LegacyMigration({ dataDir: dir, client: { scope: 'scope' }, journal: {} })
  assert.equal(svc.status().pendingCount, 0)
  assert.equal(svc.status().sourceAvailable, false)
  assert.equal(fs.existsSync(path.join(dir, 'graph.db')), false)
  assert.equal(fs.existsSync(svc.file), false)
  svc.stop()
})
test('manual-only start, accepted is pending, restart resumes exactly one submission, completion persists', async t => {
  const dir = root(t), sourceFile = sourceDb(dir)
  let submissions = 0, completed = false
  const receipts = new Map()
  const journal = { async lookup(body) { const key = JSON.stringify(body); return receipts.has(key) ? { ingestId: key, taskId: 't', status: completed ? 'completed' : 'running' } : { status: 'not_found' } },
    async ingest(body) { submissions++; receipts.set(JSON.stringify(body), true); return { ingestId: JSON.stringify(body), taskId: 't', status: 'accepted' } } }
  const client = { scope: 'scope', ready: async () => true, migrationReady: async () => true }
  let svc = new LegacyMigration({ dataDir: dir, sourceFile, client, journal, pollMs: 20 })
  t.after(() => svc.stop())
  const total = svc.status().pendingCount; assert.ok(total > 0)
  assert.equal(fs.existsSync(svc.file), false); assert.equal(submissions, 0)
  await svc.start(); await waitFor(() => submissions === 1)
  assert.equal(svc.status().pendingCount, total)
  svc.stop()
  completed = true
  svc = new LegacyMigration({ dataDir: dir, sourceFile, client, journal, pollMs: 20 })
  await waitFor(() => svc.status().pendingCount === 0)
  assert.equal(submissions, 1)
  assert.equal(fs.statSync(svc.file).mode & 0o777, 0o600)
  await svc.start(); await waitFor(() => !svc.status().running)
  assert.equal(submissions, 1)
  svc.stop()
  const restored = new LegacyMigration({ dataDir: dir, sourceFile, client, journal })
  assert.equal(restored.status().pendingCount, 0); restored.stop()
})

test('corruption and scope changes fail closed without resubmission', async t => {
  const dir = root(t), sourceFile = sourceDb(dir)
  const client = { scope: 'scope', ready: async () => true, migrationReady: async () => true }
  const journal = { lookup: async () => ({ status: 'failed' }) }
  const svc = new LegacyMigration({ dataDir: dir, sourceFile, client, journal })
  await svc.start(); svc.stop()
  const s = JSON.parse(fs.readFileSync(svc.file))
  fs.writeFileSync(path.join(svc.dir, 'batches', s.batches[0].id + '.json'), '{}')
  const bad = new LegacyMigration({ dataDir: dir, sourceFile, client, journal })
  assert.throws(() => bad.status(), /damaged/); await assert.rejects(bad.start(), /damaged/); bad.stop()
  const other = new LegacyMigration({ dataDir: dir, sourceFile, client: { ...client, scope: 'other' }, journal })
  assert.throws(() => other.status(), /different OpenViking scope/); other.stop()
})

function seededMigration(dir, middleStatus = 'pending') {
  const plan = planMigration({ memories: [memory('first'), memory('problem'), memory('last')],
    entities: [], relations: [], associations: {} }, { maxTokens: 1 })
  const batches = plan.batches.map((b, index) => {
    const body = { episode: { sessionId: 'legacy-' + b.id, messages: b.messages } }
    writeJson(path.join(dir, 'legacy-migration/batches', b.id + '.json'), body)
    return { id: b.id, checksum: hash(JSON.stringify(body)), groups: b.groups, claims: b.claims,
      tokens: b.tokens, status: index === 1 ? middleStatus : 'pending',
      ...(index === 1 && middleStatus !== 'pending' ? { error: 'previous failure', taskId: 'old-task' } : {}) }
  })
  writeJson(path.join(dir, 'legacy-migration/state.json'), {
    version: 1, scope: hash('scope'), batches, resources: plan.resources, started: true,
  })
  return batches
}

test('lost write responses use three bounded retries and later manual starts add one attempt', async t => {
  const dir = root(t), batches = seededMigration(dir), writes = []
  const client = { scope: 'scope', ready: async () => true, migrationReady: async () => true,
    addMessages: async (_session, messages) => {
      const payload = JSON.parse(messages[0].content.slice(messages[0].content.indexOf('{')))
      const index = batches.findIndex(b => b.groups[0] === `memory:${payload.entry.id}`)
      writes.push(index)
      if (index === 1) throw new Error('connection lost after write')
    },
    commit: async () => ({ task_id: 'task' }), task: async () => ({ status: 'completed' }) }
  const svc = new LegacyMigration({ dataDir: dir, client, journal: new IngestJournal(client, dir),
    autoResume: false, pollMs: 5, retryDelaysMs: [0, 0, 0] })
  t.after(() => svc.stop())
  await svc.run(); await waitFor(() => !svc.state.started)
  assert.deepEqual(writes, [0, 1, 2, 1, 1, 1])
  assert.deepEqual(svc.state.batches.map(b => b.status), ['completed', 'failed', 'completed'])
  assert.equal(svc.status().automaticRetryCount, 3)
  assert.equal(Object.hasOwn(svc.status(), 'uncertainBatches'), false)
  assert.equal(svc.status().pendingCount, 1)
  const issues = JSON.parse(fs.readFileSync(svc.issuesFile))
  assert.equal(issues.batches[0].status, 'failed')
  assert.equal(issues.history.length, 3)
  assert.match(issues.batches[0].error, /batch_started/)
  assert.match(issues.batches[0].error, /connection lost after write/)
  assert.equal((await svc.start()).retriedBatches, 1)
  await waitFor(() => !svc.state.started)
  assert.deepEqual(writes, [0, 1, 2, 1, 1, 1, 1])
  assert.equal(svc.status().automaticRetryCount, 3)
})

test('cancelled outcomes still pause without processing later batches', async t => {
  const dir = root(t), batches = seededMigration(dir), visited = []
  const svc = new LegacyMigration({ dataDir: dir, autoResume: false,
    client: { scope: 'scope', ready: async () => true, migrationReady: async () => true },
    journal: { lookup: async body => {
      const index = batches.findIndex(b => body.episode.sessionId === 'legacy-' + b.id)
      visited.push(index)
      return { status: index === 1 ? 'cancelled' : 'completed' }
    }, ingest: async () => assert.fail('must not resubmit') } })
  t.after(() => svc.stop())
  await svc.run()
  assert.deepEqual(visited, [0, 1])
  assert.equal(svc.state.started, false)
  assert.equal(svc.status().pendingCount, 2)
  assert.match(svc.status().lastError.message, /cancelled/)
  assert.equal(fs.existsSync(path.join(dir, 'legacy-migration/issues.json')), false)
})

// Exercise retries through the real durable ingest journal: copying a request
// without a fresh session identity would just return its cached failed task.
function retryFixture(t, outcome, overrides = {}) {
  const dir = root(t), batches = seededMigration(dir)
  const originalFiles = batches.map(b => fs.readFileSync(path.join(dir, 'legacy-migration/batches', b.id + '.json'), 'utf8'))
  fs.writeFileSync(path.join(dir, 'graph.db'), 'frozen legacy database')
  const sessions = new Map(), tasks = new Map(), commits = [], counts = new Map()
  const client = { scope: 'scope', ready: async () => true, migrationReady: async () => true,
    async addMessages(session, messages) {
      assert.ok(session.startsWith('vm-legacy-'), 'retain migration-only routing')
      assert.ok(!sessions.has(session), 'must not write the same evidence twice to a session')
      sessions.set(session, messages)
    },
    async commit(session) {
      const messages = sessions.get(session)
      const name = JSON.parse(messages[0].content.slice(messages[0].content.indexOf('{'))).entry.id
      const attempt = counts.get(name) || 0; counts.set(name, attempt + 1)
      const id = 'task-' + commits.length
      const task = { id, session, messages, name, attempt }; commits.push(task); tasks.set(id, task)
      return { task_id: id, archive_uri: `viking://sessions/${session}/archive_001` }
    },
    async task(id) {
      const result = outcome(tasks.get(id))
      return typeof result === 'string' ? { status: result, error: 'model connection error' } : result
    },
  }
  const journal = new IngestJournal(client, dir)
  const options = { dataDir: dir, client, journal, pollMs: 5, autoResume: false, retryDelaysMs: [0, 0, 0], ...overrides }
  const svc = new LegacyMigration(options); t.after(() => svc.stop())
  return { dir, batches, originalFiles, sessions, commits, counts, client, journal, options, svc }
}

test('automatic retry uses a new durable identity once, preserves evidence and resolves original resources', async t => {
  const f = retryFixture(t, task => task.name === 'problem' && task.attempt === 0 ? 'failed' : 'completed')
  await f.svc.run(); await waitFor(() => !f.svc.state.started)
  assert.deepEqual(f.svc.state.batches.map(b => b.status), ['completed', 'completed', 'completed'])
  assert.equal(f.svc.status().pendingCount, 0)
  assert.equal(f.svc.state.automaticRetryDone, true)
  assert.equal(f.svc.state.phase, 'automatic-retry')
  assert.equal(f.counts.get('first'), 1); assert.equal(f.counts.get('last'), 1); assert.equal(f.counts.get('problem'), 2)
  assert.deepEqual(f.commits.map(x => x.name), ['first', 'problem', 'last', 'problem'])
  const [original, retried] = f.commits.filter(x => x.name === 'problem')
  assert.notEqual(original.session, retried.session)
  assert.deepEqual(original.messages, retried.messages, 'keep text, source IDs and historical timestamps')
  const b = f.svc.state.batches[1]
  assert.equal(b.attempt, 1); assert.equal(b.attempts[0].taskId, original.id)
  assert.equal(b.attempts[0].status, 'failed'); assert.equal(b.taskId, retried.id)
  const issues = JSON.parse(fs.readFileSync(f.svc.issuesFile))
  assert.deepEqual(issues.batches, []); assert.equal(issues.history.length, 1)
  assert.equal(issues.history[0].error, 'model connection error')
  assert.equal((await f.journal.lookup(JSON.parse(f.originalFiles[1]))).status, 'failed')
  assert.equal((await f.journal.lookup(f.svc.body(b))).status, 'completed')
  assert.equal(fs.readFileSync(path.join(f.dir, 'graph.db'), 'utf8'), 'frozen legacy database')
  assert.deepEqual(f.batches.map(b => fs.readFileSync(path.join(f.dir, 'legacy-migration/batches', b.id + '.json'), 'utf8')), f.originalFiles)
  assert.equal((await f.svc.start()).reason, 'complete')
})

test('automatic retries stop after three rounds; each later manual start adds only one round', async t => {
  const f = retryFixture(t, task => task.name === 'problem' ? 'failed' : 'completed')
  await f.svc.run(); await waitFor(() => !f.svc.state.started)
  assert.equal(f.counts.get('problem'), 4)
  assert.equal(f.svc.status().automaticRetryCount, 3)
  assert.equal(f.svc.status().failedBatches, 1)
  assert.equal(f.svc.status().pendingCount, 1)
  await f.svc.run(); assert.equal(f.counts.get('problem'), 4)
  const started = await f.svc.start()
  assert.equal(started.phase, 'manual-retry'); assert.equal(started.retriedBatches, 1)
  await waitFor(() => !f.svc.state.started)
  assert.equal(f.counts.get('problem'), 5)
  assert.equal(f.counts.get('first'), 1); assert.equal(f.counts.get('last'), 1)
  assert.equal(f.svc.state.batches[1].attempts.length, 4)
  const issues = JSON.parse(fs.readFileSync(f.svc.issuesFile))
  assert.deepEqual(issues.history.map(x => x.attempt), [0, 1, 2, 3]); assert.equal(issues.batches[0].attempt, 4)
  assert.equal(fs.statSync(f.svc.issuesFile).mode & 0o777, 0o600)
})

test('restarting during an automatic retry resumes its exact submission without another retry round', async t => {
  let finishRetry = false
  const f = retryFixture(t, task => task.name !== 'problem' ? 'completed' : task.attempt === 0 ? 'failed' : finishRetry ? 'completed' : 'running')
  await f.svc.run(); await waitFor(() => f.counts.get('problem') === 2)
  f.svc.stop()
  const state = JSON.parse(fs.readFileSync(f.svc.file))
  assert.equal(state.phase, 'automatic-retry'); assert.equal(state.automaticRetryCount, 1); assert.equal(state.automaticRetryDone, false)
  const retryBody = f.svc.body(state.batches[1])
  finishRetry = true
  const resumed = new LegacyMigration({ ...f.options, autoResume: true }); t.after(() => resumed.stop())
  await waitFor(() => !resumed.state.started)
  assert.equal(resumed.status().pendingCount, 0)
  assert.equal(f.counts.get('problem'), 2)
  assert.deepEqual(resumed.body(resumed.state.batches[1]), retryBody)
})

test('completed old-version migrations can manually retry failures without replaying completed batches', async t => {
  const f = retryFixture(t, () => 'completed')
  f.svc.state.started = false
  f.svc.state.batches.forEach((b, i) => { b.status = i === 1 ? 'failed' : 'completed' })
  Object.assign(f.svc.state.batches[1], { taskId: 'old-task', ingestId: 'old-ingest', error: 'old failure' })
  f.svc.save()
  const resumed = new LegacyMigration(f.options); t.after(() => resumed.stop())
  assert.equal(f.commits.length, 0)
  const result = await resumed.start(); assert.equal(result.phase, 'manual-retry')
  await waitFor(() => !resumed.state.started)
  assert.equal(f.commits.length, 1); assert.equal(f.commits[0].name, 'problem')
  assert.equal(resumed.status().pendingCount, 0)
  assert.equal(resumed.state.batches[1].attempts[0].taskId, 'old-task')
})

test('concurrent start calls and clicks between polls do not create extra attempts', async t => {
  let finish = false
  const f = retryFixture(t, () => finish ? 'completed' : 'running')
  f.svc.state.started = false
  let release
  f.client.ready = () => new Promise(resolve => { release = resolve })
  const first = f.svc.start()
  assert.equal(f.svc.status().running, true)
  assert.equal((await f.svc.start()).reason, 'busy')
  f.client.ready = async () => true; release(true)
  assert.equal((await first).started, true)
  await waitFor(() => f.commits.length === 1)
  assert.equal((await f.svc.start()).reason, 'busy')
  finish = true
  await waitFor(() => !f.svc.state.started)
  assert.equal(f.commits.length, 3)
})

test('corrupt retry evidence fails closed without resubmitting', async t => {
  const f = retryFixture(t, task => task.name !== 'problem' ? 'completed' : task.attempt === 0 ? 'failed' : 'running')
  await f.svc.run(); await waitFor(() => f.counts.get('problem') === 2)
  f.svc.stop()
  const b = f.svc.state.batches[1]
  const file = path.join(f.svc.dir, 'retries', b.id, b.attempt + '.json')
  fs.writeFileSync(file, '{}')
  const resumed = new LegacyMigration(f.options); t.after(() => resumed.stop())
  assert.throws(() => resumed.status(), /retry.*damaged/)
  await assert.rejects(resumed.start(), /retry.*damaged/)
  assert.equal(f.counts.get('problem'), 2)
})

test('interrupted retry planning resumes the same next attempt without losing the automatic round', async t => {
  const f = retryFixture(t, task => task.name === 'problem' && task.attempt === 0 ? 'failed' : 'completed')
  const save = f.svc.save.bind(f.svc)
  f.svc.save = () => {
    if (f.svc.state.phase === 'automatic-retry') throw new Error('simulated crash before retry state commit')
    save()
  }
  await f.svc.run(); await waitFor(() => f.svc.loadError)
  f.svc.stop()
  const persisted = JSON.parse(fs.readFileSync(f.svc.file))
  assert.notEqual(persisted.automaticRetryDone, true)
  assert.equal(persisted.batches[1].status, 'failed')
  assert.equal(f.counts.get('problem'), 1)
  const resumed = new LegacyMigration({ ...f.options, autoResume: true }); t.after(() => resumed.stop())
  await waitFor(() => !resumed.state.started)
  assert.equal(resumed.status().pendingCount, 0)
  assert.equal(f.counts.get('problem'), 2)
  assert.equal(resumed.state.batches[1].attempt, 1)
  assert.equal(resumed.state.batches[1].attempts.length, 1)
})

test('deployment starts migration automatically after readiness, but never replays a completed run', async t => {
  const dir = root(t), sourceFile = sourceDb(dir)
  let ready = false, submissions = 0
  const receipts = new Set()
  const journal = {
    lookup: async body => receipts.has(JSON.stringify(body)) ? { status:'completed', task:{} } : { status:'not_found' },
    ingest: async body => { submissions++; receipts.add(JSON.stringify(body)); return { status:'completed', task:{} } },
  }
  const client = { scope:'auto', ready:async()=>ready, migrationReady:async()=>true }
  let svc = new LegacyMigration({ dataDir:dir, sourceFile, client, journal, autoResume:false, pollMs:5 })
  svc.resume({autoStart:true})
  await new Promise(r=>setTimeout(r,20))
  assert.equal(submissions,0)
  ready = true
  await waitFor(()=>svc.state && !svc.status().running && svc.status().pendingCount===0)
  const count=submissions
  assert.ok(count>0); assert.equal(svc.status().completedBatches,svc.status().totalBatches)
  svc.stop()
  svc = new LegacyMigration({ dataDir:dir, sourceFile, client, journal, autoResume:false, pollMs:5 })
  t.after(()=>svc.stop())
  svc.resume({autoStart:true})
  await new Promise(r=>setTimeout(r,20))
  assert.equal(submissions,count)
})

test('automatic startup without a legacy source creates no migration or database', async t => {
  const dir=root(t)
  const svc=new LegacyMigration({dataDir:dir,client:{scope:'empty'},journal:{},autoResume:false,pollMs:5})
  t.after(()=>svc.stop())
  svc.resume({autoStart:true})
  await new Promise(r=>setTimeout(r,15))
  assert.equal(svc.state,null)
  assert.equal(svc.status().sourceAvailable,false)
  assert.equal(fs.existsSync(svc.file),false)
})

test('retry backoff is 10/30/60 seconds, persists across restart, and cannot be bypassed by clicks', async t => {
  let now = 1000000
  const f = retryFixture(t, task => task.name === 'problem' ? 'failed' : 'completed',
    { retryDelaysMs: undefined, now: () => now })
  await f.svc.run()
  for (const [index, delay] of [10000, 30000, 60000].entries()) {
    await waitFor(() => !!f.svc.state.nextRetryAt)
    assert.equal(f.svc.state.nextRetryAt, now + delay)
    assert.equal(f.svc.status().automaticRetryCount, index)
    assert.equal(f.counts.get('problem'), index + 1)
    assert.equal((await f.svc.start()).reason, 'busy')
    f.svc.stop()
    const resumed = new LegacyMigration(f.options)
    t.after(() => resumed.stop())
    f.svc = resumed
    now += delay - 1
    await resumed.run()
    assert.equal(f.counts.get('problem'), index + 1, 'must not submit before the durable deadline')
    assert.equal(resumed.state.nextRetryAt, now + 1)
    now++
    await resumed.run()
  }
  await waitFor(() => !f.svc.state.started)
  assert.equal(f.counts.get('problem'), 4)
  assert.equal(f.svc.status().automaticRetryCount, 3)
  assert.equal(f.svc.status().nextRetryAt, null)
  assert.equal(f.svc.status().automaticRetryDone, true)
  assert.equal(f.counts.get('first'), 1)
  assert.equal(f.counts.get('last'), 1)
})

test('definite authentication and request errors skip automatic retries but can be retried manually after a fix', async t => {
  for (const error of [
    { status_code: 400, message: 'invalid model parameter' },
    { status: 401, message: 'credentials rejected' },
    { code: 'permission_denied' },
    'Error code: 403 - forbidden',
    'HTTP 422 invalid request body',
    'AuthenticationError: invalid key',
  ]) {
    let fixed = false
    const f = retryFixture(t, task => task.name === 'problem' && !fixed ? { status: 'failed', error } : 'completed')
    await f.svc.run()
    await waitFor(() => !f.svc.state.started)
    assert.equal(f.counts.get('problem'), 1)
    assert.equal(f.svc.state.batches[1].retryable, false)
    assert.equal(f.svc.status().automaticRetryCount, 0)
    assert.equal(f.svc.status().failedBatches, 1)
    fixed = true
    assert.equal((await f.svc.start()).retriedBatches, 1)
    await waitFor(() => !f.svc.state.started)
    assert.equal(f.counts.get('problem'), 2)
    assert.equal(f.svc.status().pendingCount, 0)
  }
})

test('non-retryable upstream polling errors pause without replaying an accepted task', async t => {
  let blocked = true
  const f = retryFixture(t, () => 'completed')
  const task = f.client.task
  f.client.task = async id => {
    if (blocked) throw Object.assign(new Error('HTTP 401 Unauthorized'), { upstreamStatus: 401 })
    return task(id)
  }
  await f.svc.run()
  await waitFor(() => !f.svc.state.started)
  assert.equal(f.commits.length, 1)
  assert.equal(f.svc.loadError, undefined)
  f.svc.stop()
  const resumed = new LegacyMigration(f.options)
  t.after(() => resumed.stop())
  resumed.resume({ autoStart: true })
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(f.commits.length, 1)
  blocked = false
  await resumed.start()
  await waitFor(() => !resumed.state.started)
  assert.equal(f.commits.length, 3)
  assert.equal(resumed.status().pendingCount, 0)
})

test('upgrading a stopped old retry round never starts new automatic attempts', async t => {
  const f = retryFixture(t, task => task.name === 'problem' ? 'failed' : 'completed')
  f.svc.state.started = false
  f.svc.state.phase = 'automatic-retry'
  f.svc.state.automaticRetryDone = true
  f.svc.state.batches.forEach((batch, index) => { batch.status = index === 1 ? 'failed' : 'completed' })
  f.svc.save()
  const resumed = new LegacyMigration({ ...f.options, autoResume: true })
  t.after(() => resumed.stop())
  resumed.resume({ autoStart: true })
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(f.commits.length, 0)
  assert.equal(resumed.status().running, false)
  assert.equal(resumed.status().automaticRetryCount, 1)
  assert.equal((await resumed.start()).retriedBatches, 1)
  await waitFor(() => !resumed.state.started)
  assert.equal(f.commits.length, 1, 'manual click adds exactly one attempt')
})

test('missing native task results share the failure retry budget and manual retries never open another automatic round', async t => {
  const f = retryFixture(t, task => {
    if (task.name !== 'problem') return 'completed'
    if (task.attempt % 2) throw Object.assign(new Error('missing task'), { upstreamStatus: 404 })
    return 'failed'
  })
  f.client.read = async () => { throw Object.assign(new Error('missing archive marker'), { upstreamStatus: 404 }) }
  await f.svc.run(); await waitFor(() => !f.svc.state.started)
  assert.equal(f.counts.get('problem'), 4)
  assert.equal(f.svc.status().automaticRetryCount, 3)
  assert.equal(f.svc.state.batches[1].status, 'failed')
  assert.match(f.svc.state.batches[1].error, /Native task missing/)
  await f.svc.start(); await waitFor(() => !f.svc.state.started)
  assert.equal(f.counts.get('problem'), 5)
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(f.counts.get('problem'), 5)
  assert.equal(f.counts.get('first'), 1); assert.equal(f.counts.get('last'), 1)
})

test('missing task with no archive is a durable failure and duplicate status checks do not resubmit', async t => {
  const dir = root(t); let writes = 0, commits = 0, polls = 0
  const client = { scope: 'scope', addMessages: async () => writes++, commit: async () => {
    commits++; return { task_id: 'missing', archive_uri: 'viking://sessions/history/archive_001' }
  }, task: async () => { polls++; throw Object.assign(new Error('missing'), { upstreamStatus: 404 }) },
  read: async () => { throw Object.assign(new Error('missing'), { upstreamStatus: 404 }) } }
  const body = { episode: { sessionId: 'daily', messages: [{ role: 'user', content: 'fact' }] } }
  const journal = new IngestJournal(client, dir)
  await journal.ingest(body)
  assert.equal((await journal.lookup(body)).status, 'failed')
  assert.equal((await new IngestJournal(client, dir).lookup(body)).status, 'failed')
  assert.equal(writes, 1); assert.equal(commits, 1); assert.equal(polls, 1)
})

test('lost commit responses retry in fresh sessions and can succeed without rewriting completed batches', async t => {
  const f = retryFixture(t, () => 'completed')
  const commit = f.client.commit
  f.client.commit = async session => {
    const result = await commit(session)
    const task = f.commits.at(-1)
    if (task.name === 'problem' && task.attempt === 0) throw new Error('connection lost after task creation')
    return result
  }
  await f.svc.run(); await waitFor(() => !f.svc.state.started)
  assert.equal(f.svc.status().pendingCount, 0)
  assert.equal(f.counts.get('problem'), 2)
  assert.equal(f.counts.get('first'), 1); assert.equal(f.counts.get('last'), 1)
  const previous = f.svc.state.batches[1].attempts[0]
  assert.equal(previous.status, 'failed')
  assert.match(previous.error, /commit_started/)
  assert.match(previous.error, /connection lost after task creation/)
  const attempts = f.commits.filter(task => task.name === 'problem')
  assert.notEqual(attempts[0].session, attempts[1].session)
  assert.deepEqual(attempts[0].messages, attempts[1].messages)
})
