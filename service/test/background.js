const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { BackgroundControl } = require('../background')
const { Embedder } = require('../embedder')
const { LegacyMigration } = require('../legacy_migration')
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const until = async fn => { for (let n = 0; n < 500; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)) } throw new Error('timed out') }
function setup(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-standby-'))
  const events = []
  const options = { dataDir, retryMs: 5,
    app: { setPaused: p => events.push('pause:' + p), drainSubmissions: async () => events.push('submissions') },
    client: { waitProcessed: async () => events.push('native') },
    runtime: { suspend: async () => events.push('suspend'), resume: async () => events.push('resume') }, ...overrides }
  const control = new BackgroundControl(options)
  t.after(async () => { await control.stop(); fs.rmSync(dataDir, { recursive: true, force: true }) })
  return { control, events, options }
}
test('standby drains admitted requests and native queues before releasing BGE; pause persists', async t => {
  const native = deferred(), request = deferred()
  const { control, events, options } = setup(t, { client: { waitProcessed: () => native.promise } })
  const admitted = control.run(() => request.promise)
  assert.deepEqual(control.setPaused(true), { paused: true, busy: true })
  await assert.rejects(control.run(() => assert.fail('must not admit')), { code: 'background_paused' })
  assert.ok(!events.includes('suspend'))
  request.resolve(); await admitted
  await until(() => events.includes('submissions'))
  assert.ok(!events.includes('suspend'))
  native.resolve(); await until(() => !control.status().busy)
  assert.deepEqual(events, ['pause:true', 'submissions', 'suspend'])
  const restored = new BackgroundControl(options)
  assert.equal(restored.paused, true); await restored.stop()
  control.setPaused(false); await until(() => !control.blocked())
  assert.equal(await control.run(async () => 'accepted'), 'accepted')
  assert.equal(JSON.parse(fs.readFileSync(control.file)).paused, false)
})
test('wake during drain never releases an active model; failed waits remain busy and retry', async t => {
  const native = deferred(); let attempts = 0
  const { control, events } = setup(t, { client: { waitProcessed: async () => { if (++attempts === 1) throw new Error('deadline'); await native.promise } } })
  control.setPaused(true)
  await until(() => attempts === 2)
  assert.equal(control.status().busy, true)
  assert.equal(control.status().error, 'deadline')
  control.setPaused(false); native.resolve()
  await until(() => !control.blocked())
  assert.ok(!events.includes('suspend'))
  assert.ok(events.includes('resume'))
})
test('wake racing model disposal reloads before admitting new work', async t => {
  const disposing = deferred(); let releasing = false
  const { control, events } = setup(t, { runtime: {
    suspend: async () => { releasing = true; await disposing.promise },
    resume: async () => events.push('reloaded'),
  } })
  control.setPaused(true); await until(() => releasing)
  control.setPaused(false)
  await assert.rejects(control.run(async () => 'too soon'))
  disposing.resolve(); await until(() => !control.blocked())
  assert.ok(events.includes('reloaded'))
})
test('invalid pause input and corrupt persisted state never silently change intent', t => {
  const { control, options } = setup(t)
  assert.throws(() => control.setPaused('true'), /boolean/)
  assert.equal(fs.existsSync(control.file), false)
  fs.writeFileSync(control.file, '{"paused":1}')
  assert.throws(() => new BackgroundControl(options), /invalid background/)
})
test('BGE suspend drains readers and loading, disposes context then model exactly once, and reloads on wake', async () => {
  const e = new Embedder(), compute = deferred(), events = []
  e.state = 'ready'; e.profile = { query: x => x }
  e._ctx = { getEmbeddingFor: () => compute.promise, dispose: async () => events.push('context') }
  e._model = { dispose: async () => events.push('model') }
  const work = e.embedQuery('query')
  await until(() => e._active === 1)
  const p1 = e.suspend(), p2 = e.suspend()
  assert.equal(p1, p2); assert.equal(await e.embedQuery('blocked'), null)
  assert.deepEqual(events, [])
  compute.resolve({ vector: [1, 0] }); await work; await p1
  assert.deepEqual(events, ['context', 'model']); assert.equal(e.state, 'idle')
  e._load = async () => { events.push('load'); e.state = 'ready' }
  await e.resume(); assert.equal(await e.ensureLoaded(), true)
  assert.deepEqual(events, ['context', 'model', 'load'])
  const loading = deferred(); e._loading = loading.promise
  e._ctx = { dispose: async () => events.push('loaded-context') }
  const draining = e.suspend(); await Promise.resolve()
  assert.ok(!events.includes('loaded-context'))
  loading.resolve(); await draining
  assert.ok(events.includes('loaded-context'))
})
test('migration standby does not change batch identities, retry counters or submit another batch', async t => {
  const { control, options } = setup(t)
  const m = new LegacyMigration({ dataDir: options.dataDir, sourceFile: path.join(options.dataDir, 'absent.db'), client: { scope: 'test' }, journal: {} })
  t.after(() => m.stop())
  m.setPaused(true)
  await assert.rejects(m.start(), /paused/)
  m.state = { started: true, batches: [{ id: 'one', status: 'accepted' }], automaticRetryCount: 2 }
  const before = JSON.stringify(m.state)
  await m.run(); assert.equal(JSON.stringify(m.state), before)
  m.setPaused(false); m.stop()
  assert.equal(JSON.stringify(m.state), before)
})
