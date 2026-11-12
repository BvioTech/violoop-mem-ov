const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { startModelGateway } = require('../model_gateway')
const { createEmbeddingApi } = require('../embedding_api')
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })

test('socket embedding API binds real model bytes, shares local queue and preserves complete input', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-api-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const modelPath = path.join(dir, 'model.gguf'); fs.writeFileSync(modelPath, 'weights-one')
  const inputs = []; let active = 0, peak = 0, paused = false
  const embedder = { modelPath, modelFileIdentity: require('../model_file_identity').identity(fs.statSync(modelPath)), profile: { id: 'bge-m3' }, status: () => ({ state: 'ready', dim: 1024 }), async embedQuery(text) {
    inputs.push(text); active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5)); active--
    return Array(1024).fill(0.5)
  } }
  const gateway = await startModelGateway({ embedder, token: 'test-token', deviceUrl: 'http://127.0.0.1:9090/internal/memory/chat/completions' })
  t.after(() => close(gateway.server))
  const server = http.createServer(createEmbeddingApi({ embedder, gatewayUrl: gateway.url, token: 'test-token',
    run: task => { if (paused) throw Object.assign(Error('paused'), { status: 503 }); return task() } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => close(server))
  const url = `http://127.0.0.1:${server.address().port}`
  const profile = await (await fetch(url)).json()
  const post = (input, revision = profile.revision) => fetch(url, { method: 'POST', body: JSON.stringify({ version: 1, model: 'bge-m3', revision, input }) })
  const results = await Promise.all([post(['same input', '原文\n完整']), post(['other input'])])
  for (const result of results) { assert.equal(result.status, 200); assert.equal((await result.json()).profile.revision, profile.revision) }
  assert.equal(peak, 1); assert.deepEqual(inputs.sort(), ['same input', '原文\n完整', 'other input'].sort())
  assert.equal((await post(['x'], 'old')).status, 400)
  paused = true; assert.equal((await post(['x'])).status, 503)
  fs.writeFileSync(modelPath, 'weights-two-changed')
  assert.equal((await fetch(url)).status, 503)
  // Only a freshly loaded native model can advertise a new fingerprint.
  embedder.modelFileIdentity = require('../model_file_identity').identity(fs.statSync(modelPath))
  assert.notEqual((await (await fetch(url)).json()).revision, profile.revision)
})
