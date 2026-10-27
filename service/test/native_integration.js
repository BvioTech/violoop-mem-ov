// Real bundled Python/native engine; deterministic local model responses.
// All state lives in a newly-created temp directory. No Device, cloud or BGE server is contacted.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { createHash } = require('crypto')
const serviceRoot = process.env.VIOLOOP_TEST_SERVICE_ROOT || path.join(__dirname, '..')
const { start } = require(path.join(serviceRoot, 'server'))
const { loadConfig } = require(path.join(serviceRoot, 'config'))
const { linkedLegacyDatabase } = require('./fixtures/legacy')
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const wait = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, timeout = 90000) {
  const end = Date.now() + timeout
  let error
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value } catch (e) { error = e }
    await wait(250)
  }
  throw error || new Error('Timed out waiting for native engine')
}
async function port() {
  const p = http.createServer()
  await new Promise(r => p.listen(0, '127.0.0.1', r))
  const n = p.address().port
  await new Promise(r => p.close(r))
  return n
}
function request(socket, method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, path: route, method, agent: false,
      headers: { 'content-type': 'application/json' } }, res => {
      let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => {
        try {
          const value = JSON.parse(raw)
          if (res.statusCode >= 400) reject(new Error(`${route}: ${res.statusCode} ${raw}`))
          else resolve(value)
        } catch (e) { reject(e) }
      })
    })
    req.setTimeout(30000, () => req.destroy(new Error('HTTP timeout')))
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
test('managed native engine: auto migration, actual files/links, CRUD, retrieval, durable restart and source preservation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-ov-native-'))
  let service
  let extractionCalls = 0; let migrationEmbeddings = 0
  const model = http.createServer(async (req, res) => {
    if (req.url.endsWith('/ready')) { res.end('{"ready":true}'); return }
    let raw = ''; for await (const c of req) raw += c
    const body = JSON.parse(raw)
    if (req.url === '/internal/memory/embeddings') {
      assert.equal(req.headers.authorization, 'Bearer ' + fs.readFileSync(path.join(dir, 'run/model-gateway.key'), 'utf8'))
      assert.equal(body.model, 'bge-m3')
      migrationEmbeddings++
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ index: 0, embedding: Array.from(await embedder.embedQuery(body.input)) }] }))
      return
    }
    const isExtraction = body.messages.some(m => typeof m.content === 'string' && m.content.includes('restricted Python memory SDK'))
    let content = '# Test memories\nLocal integration fixture.'
    if (isExtraction) {
      extractionCalls++
      const n = extractionCalls
      content = `a = sdk.create_entities(category="projects", name="alpha${n}", content="""# alpha${n}\nProject connected to beta${n}.\n## Facts\n- A local fixture.""")\nb = sdk.create_entities(category="projects", name="beta${n}", content="""# beta${n}\nA second local project.\n## Facts\n- A local fixture.""")\na.link(b, link_type="related_to", match_text="beta${n}")\nsdk.commit()`
    }
    const message = { role: 'assistant', content }
    const output = { id: 'fixture', object: 'chat.completion', model: 'local-test', choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: ' + JSON.stringify({ ...output, choices: [{ index: 0, delta: message, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ ...output, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
    } else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(output)) }
  })
  await new Promise(r => model.listen(0, '127.0.0.1', r))
  t.after(async () => {
    if (service) await service.shutdown()
    model.closeAllConnections(); await new Promise(r => model.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const file = linkedLegacyDatabase(path.join(dir, 'graph.db')), before = digest(file)
  const socket = path.join(dir, 'mem.sock')
  const config = loadConfig(['--socket', socket, '--data-dir', dir], {
    OPENVIKING_URL: `http://127.0.0.1:${await port()}`,
    OPENVIKING_DEVICE_MODEL_URL: `http://127.0.0.1:${model.address().port}/internal/memory/chat/completions`,
    OPENVIKING_RUNTIME_DIR: path.join(dir, 'run'),
    ...(process.env.VIOLOOP_TEST_PYTHON ? { OPENVIKING_PYTHON: process.env.VIOLOOP_TEST_PYTHON } : {}),
    ...(process.env.VIOLOOP_TEST_PYTHONPATH ? { OPENVIKING_PYTHONPATH: process.env.VIOLOOP_TEST_PYTHONPATH } : {}),
  })
  // Deterministic normalized embeddings exercise the real C++ vector store.
  const embedder = { status: () => ({ state: 'ready', dim: 1024 }), async embedQuery(text) {
    const v = new Float32Array(1024)
    for (const c of String(text)) v[c.codePointAt(0) % v.length]++
    const norm = Math.sqrt(v.reduce((s, n) => s + n*n, 0)) || 1
    return v.map(n => n / norm)
  } }
  const req = (method, route, body) => request(socket, method, route, body)
  service = await start(config, { runtimeOptions: { embedder } })
  await until(async () => (await req('GET', '/readyz')).ready)
  await until(async () => {
    const state = await req('GET', '/v2/migration/status')
    if (state.failedBatches || state.uncertainBatches) throw new Error(JSON.stringify(state))
    return state.pendingCount === 0 && extractionCalls > 0
  })
  assert.equal(digest(file), before)
  assert.ok(migrationEmbeddings > 0, 'migration vectors must go through the Device endpoint')
  let graph = await until(async () => {
    const g = await req('GET', '/v2/graph/export?view=memory')
    return g.entities.length >= 2 && g.relations.length >= 1 && g
  })
  assert.ok(graph.entities.every(e => !/identity|soul/.test(e.id)))
  const added = await req('POST', '/v1/memory-entries', { memoryType: 'entities', category: 'projects', name: 'manual', content: '# Manual\nA searchable local integration record.' })
  const uri = added.uri
  assert.ok(uri.endsWith('/entities/projects/manual.md'))
  const read = await req('GET', '/v1/memory-entries/' + encodeURIComponent(uri))
  assert.match(read.content, /searchable/)
  await req('PATCH', '/v1/memory-entries/' + encodeURIComponent(uri), { content: '# Manual\nUpdated local integration record.', expectedContent: read.content })
  await until(async () => (await req('GET', '/v2/graph/export?view=memory')).entities.some(e => e.id === uri))
  const hits = await req('POST', '/v1/grep', { pattern: 'Updated', prefix: 'viking://user/default/memories' })
  assert.ok(JSON.stringify(hits).includes('manual.md'))
  await req('POST', '/v1/search', { query: 'local integration project', mode: 'recall', limit: 5 })
  await req('POST', '/v2/recall', { text: 'local integration project memory' })
  await req('DELETE', '/v1/memories/' + encodeURIComponent(uri))
  await until(async () => !(await req('GET', '/v2/graph/export?view=memory')).entities.some(e => e.id === uri))
  const callsBefore = extractionCalls
  await service.shutdown(); service = null
  service = await start(config, { runtimeOptions: { embedder } })
  await until(async () => (await req('GET', '/readyz')).ready)
  assert.equal((await req('GET', '/v2/migration/status')).pendingCount, 0)
  await wait(1000)
  assert.equal(extractionCalls, callsBefore, 'completed migration must not replay on restart')
  assert.equal(digest(file), before, 'old graph.db must remain byte-identical')
  const generated = JSON.stringify(await req('GET', '/v1/memories?prefix=' + encodeURIComponent('viking://user/default/memories')))
  assert.doesNotMatch(generated, /identity.md|soul.md/)
})
