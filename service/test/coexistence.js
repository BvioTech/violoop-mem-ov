const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const {once} = require('node:events')
const Database = require('better-sqlite3')
const {linkedLegacyDatabase} = require('./fixtures/legacy')
const {LegacyMigration} = require('../legacy_migration')
const {createApp} = require('../openviking_adapter')
const {readLegacySnapshot, legacyFacts} = require('../legacy_source')

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-handoff-'))
  const sourceFile = linkedLegacyDatabase(path.join(dataDir, 'old.db'))
  const receipts = new Map(), bodies = []
  let resets = 0
  const client = {scope: 'handoff', ready: async () => true, migrationReady: async () => true,
    resetMigrationMemory: async () => { resets++; receipts.clear() }}
  const journal = {lookup: async body => receipts.get(JSON.stringify(body)) || {status: 'not_found'},
    ingest: async body => { bodies.push(body); const receipt = {status: 'completed', ingestId: 'i', taskId: 't'}; receipts.set(JSON.stringify(body), receipt); return receipt }}
  const service = new LegacyMigration({dataDir, sourceFile, client, journal, coexistence: true, pollMs: 100000, autoResume: false})
  t.after(() => { service.stop(); fs.rmSync(dataDir, {recursive: true, force: true}) })
  await service.start(); clearTimeout(service.timer); await service.run(); clearTimeout(service.timer)
  const edit = sql => { const db = new Database(sourceFile); try { db.exec(sql) } finally { db.close() } }
  const catchUp = async () => { await service.checkSource(); clearTimeout(service.timer); await service.run(); clearTimeout(service.timer) }
  return {dataDir, sourceFile, service, client, journal, bodies, edit, catchUp, resets: () => resets}
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
    const server = http.createServer(app)
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    t.after(async () => { server.close(); await app.close(); fs.rmSync(dataDir, {recursive: true, force: true}) })
    const base = 'http://127.0.0.1:' + server.address().port
    const call = (method, route, body) => fetch(base + route, {method,
      headers: {'content-type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})})
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
