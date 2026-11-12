// Private query-compilation transport. Device owns the cloud model, credentials
// and cache; the memory service still owns BGE and the original stored content.
const http = require('http')
const MAX_QUERY_CHARS = 256

function createQueryPreparer({ deviceModelUrl, token, timeoutMs = 3000 }) {
  const endpoint = new URL(deviceModelUrl)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !endpoint.pathname.endsWith('/chat/completions')) throw Error('Invalid device model URL')
  endpoint.pathname = endpoint.pathname.replace(/\/chat\/completions$/, '/retrieval-query')
  return function prepare(text, { signal } = {}) {
    if (text.length <= MAX_QUERY_CHARS) return Promise.resolve(text)
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify({ version: 1, text }))
      const request = http.request(endpoint, { method: 'POST', signal, headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': payload.length,
      } }, response => {
        const chunks = []; let size = 0
        response.on('data', chunk => {
          size += chunk.length
          if (size > 8192) request.destroy(Error('query_preparation_response_too_large'))
          else chunks.push(chunk)
        })
        response.on('error', () => reject(Error('query_preparation_interrupted')))
        response.on('end', () => {
          if (response.statusCode !== 200) return reject(Error('query_preparation_unavailable'))
          try {
            const result = JSON.parse(Buffer.concat(chunks))
            if (result.version !== 1 || typeof result.query !== 'string' ||
                !result.query.trim() || result.query.length > MAX_QUERY_CHARS) throw Error('invalid')
            resolve(result.query.trim())
          } catch { reject(Error('invalid_prepared_query')) }
        })
      })
      const timer = setTimeout(() => request.destroy(Error('query_preparation_timeout')), timeoutMs)
      timer.unref?.()
      request.on('close', () => clearTimeout(timer))
      request.on('error', error => reject(Error(error.message === 'query_preparation_timeout'
        ? error.message : 'query_preparation_unavailable')))
      request.end(payload)
    })
  }
}
module.exports = { createQueryPreparer, MAX_QUERY_CHARS }
