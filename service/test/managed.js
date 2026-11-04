const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const net = require('net')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { spawn } = require('child_process')
const { once } = require('events')
const { startModelGateway } = require('../model_gateway')
const { startRuntime, nativeConfig } = require('../openviking_runtime')

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })

test('source and relocated runtimes discover adjacent models while preserving explicit and environment overrides', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vm-model-path-')))
  const previous = process.env.QMD_MODELS_DIR
  t.after(() => {
    if (previous === undefined) delete process.env.QMD_MODELS_DIR
    else process.env.QMD_MODELS_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(root, 'service'))
  fs.copyFileSync(path.join(__dirname, '../embedder.js'), path.join(root, 'service/embedder.js'))
  const { Embedder } = require(path.join(root, 'service/embedder.js'))
  const local = path.join(root, 'models/bge-m3-q8_0.gguf')
  const envModel = path.join(root, 'override/bge-m3-q8_0.gguf')
  const explicit = path.join(root, 'explicit.gguf')
  for (const file of [local, envModel, explicit]) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'model fixture')
  }
  delete process.env.QMD_MODELS_DIR
  assert.equal(new Embedder().resolveModelPath(), local)
  process.env.QMD_MODELS_DIR = path.join(root, 'missing')
  assert.equal(new Embedder().resolveModelPath(), local)
  process.env.QMD_MODELS_DIR = path.dirname(envModel)
  assert.equal(new Embedder().resolveModelPath(), envModel)
  assert.equal(new Embedder({ modelPath: explicit }).resolveModelPath(), explicit)
})

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

for (const cleanupFails of [false, true]) {
  test(`shutdown drains both listeners with unfinished requests${cleanupFails ? ' even if cleanup fails' : ''}`, { timeout: 8000 }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vm-stop-connections-')))
    const probe = http.createServer(); await listen(probe)
    const port = probe.address().port; await close(probe)
    const socket = process.platform === 'win32' ? `\\\\.\\pipe\\memov-stop-${process.pid}-${Date.now()}` : path.join(root, 'mem.sock')
    const adapter = require('../openviking_adapter')
    const createApp = adapter.createApp
    const cleanupError = new Error('fixture cleanup failed')
    if (cleanupFails) adapter.createApp = (...args) => {
      const app = createApp(...args), closeApp = app.close
      app.close = async () => { await closeApp(); throw cleanupError }
      return app
    }
    let service
    try {
      service = await require('../server').start({
        backend: 'openviking', dataDir: root, socket, httpPort: port, httpHost: '127.0.0.1',
        openviking: { mode: 'external', url: 'http://127.0.0.1:1' },
      })
    } finally { adapter.createApp = createApp }
    const clients = []
    let closedCount = 0
    const servers = [service.socketServer, service.httpServer]
    const closed = Promise.all(servers.map(server => once(server, 'close').then(() => { closedCount++ })))
    t.after(async () => {
      for (const client of clients) client.destroy()
      for (const server of servers) server.closeAllConnections()
      await service.shutdown().catch(() => {})
      await closed
      fs.rmSync(root, { recursive: true, force: true })
    })
    for (const [index, address] of [socket, { host: '127.0.0.1', port }].entries()) {
      const requested = once(servers[index], 'request')
      const client = net.createConnection(address)
      clients.push(client)
      client.on('error', () => {}) // Forced closure may reset the unfinished request.
      await once(client, 'connect')
      client.write('POST /v1/grep HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"query":"')
      await requested
    }
    const started = Date.now()
    const shutdown = service.shutdown()
    assert.equal(service.shutdown(), shutdown, 'repeated shutdown reuses the pending drain')
    if (cleanupFails) await assert.rejects(shutdown, error => error === cleanupError)
    else await shutdown
    assert.equal(closedCount, 2, 'shutdown must wait for both server close callbacks')
    assert.ok(Date.now() - started < 5000, 'held requests are force-closed within the shutdown grace period')
  })
}

test('repeated shutdown signals wait for native cleanup instead of abandoning the child',
  { skip: process.platform === 'win32' }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vm-stop-signals-')))
  const marker = path.join(root, 'native-stopped')
  const probe = http.createServer(); await listen(probe)
  const port = probe.address().port; await close(probe)
  const source = `
    const fs=require('fs'),path=require('path'),{EventEmitter}=require('events');
    const {start}=require(${JSON.stringify(path.resolve(__dirname, '../server'))});
    const {loadConfig}=require(${JSON.stringify(path.resolve(__dirname, '../config'))});
    (async()=>{
      const config=loadConfig(['--socket',${JSON.stringify(path.join(root, 'mem.sock'))},'--data-dir',${JSON.stringify(root)}],{
        OPENVIKING_URL:'http://127.0.0.1:${port}',OPENVIKING_RUNTIME_DIR:${JSON.stringify(path.join(root, 'run'))}
      });
      const service=await start(config,{runtimeOptions:{embedder:{status:()=>({state:'ready',dim:1024})},spawnProcess:()=>{
        const child=new EventEmitter();child.pid=1234;child.kill=()=>{child.emit('exit',0,null);return true};return child;
      }}});
      const stop=service.runtime.stop;
      service.runtime.stop=async()=>{process.stdout.write('stopping\\n');await new Promise(r=>setTimeout(r,200));await stop();fs.writeFileSync(${JSON.stringify(marker)},'done');};
      process.stdout.write('ready\\n');
    })().catch(e=>{console.error(e);process.exitCode=1});
  `
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); fs.rmSync(root, { recursive: true, force: true }) })
  const exited = once(child, 'exit')
  let output = ''; let stderr = ''
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { stderr += data })
  const untilOutput = async text => {
    const deadline = Date.now() + 5000
    while (!output.includes(text) && child.exitCode === null && !child.signalCode && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(output.includes(text), output + stderr)
  }
  await untilOutput('ready\n')
  child.kill('SIGTERM')
  await untilOutput('stopping\n')
  child.kill('SIGINT')
  assert.deepEqual(await exited, [0, null], stderr)
  assert.equal(fs.readFileSync(marker, 'utf8'), 'done')
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

test('portable simulator config resolves a relocated interpreter and engine before source or system paths', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-portable-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const mem = path.join(root, 'mem')
  const python = path.join(root, 'runtime/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
  for (const file of [python, path.join(mem, 'service/config.js'), path.join(mem, 'openviking-python/openviking/server/bootstrap.py')]) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '')
  }
  fs.copyFileSync(path.join(__dirname, '../config.js'), path.join(mem, 'service/config.js'))
  const { loadConfig } = require(path.join(mem, 'service/config.js'))
  const config = loadConfig([], {})
  assert.equal(config.openviking.python, python)
  assert.equal(config.openviking.pythonPath, path.join(mem, 'openviking-python'))
  const explicit = loadConfig([], { OPENVIKING_PYTHON: 'explicit-python', OPENVIKING_PYTHONPATH: 'explicit-engine' })
  assert.equal(explicit.openviking.python, 'explicit-python')
  assert.equal(explicit.openviking.pythonPath, 'explicit-engine')
})
