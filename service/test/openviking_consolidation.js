const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { once } = require('events')
const { MemoryConsolidation } = require('../openviking_consolidation')
const { OpenVikingClient } = require('../openviking_client')

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-consolidation-'))
  const f = { dir, submitted: 0, synced: 0, invalidated: 0, task: { status: 'pending' } }
  f.client = { scope: 'scope', user: 'test', ready: async () => true,
    consolidateMemories: async target => { assert.equal(target, 'viking://user/test/memories'); f.submitted++; return { task_id: 'cmp_1', status: 'pending' } },
    task: async id => { assert.equal(id, 'cmp_1'); return f.task } }
  f.graph = { error: null, sync: async force => { assert.equal(force, true); f.synced++ } }
  f.make = () => new MemoryConsolidation(f.client, f.graph, { dataDir: dir, pollMs: 60000, invalidate: () => f.invalidated++ })
  f.service = f.make()
  t.after(async () => { await f.service.stop(); fs.rmSync(dir, { recursive: true, force: true }) })
  return f
}

test('native request uses memory compile on the current user scope', async t => {
  let request
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    request = { method: req.method, path: req.url, body: JSON.parse(body), user: req.headers['x-openviking-user'] }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok', result: { task_id: 'cmp_1' } }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const client = new OpenVikingClient({ url: 'http://127.0.0.1:' + server.address().port, user: 'test' })
  await client.consolidateMemories('viking://user/test/memories')
  assert.deepEqual(request, { method: 'POST', path: '/api/v1/compile', user: 'test', body: { to: 'viking://user/test/memories', skill: 'memory' } })
})

test('consolidation is manual; accepted and running tasks never update the graph early', async t => {
  const f = fixture(t)
  f.service.resume()
  assert.equal(f.submitted, 0)
  assert.equal((await f.service.start()).taskId, 'cmp_1')
  assert.equal((await f.service.start()).reason, 'busy')
  await f.service.poll()
  assert.equal(f.service.status().running, true); assert.equal(f.synced, 0)
  f.task = { status: 'completed', result: { adds: ['a'], updates: ['b'], deletes: ['c'] } }
  await f.service.poll()
  assert.equal(f.submitted, 1); assert.equal(f.synced, 1); assert.equal(f.service.status().running, false)
  assert.deepEqual(f.service.status().result, { adds: ['a'], updates: ['b'], deletes: ['c'], errors: [] })
  assert.equal(f.invalidated, 2)
})

test('restart resumes a saved task without another native submission', async t => {
  const f = fixture(t)
  await f.service.start(); await f.service.stop()
  f.service = f.make()
  f.service.resume()
  f.task = { status: 'completed', result: {} }
  await f.service.poll()
  assert.equal(f.submitted, 1); assert.equal(f.synced, 1)
  await f.service.stop(); f.service = f.make(); f.service.resume()
  assert.equal(f.service.status().running, false); assert.equal(f.submitted, 1)
})

test('partial success and failed tasks both reconcile applied writes and retain errors', async t => {
  const f = fixture(t)
  for (const status of ['completed', 'failed', 'cancelled']) {
    await f.service.start()
    f.task = { status, result: { updates: ['changed'], errors: ['one operation failed'] } }
    await f.service.poll()
    assert.match(f.service.status().lastError.message, /one operation failed/)
    assert.equal(f.service.status().running, false)
  }
  assert.equal(f.synced, 3)
})

test('graph sync failure retries projection only, preserving the completed native task', async t => {
  const f = fixture(t)
  await f.service.start(); f.task = { status: 'completed', result: {} }
  f.graph.error = 'offline'
  await f.service.poll()
  assert.equal(f.service.status().running, true)
  assert.match(f.service.status().lastError.message, /graph sync failed/)
  f.graph.error = null; await f.service.poll()
  assert.equal(f.submitted, 1); assert.equal(f.service.status().running, false)
  assert.equal(f.service.status().lastError, null)
})

test('unknown submission outcome is not resubmitted, including after restart', async t => {
  const f = fixture(t)
  f.client.consolidateMemories = async () => { f.submitted++; throw new Error('lost response') }
  await assert.rejects(f.service.start(), /lost response/)
  assert.equal(f.service.status().blocked, true)
  await assert.rejects(f.service.start(), /unknown/)
  await f.service.stop(); f.service = f.make(); f.service.resume()
  assert.equal(f.service.status().blocked, true); assert.equal(f.submitted, 1)
})

test('a definitive native rejection allows a later manual retry; scope mismatch does not', async t => {
  const f = fixture(t)
  f.client.consolidateMemories = async () => { throw Object.assign(new Error('unsupported'), { upstreamStatus: 404 }) }
  await assert.rejects(f.service.start(), /unsupported/)
  assert.equal(f.service.status().blocked, false)
  await f.service.stop(); f.client.scope = 'other'; f.service = f.make()
  assert.equal(f.service.status().enabled, false)
  await assert.rejects(f.service.start(), /another memory scope/)
})
