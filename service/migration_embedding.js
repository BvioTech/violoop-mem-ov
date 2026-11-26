// Migration embedding is forwarded to Device, which owns cloud credentials and renewal.
const http = require('http')
const MAX_ERROR_BODY_BYTES = 16 * 1024

function errorDetail(bytes, token) {
  const text = bytes.toString('utf8').trim()
  let message, code
  try {
    const body = JSON.parse(text)
    message = typeof body === 'string' && body.length <= 512 ? body : body?.error?.message ?? body?.message
    code = body?.error?.code ?? body?.code
  } catch {
    if (text.length <= 512 && !/^[<{\[]/.test(text)) message = text
  }
  const sanitize = value => value
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/https?:\/\/\S+/gi, '[redacted URL]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s"',;}]+/gi, '[redacted authorization]')
    .replace(/\b(?:authorization|(?:api|access)[-_ ]?key|(?:(?:access|refresh|session)[-_ ]?)?token|password|(?:client[-_ ]?)?secret)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '[redacted credential]')
    .replace(/\b(?:sk-|AKIA)[\w-]+/g, '[redacted key]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted token]')
    .trim()
    .slice(0, 240)
  if (typeof message === 'string') message = sanitize(message.replaceAll(token, '[redacted]'))
  // Keep the structured provider code recognizable to the Python error classifier.
  const codeText = typeof code === 'number' || typeof code === 'string' ? String(code) : ''
  let safeCode
  if (/^[\w.-]{1,64}$/.test(codeText) && !codeText.includes(token) && sanitize(codeText) === codeText) {
    safeCode = /^\d{1,9}$/.test(codeText) ? Number(codeText) : codeText
  }
  return [safeCode === undefined ? '' : '{"code": ' + JSON.stringify(safeCode) + '}',
    typeof message === 'string' ? message : ''].filter(Boolean).join(' ')
}

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
          const status = response.statusCode
          const clientError = status >= 400 && status < 500
          const chunks = []; let size = 0
          response.on('data', chunk => {
            size += chunk.length
            if (status === 200) {
              if (size > 1024 * 1024) request.destroy(new Error('Migration embedding response is too large'))
              else chunks.push(chunk)
            } else if (clientError && size <= MAX_ERROR_BODY_BYTES) {
              chunks.push(chunk)
            }
          })
          response.on('error', () => reject(new Error('Migration embedding response interrupted')))
          response.on('end', () => {
            if (status !== 200) {
              const detail = clientError && size <= MAX_ERROR_BODY_BYTES ? errorDetail(Buffer.concat(chunks), token) : ''
              const message = `Migration embedding service returned HTTP ${status}`
              return reject(Object.assign(new Error(detail ? `${message}: ${detail}` : message), {
                status: clientError ? status : 503,
              }))
            }
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
