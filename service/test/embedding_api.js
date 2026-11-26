const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { startModelGateway } = require('../model_gateway')
const { createEmbeddingApi } = require('../embedding_api')
const { Embedder } = require('../embedder')
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })

test('socket embedding API binds real model bytes, shares local queue and preserves complete input', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-api-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const modelPath = path.join(dir, 'model.gguf'); fs.writeFileSync(modelPath, 'weights-one')
  const inputs = []; let active = 0, peak = 0, paused = false
  const embedder = { modelPath, modelFileIdentity: require('../model_file_identity').identity(fs.statSync(modelPath)), profile: { id: 'bge-m3' }, status: () => ({ state: 'ready', dim: 1024 }), async embedQuery(text, { truncate }) {
    assert.equal(truncate, false)
    if (text === 'oversized') throw Object.assign(Error('Input length exceeds model context length'), {
      status: 413, code: 'embedding_input_too_large',
    })
    if (text === 'empty tokens') throw Object.assign(Error('Embedding input is empty after tokenization'), {
      status: 400, code: 'embedding_input_empty',
    })
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
  for (const [input, status, error, message] of [
    ['oversized', 413, 'embedding_input_too_large', 'Input length exceeds model context length'],
    ['empty tokens', 400, 'embedding_input_empty', 'Embedding input is empty after tokenization'],
  ]) {
    const response = await post([input])
    assert.equal(response.status, status)
    assert.deepEqual(await response.json(), { error, message })
  }
  assert.equal((await post(['x'], 'old')).status, 400)
  paused = true; assert.equal((await post(['x'])).status, 503)
  fs.writeFileSync(modelPath, 'weights-two-changed')
  assert.equal((await fetch(url)).status, 503)
  // Only a freshly loaded native model can advertise a new fingerprint.
  embedder.modelFileIdentity = require('../model_file_identity').identity(fs.statSync(modelPath))
  assert.notEqual((await (await fetch(url)).json()).revision, profile.revision)
})

test('local gateway bounds actual tokens with BOS/EOS headroom and preserves input errors', async t => {
  const oversized = 'x'.repeat(4000) // Passes the engine's pre-tokenization estimate.
  const embedder = new Embedder()
  embedder.state = 'ready'
  embedder.profile = { query: text => text, doc: (title, text) => title + '\n' + text }
  const original = Array.from({ length: 9000 }, (_, index) => index + 10)
  const tokenize = t.mock.fn((text, specialTokens) => {
    assert.equal(specialTokens, false)
    if (text.endsWith(oversized)) return original
    if (text === 'empty tokens') return []
    return [{ 'context failure': 3, 'unavailable': 4, 'invalid': 5 }[text] || 6]
  })
  const getEmbeddingFor = t.mock.fn(async tokens => {
    if (tokens[0] === 3) throw Error('Input is longer than the context size')
    if (tokens[0] === 4) throw Error('Temporary inference failure')
    if (tokens[0] === 5) throw Object.assign(Error('Invalid model input'), { status: 400, code: 'invalid_input' })
    assert.ok(Array.isArray(tokens))
    // Mirror special-token insertion and the decoder's reserved slot.
    assert.ok([1, ...tokens, 2].length <= 8191)
    return { vector: Array(1024).fill(0.25) }
  })
  embedder._ctx = { _llamaContext: { contextSize: 8192, model: { tokenizer: tokenize } }, getEmbeddingFor }
  const log = t.mock.method(console, 'info', () => {})
  const gateway = await startModelGateway({ embedder, token: 'test-token', deviceUrl: 'http://127.0.0.1:9090/chat/completions' })
  t.after(() => close(gateway.server))
  const post = (input, options = {}) => fetch(gateway.url + '/embeddings', {
    method: 'POST', headers: { authorization: 'Bearer test-token' },
    body: JSON.stringify({ model: 'bge-m3', input, ...options }),
  })

  const truncated = await post(oversized)
  assert.equal(truncated.status, 200)
  assert.equal((await truncated.json()).data[0].embedding.length, 1024)
  assert.deepEqual(getEmbeddingFor.mock.calls[0].arguments[0], original.slice(0, 8189))
  assert.equal(original.length, 9000)

  for (const [input, options, status, code, message, calls] of [
    [oversized, { truncate: false }, 413, 'embedding_input_too_large', 'Input length exceeds model context length', 0],
    ['context failure', {}, 413, 'embedding_input_too_large', 'Input length exceeds model context length', 1],
    ['empty tokens', {}, 400, 'embedding_input_empty', 'Embedding input is empty after tokenization', 0],
    ['invalid', {}, 400, 'invalid_input', 'Invalid model input', 1],
    ['unavailable', {}, 503, undefined, 'BGE embedding unavailable', 2],
  ]) {
    const before = getEmbeddingFor.mock.callCount()
    const response = await post(input, options)
    assert.equal(response.status, status)
    assert.deepEqual(await response.json(), { error: { message, ...(code ? { code } : {}) } })
    assert.equal(getEmbeddingFor.mock.callCount() - before, calls)
  }
  assert.equal((await post('subsequent request')).status, 200)
  assert.deepEqual(log.mock.calls.map(call => JSON.parse(call.arguments[1]).status),
    ['ok', 413, 413, 400, 400, 503, 'ok'])

  await assert.rejects(embedder.embedDocument({ title: 'Event', text: oversized }, { truncate: false }),
    { status: 413, code: 'embedding_input_too_large' })
  assert.equal(tokenize.mock.calls.at(-1).arguments[0], 'Event\n' + oversized)
})
