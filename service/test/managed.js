const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { startModelGateway } = require('../model_gateway')
const { startRuntime, nativeConfig } = require('../openviking_runtime')

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
test('BGE bridge returns real float vectors, serializes requests and rejects bad auth/model/dimension', async t => {
  let active = 0; let peak = 0
  const embedder = { async embedQuery(text) {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5)); active--
    return text === 'unavailable' ? null : Float32Array.from({ length: 1024 }, (_, i) => i / 1024)
  } }
  const gateway = await startModelGateway({ embedder, token: 'secret', deviceUrl: 'http://127.0.0.1:9090/internal/memory/chat/completions' })
  t.after(() => close(gateway.server))
  const post = (body, token = 'secret') => fetch(gateway.url + '/embeddings', { method: 'POST',
    headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  assert.equal((await post({ model: 'bge-m3', input: 'x' }, 'wrong')).status, 403)
  assert.equal((await post({ model: 'other', input: 'x' })).status, 400)
  assert.equal((await post({ model: 'bge-m3', input: 'x', dimensions: 512 })).status, 400)
  const responses = await Promise.all([post({ model: 'bge-m3', input: ['a', 'b'] }), post({ model: 'bge-m3', input: 'c' })])
  for (const response of responses) {
    assert.equal(response.status, 200)
    assert.equal((await response.json()).data[0].embedding.length, 1024)
  }
  assert.equal(peak, 1)
  assert.equal((await post({ model: 'bge-m3', input: 'unavailable' })).status, 503)
})
test('LLM bridge preserves request, provider errors and response metadata', async t => {
  let body; let auth
  const upstream = http.createServer(async (req, res) => {
    auth = req.headers.authorization
    const chunks = []; for await (const c of req) chunks.push(c)
    body = JSON.parse(Buffer.concat(chunks))
    res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":{"message":"budget blocked"}}')
  })
  await listen(upstream); t.after(() => close(upstream))
  const gateway = await startModelGateway({ embedder: {}, token: 'key', deviceUrl: `http://127.0.0.1:${upstream.address().port}/internal/memory/chat/completions` })
  t.after(() => close(gateway.server))
  const original = { model: 'violoop-memory', messages: [{ role: 'user', content: '原始\n对话' }], max_tokens: 32768 }
  const response = await fetch(gateway.url + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer key' }, body: JSON.stringify(original) })
  assert.equal(response.status, 502); assert.deepEqual(body, original); assert.equal(auth, 'Bearer key')
  assert.equal((await response.json()).error.message, 'budget blocked')
})
test('managed lifecycle confines engine and gateway to loopback and terminates child on stop', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-managed-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pythonPath = path.join(root, 'python')
  fs.mkdirSync(path.join(pythonPath, 'openviking/server'), { recursive: true })
  fs.writeFileSync(path.join(pythonPath, 'openviking/server/bootstrap.py'), '')
  const templateDir = path.join(pythonPath, 'openviking/prompts/templates/memory')
  fs.mkdirSync(templateDir, { recursive: true })
  for (const type of ['identity', 'soul']) {
    fs.writeFileSync(path.join(templateDir, `${type}.yaml`),
      `memory_type: ${type}\nenabled: true\nfields:\n  - name: content\n    type: string\n`)
  }
  const probe = http.createServer(); await listen(probe)
  const port = probe.address().port; await close(probe)
  let modelReady = false; let embeddingReady = false
  const device = http.createServer((req, res) => {
    assert.ok(['/internal/memory/ready', '/internal/memory/embeddings/ready'].includes(req.url))
    assert.equal(req.headers.authorization, 'Bearer ' + fs.readFileSync(path.join(root, 'run/model-gateway.key'), 'utf8').trim())
    const ready = req.url === '/internal/memory/embeddings/ready' ? embeddingReady : modelReady
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ready }))
  })
  await listen(device); t.after(() => close(device))
  const config = { dataDir: root, embedding: {}, openviking: {
    pythonPath, python: '/usr/bin/python3', runtimeDir: path.join(root, 'run'), llmMaxTokens: 4096,
    url: `http://127.0.0.1:${port}`, deviceModelUrl: `http://127.0.0.1:${device.address().port}/internal/memory/chat/completions`,
  } }
  let child; let args; let options; let launches = 0
  const runtime = await startRuntime(config, { embedder: { status: () => ({ state: 'ready', dim: 1024 }) },
    spawnProcess(_exe, argv, opts) {
      args = argv; options = opts; child = new EventEmitter(); child.pid = 1234 + launches++
      child.kill = signal => { child.emit('exit', 0, signal); return true }
      return child
    } })
  assert.equal(runtime.status().pid, 1234)
  assert.equal(await runtime.modelReady(), false)
  modelReady = true
  assert.equal(await runtime.modelReady(), false)
  embeddingReady = true
  assert.equal(await runtime.modelReady(), true)
  assert.equal(args[1], 'openviking.server.bootstrap')
  assert.equal(options.env.PYTHONPATH, pythonPath)
  assert.equal(options.env.VIOLOOP_MIGRATION_TIMING_DIR, path.join(root, 'legacy-migration', 'timings'))
  const conf = JSON.parse(fs.readFileSync(args[3]))
  assert.equal(conf.server.host, '127.0.0.1'); assert.equal(conf.server.workers, 1)
  assert.equal(conf.server.root_api_key, runtime.engineKey)
  assert.equal(conf.server.auth_mode, 'trusted')
  assert.equal(conf.embedding.dense.encoding_format, 'float')
  assert.equal(conf.memory.custom_templates_dir, path.join(config.openviking.runtimeDir, 'memory-templates'))
  for (const type of ['identity', 'soul']) {
    const original = fs.readFileSync(path.join(templateDir, `${type}.yaml`), 'utf8')
    const override = path.join(conf.memory.custom_templates_dir, `${type}.yaml`)
    assert.match(original, /^enabled: true$/m)
    assert.equal(fs.readFileSync(override, 'utf8'), original.replace('enabled: true', 'enabled: false'))
    assert.equal(fs.statSync(override).mode & 0o777, 0o600)
  }
  assert.equal(fs.statSync(args[3]).mode & 0o777, 0o600)
  child.emit('exit', 1, null)
  assert.equal(runtime.status().pid, null)
  assert.equal(runtime.status().lastExit.code, 1)
  const deadline = Date.now() + 5000
  while (!runtime.status().pid && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(runtime.status().pid, 1235)
  await runtime.stop(); assert.equal(runtime.status().pid, null)
})
test('native config preserves workspace ownership and bounded workers', () => {
  const conf = nativeConfig({ dataDir: '/state', openviking: { url: 'http://127.0.0.1:1933', llmMaxTokens: 4096, runtimeDir: '/run/violoop-mem-ov' } }, 'http://127.0.0.1:1/v1', 'token', 'engine')
  assert.equal(conf.storage.workspace, '/state/openviking')
  assert.equal(conf.embedding.dense.dimension, 1024)
  assert.equal(conf.memory.link_enabled, true)
  assert.equal(conf.memory.custom_templates_dir, '/run/violoop-mem-ov/memory-templates')
  assert.equal(conf.queue_workers.session_commit.max_concurrent, 1)
})

test('only the native migration system instruction enables the migration model route', async t => {
  const requests = []
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    requests.push(JSON.parse(Buffer.concat(chunks)))
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}')
  })
  await listen(upstream); t.after(() => close(upstream))
  const gateway = await startModelGateway({ embedder: {}, token: 'key', deviceUrl: `http://127.0.0.1:${upstream.address().port}/internal/memory/chat/completions` })
  t.after(() => close(gateway.server))
  for (const role of ['user', 'system']) {
    const r = await fetch(gateway.url + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer key' },
      body: JSON.stringify({ model: 'violoop-memory', messages: [{ role, content: '[VIOLOOP_LEGACY_MIGRATION_V1]' }] }) })
    assert.equal(r.status, 200)
  }
  assert.equal(requests[0].violoop_legacy_migration, undefined)
  assert.equal(requests[1].violoop_legacy_migration, true)
})
