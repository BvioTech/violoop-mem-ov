// Device standby: drain accepted native work before releasing local BGE.
// A pause is durable intent, never cancellation of an accepted memory task.
const fs = require('fs')
const path = require('path')
const { writeJson } = require('./durable_json')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
class BackgroundControl {
  constructor({ dataDir, app, client, runtime, retryMs = 1000 }) {
    this.file = path.join(dataDir, 'background-state.json')
    this.app = app; this.client = client; this.runtime = runtime; this.retryMs = retryMs
    this.paused = false; this.suspended = false; this.active = 0; this.pending = null; this.stopped = false; this.error = null
    // A corrupt state must not silently wake a device that requested standby.
    if (fs.existsSync(this.file)) {
      const state = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (typeof state.paused !== 'boolean') throw new Error('invalid background pause state')
      this.paused = state.paused
    }
    if (this.paused) this.app.setPaused(true)
  }
  status() {
    return { paused: this.paused, busy: !!this.pending || (this.paused && !this.suspended),
      ...(this.error ? { error: this.error } : {}) }
  }
  blocked() { return this.paused || this.suspended || !!this.pending }
  async run(fn) {
    if (this.blocked()) throw Object.assign(new Error('Memory background is paused or resuming'), { status: 503, code: 'background_paused' })
    this.active++
    try { return await fn() } finally { this.active-- }
  }
  setPaused(paused) {
    if (typeof paused !== 'boolean') throw Object.assign(new Error('paused must be boolean'), { status: 400, code: 'invalid_query' })
    if (this.stopped) throw Object.assign(new Error('Memory service is stopping'), { status: 503 })
    if (paused !== this.paused) {
      writeJson(this.file, { paused })
      this.paused = paused
      // Keep migration paused until BGE is actually ready on wake.
      if (paused) this.app.setPaused(true)
    }
    if ((paused && !this.suspended) || (!paused && this.suspended)) this.reconcile()
    return this.status()
  }
  reconcile() {
    if (this.pending || this.stopped) return
    this.pending = this.settle().finally(() => { this.pending = null })
  }
  async settle() {
    while (!this.stopped) {
      try {
        if (!this.paused) {
          await this.runtime.resume()
          if (this.stopped) return
          this.suspended = false
          if (this.paused) continue
          this.error = null; this.app.setPaused(false); return
        }
        // Complete HTTP submissions and journal transactions before asking the
        // engine to drain all durable queues, including vector follow-up work.
        if (this.active) { await sleep(this.retryMs); continue }
        await this.app.drainSubmissions()
        if (!this.paused || this.stopped) continue
        await this.client.waitProcessed()
        if (!this.paused || this.stopped) continue
        await this.runtime.suspend()
        this.suspended = true; this.error = null
        if (!this.paused) continue
        return
      } catch (err) {
        if (this.stopped) return
        this.error = err.message
        // A wait deadline is expected while accepted tasks finish. Never
        // replay them, and never report standby complete on a drain error.
        await sleep(this.retryMs)
      }
    }
  }
  async stop() { this.stopped = true; await this.pending }
}
module.exports = { BackgroundControl }
