const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Readable } = require('stream')
const { OpenVikingGraph, parseMemory } = require('../openviking_graph')
const { createApp, IngestJournal } = require('../openviking_adapter')

const root = 'viking://user/test/memories'
const a = root + '/entities/a.md', b = root + '/events/b.md'
const file = (content, fields = {}) => content + '\n\n<!-- MEMORY_FIELDS\n' + JSON.stringify(fields) + '\n-->'
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-graph-'))
  // Not a SQLite DB: trying to reuse it would fail, and its bytes must not change.
  fs.writeFileSync(path.join(dir, 'graph.db'), 'legacy database must remain untouched')
  const files = new Map()
  const reads = []
  let failListing = false
  let listingCalls = 0
  const client = {
    user: 'test', scope: 'test-account/user/test',
    async listFiles(uri, { offset }) {
      listingCalls++
      if (failListing) throw new Error('native offline')
      const prefix = uri.replace('viking://~', 'viking://user/test') + '/'
      const items = new Map()
      for (const [id, value] of files) {
        if (!id.startsWith(prefix)) continue
        const tail = id.slice(prefix.length)
        const slash = tail.indexOf('/')
        if (slash !== -1) {
          const uri = prefix + tail.slice(0, slash)
          items.set(uri, { uri, isDir: true })
        } else items.set(id, { uri: id, isDir: false, modTime: value.stamp, size: value.text.length })
      }
      const rows = [...items.values()]
      return { result: rows.slice(offset, offset + 1), has_more: offset + 1 < rows.length }
    },
    async readRaw(uri) { reads.push(uri); if (!files.has(uri)) throw Object.assign(new Error('missing'), { upstreamStatus: 404 }); return files.get(uri).text },
  }
  const graph = new OpenVikingGraph(client, { dataDir: dir, intervalMs: 0, auditMs: Number.MAX_SAFE_INTEGER })
  t.after(async () => { await graph.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { dir, client, graph, files, reads, listingCalls: () => listingCalls, offline(value) { failListing = value } }
}

test('parse native memory fields; plain files use path type/name; metadata is not body', () => {
  const parsed = parseMemory(file('正文', { name: '甲', memory_type: 'entities', links: [{ to_uri: b }] }), a)
  assert.equal(parsed.name, '甲'); assert.equal(parsed.content, '正文'); assert.equal(parsed.links.length, 1)
  assert.equal(parseMemory('plain', b).type, 'events')
  assert.throws(() => parseMemory('x<!-- MEMORY_FIELDS {broken} -->', a))
})

test('separate persistent DB, URI identity, scope, no sidecars, and actual link metadata', async t => {
  const f = fixture(t)
  f.files.set(a, { stamp: '1', text: file('甲的正文', { name: '同名', memory_type: 'entities', links: [
    { to_uri: b, link_type: 'related_to', weight: .6, description: '关联说明' },
    { to_uri: b, link_type: 'related_to', weight: .2 },
    { to_uri: 'viking://user/other/memories/x.md' },
  ] }) })
  f.files.set(b, { stamp: '1', text: file('乙的正文', { name: '同名', memory_type: 'events', backlinks: [{ from_uri: a }] }) })
  f.files.set(root + '/.overview.md', { stamp: '1', text: 'not a memory' })
  f.files.set(root + '/.hidden/x.md', { stamp: '1', text: 'not a memory' })
  const out = await f.graph.export()
  assert.equal(out.stats.memoryCount, 2); assert.equal(out.relations.length, 1)
  assert.notEqual(out.entities[0].id, out.entities[1].id)
  assert.equal(out.relations[0].weight, .6); assert.equal(out.relations[0].description, '关联说明')
  assert.equal(out.readOnly, true); assert.equal(out.entities[0].content, undefined)
  assert.ok(out.entities.every(node => !Object.hasOwn(node, 'aliases')))
  assert.equal(Object.hasOwn(await f.graph.detail(a), 'aliases'), false)
  assert.equal((await f.graph.detail(a)).content, '甲的正文')
  assert.ok(fs.existsSync(path.join(f.dir, 'openviking-graph.db')))
  assert.equal(fs.readFileSync(path.join(f.dir, 'graph.db'), 'utf8'), 'legacy database must remain untouched')
  const other = new OpenVikingGraph({ ...f.client, scope: 'different-account', user: 'other',
    async listFiles() { return { result: [] } } }, { dataDir: f.dir })
  assert.equal((await other.export()).entities.length, 0)
  await other.close()
})

test('incremental add/update/delete; unchanged reads no bodies, links-only edits and disappearing endpoints reconcile', async t => {
  const f = fixture(t)
  f.files.set(a, { stamp: '1', text: file('a', { links: [{ to_uri: b }] }) })
  const first = await f.graph.export()
  assert.equal(first.relations.length, 0)
  f.reads.length = 0
  assert.equal((await f.graph.export({ revision: first.revision })).unchanged, true)
  assert.deepEqual(f.reads, [])
  f.files.set(b, { stamp: '1', text: file('b') })
  await f.graph.completion('add-b', [b])
  const second = await f.graph.export()
  assert.equal(second.relations.length, 1); assert.deepEqual(f.reads, [b])
  f.reads.length = 0
  f.files.set(a, { stamp: '2', text: file('a', { links: [] }) })
  await f.graph.completion('unlink-a', [a])
  assert.equal((await f.graph.export()).relations.length, 0); assert.deepEqual(f.reads, [a])
  f.files.delete(b)
  await f.graph.completion('delete-b', [b])
  const third = await f.graph.export()
  assert.equal(third.entities.length, 1); assert.notEqual(third.revision, second.revision)
  f.files.delete(a)
  await f.graph.completion('delete-a', [a])
  assert.equal((await f.graph.export()).entities.length, 0)
})

test('queued completion is atomic and retries without rescanning; duplicate receipts are idempotent', async t => {
  const f = fixture(t)
  f.files.set(a, { stamp: '1', text: file('before') })
  const first = await f.graph.export(), listingCount = f.listingCalls()
  f.offline(true) // Metadata listing is no longer used after initialization.
  f.files.set(a, { stamp: '1', text: '<!-- MEMORY_FIELDS broken -->' })
  await f.graph.completion('update-a', [a])
  const failed = await f.graph.export()
  assert.equal(failed.revision, first.revision); assert.ok(failed.syncError)
  f.files.set(a, { stamp: '1', text: file('after') })
  const recovered = await f.graph.export()
  assert.equal(recovered.syncError, null)
  assert.equal((await f.graph.detail(a)).content, 'after')
  assert.equal(f.listingCalls(), listingCount)
  f.reads.length = 0
  await f.graph.completion('update-a', [a])
  assert.deepEqual(f.reads, [])
})

test('failed initial sync does not silently return an empty successful graph', async t => {
  const f = fixture(t); f.offline(true)
  await assert.rejects(f.graph.export(), /offline/)
})

test('restart replays durable pending completions without a directory scan', async t => {
  const f = fixture(t)
  f.files.set(a, { stamp: '1', text: 'one' })
  await f.graph.export()
  f.files.set(a, { stamp: '1', text: '<!-- MEMORY_FIELDS broken -->' })
  await f.graph.completion('pending', [a])
  await f.graph.close()
  const listingCount = f.listingCalls()
  const graph = new OpenVikingGraph(f.client, { dataDir: f.dir })
  f.files.set(a, { stamp: '1', text: 'two' })
  f.offline(true)
  assert.equal((await graph.detail(a)).content, 'two')
  assert.equal(f.listingCalls(), listingCount)
  await graph.close()
})

test('scope escape and incomplete pagination do not remove a previously indexed graph', async t => {
  const f = fixture(t); f.files.set(a, { stamp: '1', text: 'safe' })
  await f.graph.export()
  f.client.listFiles = async () => ({ result: [{ uri: 'viking://user/other/memories/x.md' }] })
  await f.graph.sync(true)
  const stale = await f.graph.export()
  assert.equal(stale.entities.length, 1); assert.match(stale.syncError, /scope/)
  f.client.listFiles = async () => ({ result: [], has_more: true })
  await f.graph.sync(true)
  assert.match((await f.graph.export()).syncError, /pagination/)
})

test('adapter graph view is explicit and read-only; ordinary graph callers stay empty', async t => {
  const f = fixture(t)
  f.files.set(a, { stamp: '1', text: 'hello' })
  const app = createApp(f.client, { dataDir: f.dir })
  t.after(() => app.close())
  const request = async (method, url, body) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    req.method = method; req.url = url
    let status, text
    await app(req, { writeHead(code) { status = code }, end(data) { text = data } })
    return { status, body: JSON.parse(text) }
  }
  assert.deepEqual((await request('GET', '/v2/graph/export')).body.entities, [])
  const initial = await request('GET', '/v2/graph/export?view=memory&skeleton=1')
  assert.equal(initial.status, 200); assert.equal(initial.body.entities.length, 1)
  assert.equal((await request('GET', '/v2/graph/details?view=memory&id=' + encodeURIComponent(a))).body.content, 'hello')
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    assert.equal((await request(method, '/v2/entities/' + encodeURIComponent(a), {})).status, 501)
  }
  const conditional = await request('GET', '/v2/graph/export?view=memory&revision=' + encodeURIComponent(initial.body.revision))
  assert.equal(conditional.body.unchanged, true); assert.equal(conditional.body.entities, undefined)
  f.files.set(b, { stamp: '2', text: file('new event', { memory_type: 'events' }) })
  const manual = await request('POST', '/v2/graph/sync?view=memory', {})
  assert.equal(manual.status, 202); assert.equal(manual.body.started, true)
  const refreshed = await request('GET', '/v2/graph/export?view=memory')
  assert.equal(refreshed.body.entities.length, 2)
})

test('manual graph sync reads persisted links, reports busy and never invokes extraction', async t => {
  const f = fixture(t)
  f.files.set(a, { stamp: '1', text: file('a', { memory_type: 'entities' }) })
  f.files.set(b, { stamp: '1', text: file('b', { memory_type: 'events' }) })
  await f.graph.export()
  f.files.set(a, { stamp: '2', text: file('a', { memory_type: 'entities', links: [{ to_uri: b, link_type: 'related_to' }] }) })
  const originalRead = f.client.readRaw
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const reading = new Promise(resolve => { entered = resolve })
  f.client.readRaw = async uri => { entered(); await gate; return originalRead(uri) }
  for (const name of ['addMessages', 'commit', 'retrieve']) f.client[name] = () => { throw new Error('must not call model/extraction APIs') }
  assert.deepEqual(f.graph.startSync(), { started: true })
  await reading
  assert.deepEqual(f.graph.startSync(), { started: false, reason: 'busy' })
  assert.equal((await f.graph.status()).running, true)
  release()
  await f.graph.manualSync
  assert.equal((await f.graph.status()).running, false)
  assert.equal((await f.graph.export()).relations.length, 1)
})

test('accepted extraction does not update the graph; completion applies only reported files', async t => {
  const f = fixture(t)
  f.files.set(a, { stamp: '1', text: 'old' })
  let taskStatus = 'running'
  Object.assign(f.client, {
    async addMessages() {},
    async commit() { return { task_id: 'task-1', archive_uri: 'viking://user/test/sessions/s/archive_1' } },
    async task() { return { status: taskStatus, result: { memory_diff_uri: 'viking://user/test/sessions/s/archive_1/memory_diff.json' } } },
    async read() { return JSON.stringify({ changed_uris: [a, b] }) },
  })
  const app = createApp(f.client, { dataDir: f.dir })
  t.after(() => app.close())
  async function request(method, url, body) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    req.method = method; req.url = url
    let status, data
    await app(req, { writeHead(s) { status = s }, end(d) { data = JSON.parse(d) } })
    assert.equal(status < 300, true, JSON.stringify(data))
    return data
  }
  const baseline = await request('GET', '/v2/graph/export?view=memory')
  const calls = f.listingCalls()
  const receipt = await request('POST', '/v2/ingest', { episode: { messages: [{ role: 'user', content: 'test input' }] } })
  assert.equal(receipt.status, 'accepted')
  f.files.set(a, { stamp: '1', text: file('old', { links: [{ to_uri: b }] }) })
  f.files.set(b, { stamp: '1', text: 'new' })
  assert.equal((await request('GET', '/v2/graph/status?view=memory')).revision, baseline.revision)
  taskStatus = 'completed'
  f.reads.length = 0
  assert.equal((await request('GET', '/v2/ingests/' + receipt.ingestId)).status, 'completed')
  const graph = await request('GET', '/v2/graph/export?view=memory')
  assert.equal(graph.entities.length, 2); assert.equal(graph.relations.length, 1)
  assert.notEqual(graph.revision, baseline.revision)
  assert.deepEqual(f.reads.sort(), [a, b].sort())
  assert.equal(f.listingCalls(), calls)
  f.reads.length = 0
  await request('GET', '/v2/ingests/' + receipt.ingestId)
  assert.deepEqual(f.reads, [])
})

test('completion monitoring resumes durable tasks and retries graph failures without resubmission', async t => {
  const f = fixture(t)
  let submits = 0, notifications = 0
  const client = { ...f.client,
    async addMessages() { submits++ },
    async commit() { return { task_id: 'durable-task', archive_uri: 'archive' } },
    async task() { return { status: 'completed', result: {} } },
  }
  const failing = new IngestJournal(client, f.dir, async () => { notifications++; throw new Error('index temporarily unavailable') })
  const receipt = await failing.ingest({ episode: { messages: [{ role: 'user', content: 'persisted' }] } })
  const status = await failing.status(receipt.ingestId)
  assert.equal(status.status, 'completed')
  assert.equal(failing.read(receipt.ingestId).graphPending, true)
  await failing.stop()
  let resolve
  const completed = new Promise(r => { resolve = r })
  const resumed = new IngestJournal(client, f.dir, async () => { notifications++; resolve() })
  t.after(() => resumed.stop())
  resumed.resume()
  await Promise.race([completed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('monitor did not resume')), 5000); timer.unref() })])
  await resumed.stop()
  assert.equal(submits, 1); assert.equal(notifications, 2)
  assert.equal(resumed.read(receipt.ingestId).graphProjected, true)
})
