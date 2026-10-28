// Manual native memory consolidation. Persist the task receipt before polling;
// failed submissions can be retried manually; accepted tasks resume after restart.
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { writeJson } = require('./durable_json')
const ACTIVE = new Set(['submitting', 'pending', 'accepted', 'queued', 'running', 'committing'])
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
class MemoryConsolidation {
  constructor(client, graph, { dataDir, invalidate = () => {}, pollMs = 2000 } = {}) {
    this.client = client; this.graph = graph; this.invalidate = invalidate; this.pollMs = pollMs
    this.scope = createHash('sha256').update(client.scope).digest('hex')
    this.target = `viking://user/${client.user || 'default'}/memories`
    this.file = path.join(dataDir, 'openviking-adapter', 'consolidation.json')
    this.state = null; this.timer = null; this.polling = null; this.stopped = false
    try {
      if (fs.existsSync(this.file)) {
        this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        if (this.state.version !== 1 || this.state.scope !== this.scope || this.state.target !== this.target) throw new Error('Consolidation state belongs to another memory scope')
        if (!ACTIVE.has(this.state.status) && !TERMINAL.has(this.state.status)) throw new Error('Invalid consolidation state')
        if (ACTIVE.has(this.state.status) && this.state.status !== 'submitting' && typeof this.state.taskId !== 'string') throw new Error('Consolidation task ID is missing')
        if (this.state.status === 'submitting') {
          this.state.status = 'failed'
          this.state.error = 'Consolidation submission result was not confirmed'
          this.save()
        }
      }
    } catch (e) { this.loadError = e.message }
  }
  save() { writeJson(this.file, this.state) }
  status() {
    const s = this.state
    return { enabled: !this.loadError, kind: 'native', running: !this.loadError && !!s && (ACTIVE.has(s.status) || !!s.graphPending),
      blocked: !!this.loadError, phase: s?.status || 'idle', taskId: s?.taskId || null,
      lastRunAt: s?.startedAt || null, nextDueAt: null, dirtyCount: null,
      result: s?.result || null,
      lastError: this.loadError || s?.error ? { message: this.loadError || s.error, at: s?.updatedAt || null } : null }
  }
  async start() {
    if (this.stopped) throw new Error('Consolidation service is stopped')
    const current = this.status()
    if (current.blocked) throw Object.assign(new Error(current.lastError.message), { status: 409, code: 'consolidation_invalid_state' })
    if (current.running) return { started: false, reason: 'busy', taskId: current.taskId }
    // Persist intent synchronously before awaiting readiness, serializing clicks.
    this.state = { version: 1, scope: this.scope, target: this.target, status: 'submitting', startedAt: Date.now(), updatedAt: Date.now() }
    this.save()
    try {
      if (!await this.client.ready()) throw new Error('OpenViking is not ready')
      if (this.stopped) throw new Error('Consolidation service is stopped')
      const task = await this.client.consolidateMemories(this.target)
      if (typeof task?.task_id !== 'string' || !task.task_id) throw new Error('Native consolidation did not return a task ID')
      this.state.taskId = task.task_id
      this.state.status = 'pending'; this.state.updatedAt = Date.now(); this.save()
      this.schedule()
      return { started: true, taskId: task.task_id }
    } catch (e) {
      this.state.status = 'failed'
      this.state.error = e.message
      this.state.updatedAt = Date.now(); this.save()
      throw e
    }
  }
  schedule() {
    if (this.stopped || this.timer || this.polling) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.poll()
    }, this.pollMs)
    this.timer.unref()
  }
  resume() {
    if (this.state?.taskId && (ACTIVE.has(this.state.status) || this.state.graphPending)) this.schedule()
  }
  async poll() {
    if (this.stopped) return
    if (this.polling) return this.polling
    clearTimeout(this.timer); this.timer = null
    this.polling = this.advance().catch(e => {
      this.state.error = e.message; this.state.updatedAt = Date.now(); this.save()
    }).finally(() => {
      this.polling = null
      if (this.state?.taskId && (ACTIVE.has(this.state.status) || this.state.graphPending)) this.schedule()
    })
    return this.polling
  }
  async advance() {
    const s = this.state
    if (!s?.taskId) return
    if (!TERMINAL.has(s.status)) {
      let task
      try { task = await this.client.task(s.taskId) }
      catch (e) {
        if (e.upstreamStatus === 404) {
          s.status = 'failed'; s.error = 'Native consolidation task is missing'
          s.updatedAt = Date.now(); this.save(); return
        }
        throw e
      }
      if (!ACTIVE.has(task.status) && !TERMINAL.has(task.status)) throw new Error('Unknown native consolidation status')
      s.status = task.status; s.updatedAt = Date.now(); s.error = null
      if (TERMINAL.has(task.status)) {
        const result = task.result || {}
        s.result = Object.fromEntries(['adds', 'updates', 'deletes'].map(k => [k, Array.isArray(result[k]) ? result[k].filter(u => typeof u === 'string') : []]))
        s.result.errors = Array.isArray(result.errors) ? result.errors.map(e => String(e).slice(0, 2000)) : []
        s.taskError = task.error ? String(task.error).slice(0, 2000) : s.result.errors.slice(0, 3).join('; ')
          || (task.status !== 'completed' ? 'Native consolidation ' + task.status : null)
        s.error = s.taskError
        s.graphPending = true // Failure/cancellation may still have applied some writes.
        this.invalidate()
      }
      this.save()
    }
    if (s.graphPending) {
      // Native compile results can omit neighboring files changed only by
      // link/backlink repair. Reconcile stored files once at task completion,
      // including partial failures; normal page polls remain incremental.
      await this.graph.sync(true)
      if (this.graph.error) throw new Error('Consolidation graph sync failed: ' + this.graph.error)
      s.graphPending = false; s.error = s.taskError || null; s.updatedAt = Date.now(); this.save()
      this.invalidate()
    }
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.polling }
}
module.exports = { MemoryConsolidation }
