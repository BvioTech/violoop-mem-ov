// Private OpenAI-compatible transport for the native OpenViking process.
// Ordinary BGE stays local; tagged legacy migration may use a separate transport.
const http = require('http')
const crypto = require('crypto')
const { gatewayTiming } = require('./migration_timing')
const { createEmbeddingQueue } = require('./embedding_queue')
const { createQueryPreparer } = require('./retrieval_query')

function authorized(req, token) {
  const actual = Buffer.from(req.headers.authorization || '')
  const expected = Buffer.from(`Bearer ${token}`)
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}
async function readBody(req, max = 2 * 1024 * 1024) {
  const chunks = []; let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > max) throw Object.assign(new Error('request too large'), { status: 413 })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks)) } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 })
  }
}
async function startModelGateway({ embedder, migrationEmbedder = null, token, deviceUrl, port = 0, timingDir,
  prepareQuery = createQueryPreparer({ deviceModelUrl: deviceUrl, token }) }) {
  const device = new URL(deviceUrl)
  if (device.protocol !== 'http:' || device.hostname !== '127.0.0.1' || device.username || device.password) {
    throw new Error('device model URL must use HTTP on 127.0.0.1 without credentials')
  }
  let paused = false
  let active = 0
  const queues = { local: createEmbeddingQueue(), remote: createEmbeddingQueue() }
  const server = http.createServer(async (req, res) => {
    if (!authorized(req, token)) return json(res, 403, { error: { message: 'forbidden' } })
    if (paused) return json(res, 503, { error: { message: 'Memory background is paused' } })
    active++
    let finished = false
    const done = () => { if (!finished) { finished = true; active-- } }
    res.once('finish', done); res.once('close', done)
    try {
      if (req.method !== 'POST') return json(res, 404, { error: { message: 'not found' } })
      const body = await readBody(req)
      const abort = new AbortController()
      res.on('close', () => { if (!res.writableEnded) abort.abort() })
      const timing = gatewayTiming(req, timingDir)
      if (req.url === '/v1/embeddings') {
        const inputs = typeof body.input === 'string' ? [body.input] : body.input
        if (body.model !== 'bge-m3' || !Array.isArray(inputs) || !inputs.length || inputs.length > 100
          || inputs.some(s => typeof s !== 'string' || !s.length) || body.encoding_format === 'base64'
          || (body.dimensions && body.dimensions !== 1024)) {
          return json(res, 400, { error: { message: 'requires bge-m3, text input and 1024 float dimensions' } })
        }
        const remote = Boolean(migrationEmbedder && req.headers['x-violoop-legacy-migration'] === '1')
        const backend = remote ? 'remote' : 'local'
        const selectedEmbedder = remote ? migrationEmbedder : embedder
        const queue = queues[backend]
        const query = body.input_type === 'query'
        const measured = { preparationMs: 0, queueMs: 0, computeMs: 0 }
        const started = Date.now(), requestId = crypto.randomUUID()
        let status = 'ok'
        const data = []
        let embeddingChars = 0, phase = 'preparation'
        try {
          const prepared = []
          // Compile before entering the BGE queue. A cloud call must never hold
          // the local inference slot or change document/index embeddings.
          for (const input of inputs) {
            if (abort.signal.aborted) throw Object.assign(Error('request cancelled'), { status: 499 })
            prepared.push(query && !remote ? await prepareQuery(input, { signal: abort.signal }) : input)
          }
          measured.preparationMs = Date.now() - started
          phase = 'embedding'
          embeddingChars = prepared.reduce((n, s) => n + s.length, 0)
          const queueDone = timing?.stage('bge.gateway_queue', { purpose: timing.purpose, inputCount: inputs.length, backend })
          const result = await queue.run(async () => {
            if (!data.length) queueDone?.()
            const input = prepared[data.length]
            if (res.destroyed) throw Object.assign(new Error('request cancelled'), { status: 499 })
            const done = timing?.stage('bge.compute', { purpose: timing.purpose, inputChars: input.length, backend })
            let vector
            try { vector = await selectedEmbedder.embedQuery(input, { signal: abort.signal }) } catch (err) { done?.('error'); throw err }
            done?.(vector ? 'ok' : 'unavailable')
            if (!vector || vector.length !== 1024 || !Array.from(vector).every(Number.isFinite)) {
              throw Object.assign(new Error('BGE embedding unavailable'), { status: 503 })
            }
            data.push({ object: 'embedding', index: data.length, embedding: Array.from(vector) })
            return { done: data.length === inputs.length, result: { object: 'list', model: 'bge-m3', data } }
          }, { query, signal: abort.signal, timing: measured })
          if (!res.destroyed) return json(res, 200, result)
        } catch (error) {
          if (phase === 'preparation') measured.preparationMs = Date.now() - started
          status = error.status || phase + '_error'; throw error
        }
        finally {
          console.info('[bge.request]', JSON.stringify({ requestId, backend, purpose: query ? 'query' : 'document',
            inputCount: inputs.length, inputChars: inputs.reduce((n, s) => n + s.length, 0), embeddingChars,
            ...measured, elapsedMs: Date.now() - started, status }))
        }
        return
      }
      if (req.url === '/v1/chat/completions') {
        // Only the native migration provider emits this system-instruction
        // marker. User/source text cannot opt other requests into this route.
        if (body.messages?.some(m => m.role === 'system' && typeof m.content === 'string'
          && m.content.includes('[VIOLOOP_LEGACY_MIGRATION_V1]'))) {
          body.violoop_legacy_migration = true
        }
        // http.request deliberately avoids device's global cloud proxy dispatcher.
        const payload = Buffer.from(JSON.stringify(body))
        const llmDone = timing?.stage('llm.request', { purpose: timing.purpose,
          inputChars: (body.messages || []).reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0) })
        let llmSettled = false
        const finishLlm = (status, fields = {}) => { if (!llmSettled) { llmSettled = true; llmDone?.(status, fields) } }
        const forward = http.request(device, { method: 'POST', headers: {
          authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': payload.length,
        } }, upstream => {
          if (timing) {
            const responseChunks = []; let responseBytes = 0
            upstream.on('data', chunk => { responseBytes += chunk.length; if (responseBytes <= 2 * 1024 * 1024) responseChunks.push(chunk) })
            upstream.on('end', () => {
              let metadata = {}
              if (responseBytes <= 2 * 1024 * 1024) try {
                const result = JSON.parse(Buffer.concat(responseChunks))
                metadata = { model: result.model, usage: result.usage, finishReason: result.choices?.[0]?.finish_reason }
              } catch { /* Timing never changes the response. */ }
              finishLlm(upstream.statusCode === 200 ? 'ok' : 'error', { httpStatus: upstream.statusCode, ...metadata })
            })
            upstream.on('error', () => finishLlm('error'))
          }
          res.writeHead(upstream.statusCode, { 'content-type': 'application/json' })
          upstream.pipe(res)
        })
        forward.setTimeout(180000, () => forward.destroy(new Error('device model request timed out')))
        forward.on('error', () => {
          finishLlm('error')
          if (!res.headersSent && !res.destroyed) json(res, 503, { error: { message: 'device model gateway unavailable' } })
          else res.destroy()
        })
        res.on('close', () => { if (!res.writableEnded) { finishLlm('cancelled'); forward.destroy() } })
        forward.end(payload)
        return
      }
      return json(res, 404, { error: { message: 'not found' } })
    } catch (err) {
      if (!res.destroyed) json(res, err.status || 503, { error: { message: err.message } })
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  return { server, setPaused(value) { paused = value }, async drain() {
    while (active || queues.local.pending || queues.remote.pending) await new Promise(resolve => setTimeout(resolve, 10))
  }, url: `http://127.0.0.1:${server.address().port}/v1` }
}
module.exports = { startModelGateway, authorized, readBody }
