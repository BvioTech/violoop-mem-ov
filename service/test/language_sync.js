const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { LanguageSync, resolveLanguage, normalizeLanguage, readLanguageState } = require('../language_sync')
const { OpenVikingClient } = require('../openviking_client')
const { nativeConfig } = require('../openviking_runtime')

const until = async fn => {
  const end = Date.now() + 4000
  while (!fn()) {
    assert.ok(Date.now() < end, 'condition timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-language-'))
  if (options.cached) fs.writeFileSync(path.join(dataDir, 'language-state.json'), JSON.stringify({ language: options.cached }))
  const streams = new Set()
  let snapshot = options.snapshot || { ui: 'system', resolved: 'en-US' }
  let offline = false
  let gets = 0
  const device = http.createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\n\n')
      streams.add(res); res.on('close', () => streams.delete(res)); return
    }
    gets++
    res.writeHead(offline ? 503 : 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(snapshot))
  })
  await new Promise(resolve => device.listen(0, '127.0.0.1', resolve))
  const applied = []; const holds = []; const errors = []
  const sync = new LanguageSync({ dataDir, deviceUrl: `http://127.0.0.1:${device.address().port}/internal/memory/chat/completions`,
    apply: async language => { await options.apply?.(language); applied.push(language) },
    hold: value => holds.push(value), logger: { log() {}, warn: message => errors.push(message) }, pollMs: options.pollMs || 25 })
  t.after(async () => {
    await sync.stop(); device.closeAllConnections(); await new Promise(resolve => device.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  return { sync, dataDir, applied, holds, errors, streams, gets: () => gets,
    offline: value => { offline = value },
    change(value, event = true) {
      snapshot = value
      if (event) for (const res of streams) res.write(`event: settings:language\ndata: ${JSON.stringify({ type: 'settings:language', ...value })}\n\n`)
    } }
}

test('explicit language wins; system/auto use the OS tag; only valid tags cross the boundary', () => {
  assert.equal(resolveLanguage({ ui: 'en', resolved: 'zh-CN' }), 'en')
  assert.equal(resolveLanguage({ ui: 'zh', resolved: 'en-US' }), 'zh-CN')
  for (const ui of ['system', 'SYSTEM', 'auto', '']) {
    assert.equal(resolveLanguage({ ui, resolved: 'en_US' }), 'en-US')
    assert.equal(resolveLanguage({ ui, resolved: 'ja-JP' }), 'ja-JP')
    assert.equal(resolveLanguage({ ui, resolved: ' \t' }), 'en')
    for (const resolved of [undefined, null, 5]) {
      assert.throws(() => resolveLanguage({ ui, resolved }), /Missing or invalid language tag/)
    }
  }
  for (const code of ['en', 'ja', 'ko', 'es', 'fr', 'de', 'ru', 'pt', 'it', 'ar', 'id', 'sv', 'kn']) assert.equal(normalizeLanguage(code), code)
  assert.equal(normalizeLanguage('zh-Hant-TW'), 'zh-Hant-TW')
  for (const value of ['', 'system', 'auto', 'English', 'English please', 5, null]) assert.throws(() => normalizeLanguage(value))
})

test('fresh startup applies the default English snapshot and becomes ready', async t => {
  const f = await fixture(t, { snapshot: { ui: 'system', resolved: '' } })
  assert.equal(readLanguageState(f.dataDir), null)
  f.sync.start()
  await until(() => f.sync.status().ready)
  assert.equal(f.sync.status().language, 'en')
  assert.deepEqual(f.applied, ['en'])
  assert.equal(readLanguageState(f.dataDir), 'en')
})

test('initial snapshot, split SSE frames, polling recovery and duplicate suppression', async t => {
  const f = await fixture(t)
  f.sync.start()
  await until(() => f.sync.status().ready && f.streams.size)
  assert.deepEqual(f.applied, ['en-US'])
  f.change({ ui: 'system', resolved: 'ja-JP' }, false)
  for (const res of f.streams) {
    res.write('event: settings:language\r\ndata: {"type":"settings:language","ui":"system",')
    res.write('"resolved":"ja-JP"}\r\n\r\n')
  }
  await until(() => f.applied.includes('ja-JP'))
  f.change({ ui: 'ja', resolved: 'zh-CN' })
  await until(() => f.sync.status().language === 'ja')
  const count = f.applied.length
  f.change({ ui: 'ja', resolved: 'en-US' })
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(f.applied.length, count)
  // A lost event is repaired by the periodic authoritative snapshot.
  f.change({ ui: 'system', resolved: 'zh-CN' }, false)
  await until(() => f.sync.status().language === 'zh-CN')
  assert.equal(readLanguageState(f.dataDir), 'zh-CN')
})

test('unavailable or unresolved source does not silently choose the Memory host language', async t => {
  const f = await fixture(t, { snapshot: { ui: 'system' } })
  f.sync.start()
  await until(() => f.gets() >= 2 && f.sync.status().error === 'Missing or invalid language tag')
  assert.equal(f.sync.status().ready, false)
  assert.equal(f.applied.length, 0)
  assert.equal(readLanguageState(f.dataDir), null)
  await assert.rejects(f.sync.run(() => assert.fail()), { code: 'language_pending' })
  f.change({ ui: 'en', resolved: '' })
  await until(() => f.sync.status().ready)
  f.offline(true)
  await until(() => f.sync.status().error)
  assert.equal(f.sync.status().language, 'en')
  assert.equal(await f.sync.run(async () => 'last-known language'), 'last-known language')
  f.offline(false)
  f.change({ ui: 'en', resolved: '' })
  await until(() => !f.sync.status().error)
})

test('restart restores the last synchronized preference and reconnect repairs an offline change', async t => {
  const f = await fixture(t, { cached: 'en', pollMs: 50 })
  f.offline(true)
  f.sync.start()
  await until(() => f.sync.status().ready && f.streams.size)
  assert.equal(f.sync.status().language, 'en')
  f.offline(false)
  f.change({ ui: 'system', resolved: 'ko-KR' }, false)
  for (const stream of f.streams) stream.end()
  await until(() => f.sync.status().language === 'ko-KR' && f.streams.size)
  assert.equal(readLanguageState(f.dataDir), 'ko-KR')
})

test('failed runtime update stays gated, retries, and coalesces subsequent language changes', async t => {
  const gate = deferred(); let fail = true
  const f = await fixture(t, { apply: async () => { if (fail) throw new Error('native unavailable'); await gate.promise } })
  f.sync.start()
  await until(() => f.sync.status().error)
  assert.equal(readLanguageState(f.dataDir), null)
  assert.equal(f.sync.status().ready, false)
  fail = false
  f.change({ ui: 'en', resolved: '' })
  await until(() => !!f.sync.pending)
  f.change({ ui: 'ja', resolved: '' })
  gate.resolve()
  await until(() => f.sync.status().ready && f.sync.status().language === 'ja')
  assert.equal(readLanguageState(f.dataDir), 'ja')
})

test('configuration PATCH is narrowly scoped and requires an acknowledgement', async t => {
  let payload
  const server = http.createServer(async (req, res) => {
    assert.equal(req.method, 'PATCH'); assert.equal(req.url, '/api/v1/admin/configuration')
    assert.equal(req.headers['x-api-key'], 'test-key')
    const parts = []; for await (const part of req) parts.push(part)
    payload = JSON.parse(Buffer.concat(parts))
    res.end(JSON.stringify({ status: 'ok', result: { settings: payload.settings } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const client = new OpenVikingClient({ url: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-key' })
  await client.setOutputLanguage('en')
  assert.deepEqual(payload, { settings: { output_language_override: 'en' } })
  client.request = async () => ({ settings: {} })
  await assert.rejects(client.setOutputLanguage('en'), /did not confirm/)
  const config = nativeConfig({ dataDir: '/tmp/state', openviking: { url: 'http://127.0.0.1:1933', runtimeDir: '/tmp/state', outputLanguage: 'en' } }, 'http://127.0.0.1:1/v1', 'key', 'key')
  assert.equal(config.output_language_override, 'en')
})

test('managed service drains accepted work before an SSE language change and persists the new native config', async t => {
  const { EventEmitter } = require('events')
  const { start } = require('../server')
  const { loadConfig } = require('../config')
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-language-managed-')))
  const peers = new Set(); const patches = []; const nativeDrains = []
  let snapshot = { ui: 'system', resolved: 'en-US' }
  const device = http.createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n')
      peers.add(res); res.on('close', () => peers.delete(res))
    } else { res.end(JSON.stringify(snapshot)) }
  })
  await new Promise(resolve => device.listen(0, '127.0.0.1', resolve))
  const probe = http.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const native = http.createServer(async (req, res) => {
    if (req.url === '/ready') { res.end('{"status":"ready"}'); return }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    let result = {}
    if (req.url === '/api/v1/system/wait') nativeDrains.push('drained')
    if (req.url === '/api/v1/admin/configuration') {
      patches.push(body.settings.output_language_override)
      result = { settings: body.settings }
    }
    res.end(JSON.stringify({ status: 'ok', result }))
  })
  const config = loadConfig(['--socket', path.join(root, 'mem.sock'), '--data-dir', root], {
    OPENVIKING_URL: `http://127.0.0.1:${port}`,
    OPENVIKING_RUNTIME_DIR: path.join(root, 'run'),
    OPENVIKING_DEVICE_MODEL_URL: `http://127.0.0.1:${device.address().port}/internal/memory/chat/completions`,
  })
  const service = await start(config, { runtimeOptions: {
    embedder: { status: () => ({ state: 'ready', dim: 1024 }) },
    spawnProcess() {
      native.listen(port, '127.0.0.1')
      const child = new EventEmitter(); child.pid = 1234
      child.kill = () => { child.emit('exit', 0, null); return true }
      return child
    },
  } })
  t.after(async () => {
    await service.shutdown()
    for (const server of [device, native]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    fs.rmSync(root, { recursive: true, force: true })
  })
  await until(() => service.language.status().ready && peers.size)
  assert.deepEqual(patches, ['en-US'])
  const work = deferred()
  const accepted = service.language.run(() => service.background.run(() => work.promise))
  snapshot = { ui: 'ja', resolved: 'en-US' }
  for (const peer of peers) peer.write(`data: ${JSON.stringify({ type: 'settings:language', ...snapshot })}\n\n`)
  await until(() => service.language.status().desired === 'ja')
  assert.equal(service.language.status().ready, false)
  assert.deepEqual(patches, ['en-US'])
  assert.equal(nativeDrains.length, 1)
  await assert.rejects(service.language.run(() => assert.fail()), { code: 'language_pending' })
  work.resolve(); await accepted
  await until(() => service.language.status().ready)
  assert.deepEqual(patches, ['en-US', 'ja'])
  assert.equal(nativeDrains.length, 2)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'run/ov.conf'))).output_language_override, 'ja')
  assert.equal(readLanguageState(root), 'ja')
  assert.equal(await service.client.ready(), true)
  // Standby intent survives later language changes.
  service.background.setPaused(true)
  await until(() => !service.background.status().busy)
  snapshot = { ui: 'en', resolved: 'ja-JP' }
  for (const peer of peers) peer.write(`data: ${JSON.stringify({ type: 'settings:language', ...snapshot })}\n\n`)
  await until(() => service.language.status().ready && service.language.status().language === 'en')
  assert.equal(service.background.status().paused, true)
})
