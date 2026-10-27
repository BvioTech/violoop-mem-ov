// Metadata-only profiling. A failed timing write must never change migration work.
const fs = require('fs')
const path = require('path')
const { performance } = require('perf_hooks')
const warned = new Set()
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)

function appendTiming(dir, id, event) {
  if (!dir || !validId(id)) return
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.appendFileSync(path.join(dir, id + '.jsonl'), JSON.stringify({ version: 1,
      at: new Date().toISOString(), component: 'adapter', ...event }) + '\n', { mode: 0o600 })
  } catch (err) {
    if (!warned.has(dir)) { warned.add(dir); console.warn('[migration timing] write failed:', err.code || err.name) }
  }
}
function startStage(dir, id, stage, fields = {}) {
  const started = performance.now()
  const startedAt = new Date().toISOString()
  return (status = 'ok', extra = {}) => appendTiming(dir, id, {
    event: 'stage', stage, startedAt, durationMs: performance.now() - started,
    status, ...fields, ...extra,
  })
}
function gatewayTiming(req, dir) {
  const taskId = req.headers['x-violoop-timing-task']
  const runId = req.headers['x-violoop-timing-run']
  if (!validId(taskId) || !validId(runId)) return null
  const purpose = req.headers['x-violoop-timing-purpose']
  return { taskId, runId, purpose: typeof purpose === 'string' && /^[a-z_.]{1,64}$/.test(purpose) ? purpose : 'unknown',
    stage: (name, fields) => startStage(dir, taskId + '-gateway', name, { runId, taskId, ...fields }) }
}
module.exports = { appendTiming, startStage, gatewayTiming }
