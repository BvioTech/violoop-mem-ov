// Pure local embedding access over the existing permission-protected socket.
// Reuses the managed gateway's queue; never touches memory storage or migration.
const http = require('http')
const fs = require('fs')
const crypto = require('crypto')
const { readBody } = require('./model_gateway')
const { identity } = require('./model_file_identity')

function createEmbeddingApi({ embedder, gatewayUrl, token, run = task => task() }) {
  let fingerprint = null
  async function describe() {
    const status = embedder.status()
    if (status.state !== 'ready' || status.dim !== 1024 || !embedder.modelPath || embedder.profile?.id !== 'bge-m3')
      throw Object.assign(Error('local_embedding_unavailable'), { status: 503 })
    const stat = await fs.promises.stat(embedder.modelPath)
    const key = identity(stat)
    if (key !== embedder.modelFileIdentity) throw Object.assign(Error('loaded_embedding_weights_changed'), { status: 503 })
    if (fingerprint?.key !== key) {
      const promise = (async () => {
        const hash = crypto.createHash('sha256')
        for await (const bytes of fs.createReadStream(embedder.modelPath)) hash.update(bytes)
        if (identity(await fs.promises.stat(embedder.modelPath)) !== key) throw Error('embedding_file_changed_during_hash')
        return hash.digest('hex')
      })()
      fingerprint = { key, promise }
      promise.catch(() => { if (fingerprint?.promise === promise) fingerprint = null })
    }
    return { version: 1, model: 'bge-m3', dimensions: 1024, inputFormat: 'plain-v1',
      revision: await fingerprint.promise, maxBatch: 16, maxInputChars: 4000 }
  }
  function encode(input, signal) {
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify({ model: 'bge-m3', input, encoding_format: 'float' }))
      const request = http.request(gatewayUrl + '/embeddings', { method: 'POST', signal,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': payload.length } }, response => {
        const chunks = []; let size = 0
        response.on('data', chunk => {
          size += chunk.length
          if (size > 4 * 1024 * 1024) request.destroy(Error('embedding_response_too_large'))
          else chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () => {
          if (response.statusCode !== 200) return reject(Object.assign(Error('local_embedding_failed'), { status: response.statusCode }))
          try { resolve(JSON.parse(Buffer.concat(chunks))) } catch { reject(Error('invalid_embedding_response')) }
        })
      })
      request.on('error', reject)
      request.end(payload)
    })
  }
  return async function handle(req, res) {
    const reply = (status, value) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) } }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60000)
    timer.unref?.()
    res.on('close', () => { if (!res.writableEnded) controller.abort() })
    try {
      if (req.method === 'GET') return reply(200, await describe())
      if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' })
      const body = await readBody(req, 300000)
      const profile = await describe()
      if (body.version !== 1 || body.revision !== profile.revision || body.model !== profile.model ||
          !Array.isArray(body.input) || !body.input.length || body.input.length > profile.maxBatch ||
          body.input.some(text => typeof text !== 'string' || !text.trim() || text.length > profile.maxInputChars))
        return reply(400, { error: 'invalid_embedding_request_or_revision' })
      const result = await run(() => encode(body.input, controller.signal))
      const after = await describe()
      if (after.revision !== profile.revision) throw Error('embedding_revision_changed')
      return reply(200, { ...result, profile })
    } catch (error) {
      // Network exceptions can carry URLs/credentials. Return a stable code.
      reply(error.status >= 400 && error.status < 600 ? error.status : 503, { error: 'local_embedding_unavailable' })
    } finally { clearTimeout(timer) }
  }
}
module.exports = { createEmbeddingApi }
