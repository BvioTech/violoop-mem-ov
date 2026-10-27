const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { startModelGateway } = require('../model_gateway')
const { appendTiming } = require('../migration_timing')

test('gateway timing correlates queued BGE and actual LLM metadata without logging content', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-timing-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const upstream = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => res.end(JSON.stringify({ model: 'actual-model', choices: [{ finish_reason: 'stop' }], usage: { total_tokens: 12 } })))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => { upstream.closeAllConnections(); upstream.close() })
  let active = 0; let peak = 0
  const gateway = await startModelGateway({ timingDir: dir, token: 'secret',
    deviceUrl: `http://127.0.0.1:${upstream.address().port}/internal/memory/chat/completions`,
    embedder: { async embedQuery() { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 15)); active--; return new Float32Array(1024) } } })
  t.after(() => { gateway.server.closeAllConnections(); gateway.server.close() })
  const headers = { authorization: 'Bearer secret', 'x-violoop-timing-task': 'task-123',
    'x-violoop-timing-run': 'run-1', 'x-violoop-timing-purpose': 'retrieval.query_embedding' }
  const post = async (route, body, h = headers) => {
    const res = await fetch(gateway.url + route, { method: 'POST', headers: h, body: JSON.stringify(body) })
    assert.equal(res.status, 200); return res.json()
  }
  await Promise.all([post('/embeddings', { model: 'bge-m3', input: 'PRIVATE_TEXT_A' }), post('/embeddings', { model: 'bge-m3', input: ['PRIVATE_TEXT_B', 'PRIVATE_TEXT_C'] })])
  await post('/chat/completions', { model: 'violoop-memory', messages: [{ role: 'user', content: 'PRIVATE_TEXT_D' }] })
  await post('/embeddings', { model: 'bge-m3', input: 'NORMAL_INPUT' }, { authorization: 'Bearer secret' })
  assert.equal(peak, 1)
  assert.deepEqual(fs.readdirSync(dir), ['task-123-gateway.jsonl'])
  const raw = fs.readFileSync(path.join(dir, 'task-123-gateway.jsonl'), 'utf8')
  assert.ok(!raw.includes('PRIVATE_TEXT')); assert.ok(!raw.includes('secret')); assert.ok(!raw.includes('NORMAL_INPUT'))
  const events = raw.trim().split('\n').map(JSON.parse)
  assert.equal(events.filter(e => e.stage === 'bge.compute').length, 3)
  assert.ok(events.some(e => e.stage === 'bge.gateway_queue' && e.durationMs >= 10))
  assert.equal(events.find(e => e.stage === 'llm.request').model, 'actual-model')
  assert.ok(events.every(e => e.runId === 'run-1' && e.taskId === 'task-123'))
})

test('invalid output ids and timing write failure cannot break work', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-timing-fail-'))
  try {
    appendTiming(dir, '../escape', {})
    fs.writeFileSync(path.join(dir, 'file'), '')
    assert.doesNotThrow(() => appendTiming(path.join(dir, 'file'), 'valid', {}))
    assert.deepEqual(fs.readdirSync(dir), ['file'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('timing report retains failed attempt durations after a successful retry', () => {
  const { spawnSync } = require('child_process')
  const { writeJson } = require('../durable_json')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-timing-retry-'))
  try {
    const root = path.join(dir, 'legacy-migration')
    writeJson(path.join(root, 'state.json'), { batches: [{ id: 'batch', status: 'completed',
      attempt: 1, trigger: 'automatic-retry', taskId: 'new-task', tokens: 4200,
      attempts: [{ attempt: 0, trigger: 'primary', status: 'failed', taskId: 'old-task' }] }] })
    appendTiming(path.join(root, 'timings'), 'old-task-gateway', { taskId: 'old-task',
      event: 'stage', stage: 'llm.request', durationMs: 100, status: 'error' })
    appendTiming(path.join(root, 'timings'), 'new-task-gateway', { taskId: 'new-task',
      event: 'stage', stage: 'llm.request', durationMs: 200, status: 'ok' })
    const p = spawnSync('python3', [path.join(__dirname, '../../scripts/migration-timing-report.py'), '--data-dir', dir], { encoding: 'utf8' })
    assert.equal(p.status, 0, p.stderr)
    const report = JSON.parse(p.stdout), batch = report.batches[0]
    assert.equal(batch.stages['llm.request'].durationMs, 300)
    assert.equal(batch.stages['llm.request'].failures, 1)
    assert.deepEqual(batch.attempts.map(a => a.stages['llm.request'].durationMs), [100, 200])
    assert.deepEqual(batch.attempts.map(a => a.status), ['failed', 'completed'])
    assert.equal(report.total.stages['llm.request'].durationMs, 300)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
