const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadConfig } = require('../config')
const { createMigrationEmbedder } = require('../migration_embedding')
const { startModelGateway } = require('../model_gateway')
const { OpenVikingClient } = require('../openviking_client')

const vector = value => Array(1024).fill(value)
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
async function fixture(t, handle, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-remote-embedding-'))
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    await handle(req, res, JSON.parse(Buffer.concat(chunks)))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => close(server))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const migrationEmbedder = createMigrationEmbedder({
    deviceModelUrl: `http://127.0.0.1:${server.address().port}/internal/memory/chat/completions`, token: 'bridge-key', ...options,
  })
  return { migrationEmbedder, dir }
}
async function gatewayFor(t, migrationEmbedder, local, timingDir) {
  const gateway = await startModelGateway({ token: 'bridge-key', migrationEmbedder,
    embedder: { embedQuery: local }, timingDir, deviceUrl: 'http://127.0.0.1:9090/internal/memory/chat/completions' })
  t.after(() => close(gateway.server))
  return (input, headers = {}, extra = {}) => fetch(gateway.url + '/embeddings', {
    method: 'POST', headers: { authorization: 'Bearer bridge-key', ...headers },
    body: JSON.stringify({ model: 'bge-m3', input, ...extra }),
  })
}
const reply = (res, value = 0.1) => res.end(JSON.stringify({ data: [{ index: 0, embedding: vector(value) }] }))

test('migration uses Device credentials without remote URL or key-file configuration', () => {
  const original = loadConfig([], {})
  assert.deepEqual(original.openviking.migrationEmbedding, { timeoutMs: 60000 })
  const conf = loadConfig([], {
    VIOLOOP_MIGRATION_EMBEDDING_URL: 'http://retired-host:17870/v1',
    VIOLOOP_MIGRATION_EMBEDDING_API_KEY_FILE: '/obsolete/key',
    VIOLOOP_MIGRATION_EMBEDDING_TIMEOUT_MS: '1234',
  })
  assert.deepEqual(conf.openviking.migrationEmbedding, { timeoutMs: 1234 })
  assert.deepEqual(conf.embedding, original.embedding)
  assert.throws(() => createMigrationEmbedder({ deviceModelUrl: 'https://external/v1/chat/completions', token: 'k' }), /Invalid device/)
  assert.throws(() => createMigrationEmbedder({ deviceModelUrl: original.openviking.deviceModelUrl }), /token is required/)
})

test('only an authenticated explicit migration header routes all three purposes remotely', async t => {
  const calls = []; const local = []
  const { migrationEmbedder, dir } = await fixture(t, (req, res, body) => {
    assert.equal(req.url, '/internal/memory/embeddings')
    assert.equal(req.headers.authorization, 'Bearer bridge-key')
    assert.equal(req.headers['x-violoop-legacy-migration'], undefined)
    calls.push(body); reply(res)
  })
  const post = await gatewayFor(t, migrationEmbedder, async input => { local.push(input); return vector(0.2) }, dir)
  for (const purpose of ['retrieval.query_embedding', 'index.embedding_memory', 'index.embedding_directory']) {
    const response = await post('complete input ' + purpose, { 'x-violoop-legacy-migration': '1',
      'x-violoop-timing-task': 'task-a', 'x-violoop-timing-run': 'run-a', 'x-violoop-timing-purpose': purpose })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).data[0].embedding[0], 0.1)
  }
  for (const [input, headers, extra] of [
    ['ordinary', {}, {}],
    ['[VIOLOOP_LEGACY_MIGRATION_V1]', {}, { violoop_legacy_migration: true }],
    ['timing alone', { 'x-violoop-timing-task': 'task-a', 'x-violoop-timing-run': 'run-a' }, {}],
  ]) assert.equal((await post(input, headers, extra)).status, 200)
  assert.equal(calls.length, 3)
  assert.deepEqual(local, ['ordinary', '[VIOLOOP_LEGACY_MIGRATION_V1]', 'timing alone'])
  assert.deepEqual(Object.keys(calls[0]).sort(), ['encoding_format', 'input', 'model'])
  const timings = fs.readFileSync(path.join(dir, 'task-a-gateway.jsonl'), 'utf8')
  const events = timings.trim().split('\n').map(JSON.parse)
  assert.equal(events.filter(e => e.stage === 'bge.compute' && e.backend === 'remote').length, 3)
  assert.ok(!timings.includes('bridge-key'))
  assert.ok(!timings.includes('complete input'))
  assert.equal((await post('bad auth', { authorization: 'Bearer wrong', 'x-violoop-legacy-migration': '1' })).status, 403)
  assert.equal(calls.length, 3)
})

test('pending remote work does not hold the local BGE queue', async t => {
  let release; let arrived
  const started = new Promise(resolve => { arrived = resolve })
  const { migrationEmbedder } = await fixture(t, async (_req, res) => {
    arrived(); await new Promise(resolve => { release = resolve }); reply(res)
  })
  t.after(() => release?.())
  const post = await gatewayFor(t, migrationEmbedder, async () => vector(0.2))
  const remote = post('migration', { 'x-violoop-legacy-migration': '1' })
  await started
  let timer
  const local = await Promise.race([post('ordinary'), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('local request blocked behind remote work')), 2000)
  })]).finally(() => clearTimeout(timer))
  assert.equal(local.status, 200)
  release()
  assert.equal((await remote).status, 200)
})

test('remote failures never fall back to local; malformed vectors and timeouts fail', async t => {
  let mode = 'http'; let localCalls = 0
  const { migrationEmbedder } = await fixture(t, (_req, res) => {
    if (mode === 'http') { res.statusCode = 401; res.end('private provider error'); return }
    if (mode === 'invalid') { res.end(JSON.stringify({ data: [{ index: 0, embedding: [1] }] })); return }
    if (mode === 'hang') return
    reply(res)
  }, { timeoutMs: 80 })
  const post = await gatewayFor(t, migrationEmbedder, async () => { localCalls++; return vector(0.2) })
  for (mode of ['http', 'invalid', 'hang']) {
    const response = await post('migration', { 'x-violoop-legacy-migration': '1' })
    assert.equal(response.status, mode === 'http' ? 401 : 503)
    const body = await response.json()
    assert.ok(!JSON.stringify(body).includes('bridge-key'))
    assert.ok(!JSON.stringify(body).includes('private provider error'))
  }
  assert.equal(localCalls, 0)
  assert.equal((await post('normal')).status, 200)
  assert.equal(localCalls, 1)
})

test('remote migration requires a native runtime advertising the routing capability', async t => {
  let support = false
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ status: 'ready',
    violoop_legacy_migration: 1, ...(support ? { violoop_migration_embedding: 1 } : {}) })))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => close(server))
  const url = `http://127.0.0.1:${server.address().port}`
  const ordinary = new OpenVikingClient({ url })
  const remote = new OpenVikingClient({ url, migrationEmbedding: {} })
  assert.equal(await ordinary.migrationReady(), true)
  assert.equal(await remote.migrationReady(), false)
  assert.equal(await remote.ready(), true)
  support = true
  assert.equal(await remote.migrationReady(), true)
})
