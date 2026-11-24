const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const {once} = require('node:events')
const Database = require('better-sqlite3')
const {createLegacyDatabase, linkedLegacyDatabase} = require('./fixtures/legacy')
const {LegacyMigration} = require('../legacy_migration')
const {createApp} = require('../openviking_adapter')
const {readLegacySnapshot, legacyFacts, hash} = require('../legacy_source')

async function serve(t, app) {
  const server = http.createServer(app)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.close(); await app.close() })
  const base = 'http://127.0.0.1:' + server.address().port
  return (method, route, body) => fetch(base + route, {method,
    headers: {'content-type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})})
}

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-handoff-'))
  const sourceFile = linkedLegacyDatabase(path.join(dataDir, 'old.db'))
  const receipts = new Map(), bodies = [], projectFiles = new Map()
  let resets = 0
  const client = {scope: 'handoff', user: 'test', ready: async () => true, migrationReady: async () => true,
    async stat(uri) { if (!projectFiles.has(uri)) throw Object.assign(new Error('missing'), {upstreamStatus: 404}) },
    async writeMemory(uri, content, options) {
      assert.equal(options.wait, true)
      projectFiles.set(uri, {content: content.split('\n\n<!-- MEMORY_FIELDS')[0], tags: options.tags})
      return {vector_status: 'complete'}
    },
    resetMigrationMemory: async () => { resets++; receipts.clear(); projectFiles.clear() }}
  const journal = {lookup: async body => receipts.get(JSON.stringify(body)) || {status: 'not_found'},
    ingest: async body => { bodies.push(body); const receipt = {status: 'completed', ingestId: 'i', taskId: 't'}; receipts.set(JSON.stringify(body), receipt); return receipt }}
  const service = new LegacyMigration({dataDir, sourceFile, client, journal, coexistence: true, pollMs: 100000, autoResume: false})
  t.after(() => { service.stop(); fs.rmSync(dataDir, {recursive: true, force: true}) })
  await service.start(); clearTimeout(service.timer); await service.run(); clearTimeout(service.timer)
  const edit = sql => { const db = new Database(sourceFile); try { db.exec(sql) } finally { db.close() } }
  const catchUp = async () => { await service.checkSource(); clearTimeout(service.timer); await service.run(); clearTimeout(service.timer) }
  return {dataDir, sourceFile, service, client, journal, bodies, projectFiles, edit, catchUp, resets: () => resets}
}

test('accepted/pending/failed batches cannot activate, even if pendingCount is zero', async t => {
  const f = await fixture(t)
  assert.equal(f.service.status().readyForCutover, true)
  const b = f.service.state.batches[0]
  for (const status of ['pending', 'submitted', 'failed', 'cancelled']) {
    b.status = status
    await assert.rejects(f.service.activate(f.service.state.sourceRevision), {status: 409})
  }
})
test('new facts arriving while legacy is active are caught up before activation', async t => {
  const f = await fixture(t)
  const revision = f.service.status().sourceRevision
  f.edit("INSERT INTO memories (id,key,content,created_at,updated_at) VALUES ('new','new','new fact','2023-05-07','2023-05-07')")
  assert.equal(f.service.status().readyForCutover, false)
  await assert.rejects(f.service.activate(revision), {status: 409})
  await f.catchUp()
  assert.equal(f.resets(), 0)
  assert.ok(f.bodies.some(body => JSON.stringify(body).includes('new fact')))
  assert.equal(f.service.status().readyForCutover, true)
  const activated = await f.service.activate(f.service.status().sourceRevision)
  assert.equal(activated.activated, true)
  f.edit("INSERT INTO memories (id,key,content,created_at,updated_at) VALUES ('later','later','old daemon after handoff','2023-05-07','2023-05-07')")
  await f.service.checkSource()
  assert.equal(f.service.status().activated, true)
  assert.equal(f.resets(), 0)
  const restored = new LegacyMigration({dataDir: f.dataDir, sourceFile: f.sourceFile, client: f.client, journal: f.journal, coexistence: true, autoResume: false})
  t.after(() => restored.stop())
  assert.equal(restored.status().activated, true)
})
test('edits and deletions rebuild only the unactivated staging memory and use new ingestion identities', async t => {
  const f = await fixture(t)
  const firstSession = f.bodies[0].episode.sessionId
  f.edit("UPDATE memories SET content='corrected fact' WHERE key='a'")
  await f.catchUp()
  assert.equal(f.resets(), 1)
  assert.notEqual(f.bodies.at(-1).episode.sessionId, firstSession)
  assert.equal(f.service.status().readyForCutover, true)
  f.edit("DELETE FROM memories WHERE key='a'")
  await f.catchUp()
  assert.equal(f.resets(), 2)
  assert.equal(f.service.status().readyForCutover, true)
  assert.ok(!JSON.stringify(f.bodies.at(-1)).includes('corrected fact'))
})
test('added, edited and deleted legacy project memories are reflected in staging before cutover', async t => {
  const f = await fixture(t)
  const key = 'projects.prj_verify_01.release-flow'
  const uri = 'viking://user/test/memories/entities/prj_verify_01/release-flow.md'
  const tags = ['project_id=prj_verify_01']
  f.edit(`INSERT INTO memories (id,key,content,created_at,updated_at) VALUES ('project','${key}','initial','2023-05-07','2023-05-07')`)
  await f.catchUp()
  assert.equal(f.resets(), 0)
  assert.deepEqual(f.projectFiles.get(uri), {content: 'initial', tags})

  const oldRevision = f.service.status().sourceRevision
  f.edit(`UPDATE memories SET content='edited' WHERE key='${key}'`)
  await assert.rejects(f.service.activate(oldRevision), {status: 409})
  await f.catchUp()
  assert.equal(f.resets(), 1)
  assert.deepEqual(f.projectFiles.get(uri), {content: 'edited', tags})

  f.edit("INSERT INTO memories (id,key,content,created_at,updated_at) VALUES ('new','projects.prj_verify_01.Release-Flow','collision','2023-05-07','2023-05-07')")
  await f.catchUp()
  assert.equal(f.resets(), 2)
  assert.equal(f.projectFiles.size, 2)
  assert.deepEqual(f.projectFiles.get(uri), {content: 'collision', tags})
  assert.deepEqual([...f.projectFiles.values()].find(item => item.content === 'edited'), {content: 'edited', tags})

  f.edit("DELETE FROM memories WHERE id='new'")
  await f.catchUp()
  assert.equal(f.resets(), 3)
  assert.equal((await f.service.activate(f.service.status().sourceRevision)).activated, true)
  assert.deepEqual([...f.projectFiles], [[uri, {content: 'edited', tags}]])
  assert.doesNotMatch(JSON.stringify(f.bodies), /projects\.prj_verify_01/)
})
test('a pre-fix coexistence checkpoint can rebuild project notes before activation', async t => {
  const f = await fixture(t)
  const legacyKey = 'projects.prj_verify_01.release-flow'
  f.edit(`UPDATE memories SET key='${legacyKey}' WHERE id='a'`)
  const state = JSON.parse(fs.readFileSync(f.service.file))
  const snapshot = readLegacySnapshot(f.sourceFile)
  const [m] = snapshot.memories
  const projectFact = hash(JSON.stringify(['memory', [m.id, m.key, m.title, m.content, m.type, m.tags]]))
  state.sourceFacts = [...legacyFacts({...snapshot, memories: []}), projectFact].sort()
  state.sourceRevision = hash(JSON.stringify(state.sourceFacts))
  delete state.projectMemories
  fs.writeFileSync(f.service.file, JSON.stringify(state))
  f.service.stop()
  const restored = new LegacyMigration({dataDir: f.dataDir, sourceFile: f.sourceFile, client: f.client,
    journal: f.journal, coexistence: true, autoResume: false})
  t.after(() => restored.stop())
  assert.equal(restored.status().readyForCutover, false)
  await restored.checkSource()
  await restored.run()
  assert.equal(f.resets(), 1)
  assert.equal(restored.status().readyForCutover, true)
  assert.deepEqual([...f.projectFiles.values()], [{content: 'original note', tags: ['project_id=prj_verify_01']}])
})
test('project-only cutover exposes tagged previews, invalidates the catalogue and supports panel edits', {timeout: 5000}, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-project-cutover-'))
  const projectId = 'prj_verify_01', tag = 'project_id=' + projectId
  const original = '# Release flow\nRun the verified checks.'
  createLegacyDatabase(path.join(dataDir, 'graph.db'), {memories: [{id: 'project', key: `projects.${projectId}.release-flow`, content: original}]})
  const writing = Promise.withResolvers(), indexing = Promise.withResolvers()
  const files = new Map()
  const client = {scope: 'project-cutover', user: 'test', ready: async () => true, migrationReady: async () => true,
    async stat(uri) {
      if (!files.has(uri)) throw Object.assign(new Error('missing'), {upstreamStatus: 404})
      return {isDir: false}
    },
    async attrs(uri) { return {attrs: {tags: files.get(uri).tags}} },
    async listFiles() { return {result: [...files.keys()].map(uri => ({uri, isDir: false}))} },
    async read(uri) { return files.get(uri).content },
    async writeMemory(uri, payload, options) {
      const current = files.get(uri)
      if (!current) {
        assert.equal(options.wait, true)
        writing.resolve()
        await indexing.promise
      }
      files.set(uri, {content: payload.split('\n\n<!-- MEMORY_FIELDS')[0], tags: options.tags ?? current.tags})
      return {vector_status: 'complete'}
    },
    async retrieve(query, options) {
      assert.equal(query, '')
      assert.equal(options.targetUri, 'viking://~/memories')
      assert.equal(options.level, 2)
      const memories = [...files].filter(([, entry]) => entry.tags.includes(options.tags[0]))
        .map(([uri, entry]) => ({uri, abstract: entry.content, score: 1}))
      return {memories, skills: [], resources: []}
    },
  }
  const call = await serve(t, createApp(client, {dataDir, coexistence: true}))
  t.after(() => { indexing.resolve(); fs.rmSync(dataDir, {recursive: true, force: true}) })
  const req = async (method, route, body) => {
    const response = await call(method, route, body)
    const result = await response.json()
    assert.ok(response.ok, JSON.stringify(result))
    return result
  }
  assert.equal((await req('POST', '/v2/migration/start', {})).started, true)
  await writing.promise
  assert.deepEqual((await req('GET', '/v1/memory-entries')).items, [])
  const pending = await req('GET', '/v2/migration/status')
  assert.equal(pending.totalBatches, 0)
  assert.equal(pending.pendingCount, 1)
  assert.equal(pending.readyForCutover, false)
  indexing.resolve()
  const deadline = Date.now() + 3000
  let status
  do {
    assert.ok(Date.now() < deadline, 'project migration did not become ready for cutover')
    await new Promise(resolve => setTimeout(resolve, 5))
    status = await req('GET', '/v2/migration/status')
    assert.equal(status.lastError, null)
  } while (!status.readyForCutover)
  const [entry] = (await req('GET', '/v1/memory-entries')).items
  assert.ok(entry.uri.endsWith('/entities/prj_verify_01/release-flow.md'))
  assert.equal((await req('POST', '/v2/migration/activate', {sourceRevision: status.sourceRevision})).activated, true)
  const list = '/v1/project-memories/list'
  const [item] = (await req('POST', list, {projectId})).items
  assert.equal(item.uri, entry.uri)
  assert.equal(Object.hasOwn(item, 'abstract'), false)
  assert.deepEqual((await req('POST', list, {projectId, includePreview: true})).items, [{...item, abstract: original}])
  assert.deepEqual((await req('POST', list, {projectId: 'other', includePreview: true})).items, [])
  const route = '/v1/memory-entries/' + encodeURIComponent(item.uri)
  const {content} = await req('GET', route)
  assert.equal(content, original)
  await req('PATCH', route, {expectedContent: content, content: 'Updated from the project page', tags: ['topic=release']})
  assert.equal((await req('GET', route)).content, 'Updated from the project page')
  assert.ok(files.get(item.uri).tags.includes(tag))
})
test('access/embedding bookkeeping does not invalidate the source revision', async t => {
  const f = await fixture(t)
  const before = legacyFacts(readLegacySnapshot(f.sourceFile))
  f.edit("UPDATE memories SET updated_at='2026-11-04'; UPDATE entities SET last_accessed_at='2026-11-04', dirty=0")
  assert.deepEqual(legacyFacts(readLegacySnapshot(f.sourceFile)), before)
  assert.equal(f.service.status().readyForCutover, true)
})
test('coexistence fences every native write route until migration is activated; non-coexistence installs are unaffected', async t => {
  async function boot(coexistence) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-fence-'))
    const client = {scope: 'fence', user: 'test', writeMemory: async () => ({vector_status: 'queued'})}
    const app = createApp(client, {dataDir, coexistence})
    const call = await serve(t, app)
    t.after(() => fs.rmSync(dataDir, {recursive: true, force: true}))
    return {call}
  }
  const fenced = await boot(true)
  for (const [method, route, body] of [
    ['POST', '/v1/memory-entries', {memoryType: 'profile', content: 'hello'}],
    ['POST', '/v1/memories', {key: 'viking://user/test/memories/profile.md', content: 'hello'}],
    ['POST', '/v2/ingest', {episode: {messages: [{role: 'user', content: 'hi'}]}}],
  ]) {
    const res = await fenced.call(method, route, body)
    assert.equal(res.status, 409)
    assert.equal((await res.json()).error.code, 'migration_pending')
  }
  assert.equal((await fenced.call('GET', '/v2/migration/status')).status, 200, 'reads are never fenced')
  const plain = await boot(false)
  const created = await plain.call('POST', '/v1/memory-entries', {memoryType: 'profile', content: 'hello'})
  assert.equal(created.status, 201, 'non-coexistence installs accept native writes immediately')
})
test('a rebuild failure leaves legacy authoritative and can resume after a restart', async t => {
  const f = await fixture(t)
  f.edit("DELETE FROM memories WHERE key='a'")
  const reset = f.client.resetMigrationMemory
  f.client.resetMigrationMemory = async () => { throw new Error('engine unavailable') }
  await f.service.checkSource(); clearTimeout(f.service.timer)
  assert.equal(f.service.status().readyForCutover, false)
  assert.equal(f.service.state.resetPending, true)
  f.client.resetMigrationMemory = reset
  await f.catchUp()
  assert.equal(f.service.state.resetPending, false)
  assert.equal(f.service.status().readyForCutover, true)
})
