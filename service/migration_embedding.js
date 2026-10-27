// Migration embedding is forwarded to Device, which owns cloud credentials and renewal.
const http = require('http')

function createMigrationEmbedder({ deviceModelUrl, token, timeoutMs = 60000 } = {}) {
  const endpoint = new URL(deviceModelUrl)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    !endpoint.pathname.endsWith('/chat/completions')) throw new Error('Invalid device model URL')
  endpoint.pathname = endpoint.pathname.replace(/\/chat\/completions$/, '/embeddings')
  if (!token || /[\r\n]/.test(token)) throw new Error('Memory gateway token is required')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid migration embedding timeout')

  return {
    async embedQuery(input, { signal } = {}) {
      const payload = Buffer.from(JSON.stringify({ model: 'bge-m3', input, encoding_format: 'float' }))
      return new Promise((resolve, reject) => {
        const request = http.request(endpoint, { method: 'POST', signal, headers: {
          authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': payload.length,
        } }, response => {
          const chunks = []; let size = 0
          response.on('data', chunk => {
            size += chunk.length
            if (size > 1024 * 1024) request.destroy(new Error('Migration embedding response is too large'))
            else chunks.push(chunk)
          })
          response.on('error', () => reject(new Error('Migration embedding response interrupted')))
          response.on('end', () => {
            if (response.statusCode !== 200) return reject(Object.assign(
              new Error(`Migration embedding service returned HTTP ${response.statusCode}`),
              { status: response.statusCode >= 400 && response.statusCode < 500 ? response.statusCode : 503 },
            ))
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              const vector = body.data?.[0]?.embedding
              if (body.data?.length !== 1 || body.data[0].index !== 0 || !Array.isArray(vector)
                || vector.length !== 1024 || !vector.every(Number.isFinite)) throw new Error('invalid vector')
              resolve(vector)
            } catch { reject(new Error('Invalid migration embedding response: expected one 1024-dimensional float vector')) }
          })
        })
        const timer = setTimeout(() => request.destroy(new Error('Migration embedding request timed out')), timeoutMs)
        request.on('close', () => clearTimeout(timer))
        request.on('error', error => reject(new Error(error.message === 'Migration embedding request timed out'
          ? error.message : 'Migration embedding service unavailable')))
        request.end(payload)
      })
    },
  }
}

module.exports = { createMigrationEmbedder }
