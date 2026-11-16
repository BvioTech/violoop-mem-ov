// Structured Device errors plus compatibility with older SDK-wrapped failures.
// The bridge's outer 502 must not hide an inner authentication/billing failure.
const BLOCKING = new Set(['auth_error', 'authentication_error', 'invalid_api_key',
  'credit_exhausted', 'budget_exceeded', 'permission_denied', 'MODEL_ROUTE_UNAVAILABLE', 'model_blocked'])
const CODES = new Set([...BLOCKING, 'invalid_request', 'cancelled', 'rate_limited', 'provider_unavailable',
  'provider_overloaded', 'request_timeout', 'idle_timeout', 'hard_timeout', 'api_call_failed', 'empty_response', 'device_standby'])
const PERMANENT = new Set([400, 401, 402, 403, 404, 405, 413, 415, 422])
const safeId = value => typeof value === 'string' && /^[\w.:/-]{1,160}$/.test(value) ? value : undefined

function modelError(error) {
  const objects = [], strings = []
  function visit(value, depth = 0) {
    if (depth > 5 || value == null) return
    if (typeof value === 'string') {
      strings.push(value)
      if (value.trim().startsWith('{')) try { visit(JSON.parse(value), depth + 1) } catch { /* SDK repr is not always JSON. */ }
    } else if (typeof value === 'object') {
      objects.push(value)
      for (const key of ['message', 'error', 'code', 'type', 'detail', 'result', 'violoop']) visit(value[key], depth + 1)
    }
  }
  visit(error)
  const text = strings.join('\n')
  const codes = [...objects.flatMap(o => [o.code, o.type]),
    ...[...text.matchAll(/["'](?:code|type)["']\s*:\s*["']([\w]+)["']/g)].map(m => m[1])]
  const code = codes.find(c => BLOCKING.has(c)) || codes.find(c => CODES.has(c))
  const auth = /\b(?:AuthenticationError|invalid_api_key|authentication_error)\b|authentication\s+fails?|invalid.{0,20}api.?key|api.?key.{0,30}(?:invalid|expired)|\b401\b.{0,30}(?:unauthorized|authentication)/i.test(text)
  const billing = /\b(?:credit_exhausted|budget_exceeded|insufficient_balance|ExceededBudget)\b|insufficient\s+(?:balance|credit)/i.test(text)
  const status = objects.map(o => Number(o.upstream_status ?? o.upstreamStatus ?? o.status_code ?? o.statusCode ?? o.http_status ?? o.status))
    .find(s => PERMANENT.has(s))
  const protocolStatus = [...text.matchAll(/\b(?:HTTP(?:\s+status)?|status(?:_code|\s+code)?|error\s+code)['"]?\s*[:=]?\s*['"]?(\d{3})\b/gi)]
    .map(m => Number(m[1])).find(s => PERMANENT.has(s))
  const permanent = BLOCKING.has(code) || auth || billing || !!status || !!protocolStatus
    || /\b(?:PermissionDeniedError|BadRequestError|permission_denied|invalid_request_error|context_length_exceeded|model_not_found)\b/i.test(text)
  const effectiveStatus = status || protocolStatus
  const normalizedCode = code || (auth || effectiveStatus === 401 ? 'auth_error'
    : billing || effectiveStatus === 402 ? 'credit_exhausted'
      : effectiveStatus === 403 ? 'permission_denied' : undefined)
  const explicit = objects.find(o => typeof o.retryable === 'boolean')
  const retryable = permanent ? false : explicit?.retryable !== false && !/["']retryable["']\s*:\s*false\b/i.test(text)
  const metadata = {}
  for (const key of ['request_id', 'upstream_request_id', 'model', 'provider', 'credential_source', 'action']) {
    const value = objects.map(o => o[key]).find(safeId)
      || text.match(new RegExp(`["']${key}["']\\s*:\\s*["']([\\w.:/-]{1,160})["']`))?.[1]
    if (value) metadata[key] = value
  }
  if (!metadata.upstream_request_id) metadata.upstream_request_id = text.match(/\(request_id:\s*([\w-]{1,128})\)/)?.[1]
  return { ...metadata, ...(normalizedCode ? { code: normalizedCode } : {}), retryable,
    requiresAction: !!normalizedCode && BLOCKING.has(normalizedCode),
    ...(status || protocolStatus ? { upstream_status: status || protocolStatus } : {}) }
}

module.exports = { modelError }
