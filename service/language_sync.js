// The paired PC owns the language preference. Never infer it from this
// service's locale/timezone: the Memory host can be in a different country.
const fs = require('fs')
const path = require('path')
const http = require('http')
const { writeJson } = require('./durable_json')

function normalizeLanguage(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 64) throw new Error('Missing or invalid language tag')
  const tag = value.trim().replace(/_/g, '-')
  if (/^(system|auto)$/i.test(tag)) throw new Error('System language has not been resolved')
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(tag)) throw new Error('Invalid language tag')
  const canonical = Intl.getCanonicalLocales(tag)[0]
  return canonical === 'zh' ? 'zh-CN' : canonical
}

function resolveLanguage(snapshot) {
  const selected = String(snapshot?.ui || '').trim()
  return normalizeLanguage(!selected || /^(system|auto)$/i.test(selected) ? snapshot?.resolved : selected)
}

function stateFile(dataDir) { return path.join(dataDir, 'language-state.json') }
function readLanguageState(dataDir) {
  try { return normalizeLanguage(JSON.parse(fs.readFileSync(stateFile(dataDir), 'utf8')).language) }
  catch (error) {
    if (error.code !== 'ENOENT') console.warn('[memory-language] ignoring invalid cached language')
    return null
  }
}

class LanguageSync {
  constructor({ dataDir, deviceUrl, apply, hold, logger = console, pollMs = 5000 }) {
    const base = new URL(deviceUrl)
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) {
      throw new Error('Language source must use HTTP on 127.0.0.1')
    }
    this.base = base; this.dataDir = dataDir; this.apply = apply; this.hold = hold; this.logger = logger; this.pollMs = pollMs
    this.desired = readLanguageState(dataDir); this.applied = null; this.active = 0; this.revision = 0
    this.closed = false; this.error = null; this.pending = null; this.requests = new Set()
    this.hold(true)
  }
  status() {
    return { ready: !this.closed && !this.pending && !!this.applied && this.applied === this.desired,
      language: this.applied, desired: this.desired, ...(this.error ? { error: this.error } : {}) }
  }
  async run(fn) {
    if (!this.status().ready) throw Object.assign(new Error('Memory language synchronization is pending'),
      { status: 503, code: 'language_pending' })
    this.active++
    try { return await fn() } finally { this.active-- }
  }
  start() {
    this.watch()
    void this.tick()
    void this.reconcile()
  }
  select(snapshot) {
    try {
      const language = resolveLanguage(snapshot)
      this.revision++
      this.desired = language
      if (this.applied === language && !this.pending) this.error = null
      if (this.applied !== language) this.hold(true)
      void this.reconcile()
    } catch (error) { this.report(error) }
  }
  report(error) {
    const message = error.message || 'Language synchronization failed'
    if (this.error !== message) this.logger.warn?.(`[memory-language] ${message}`)
    this.error = message
  }
  request(route, onResponse) {
    const req = http.get(new URL(route, this.base), onResponse)
    this.requests.add(req)
    req.once('close', () => this.requests.delete(req))
    return req
  }
  async refresh() {
    const revision = this.revision
    const snapshot = await new Promise((resolve, reject) => {
      const req = this.request('/settings/language', res => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`Language source returned HTTP ${res.statusCode}`)); return }
        let text = ''
        res.setEncoding('utf8')
        res.on('data', chunk => {
          text += chunk
          if (text.length > 8192) req.destroy(new Error('Language snapshot is too large'))
        })
        res.on('error', reject)
        res.on('end', () => { try { resolve(JSON.parse(text)) } catch { reject(new Error('Invalid language snapshot')) } })
      })
      req.setTimeout(2000, () => req.destroy(new Error('Language source timed out')))
      req.on('error', reject)
    })
    // An event received during the GET is newer than the in-flight snapshot.
    if (!this.closed && revision === this.revision) this.select(snapshot)
  }
  async tick() {
    try { await this.refresh() } catch (error) { if (!this.closed) this.report(error) }
    if (this.closed) return
    await this.reconcile()
    if (!this.closed) {
      this.timer = setTimeout(() => void this.tick(), this.pollMs)
      this.timer.unref()
    }
  }
  reconcile() {
    if (this.closed || this.pending || !this.desired) return this.pending || Promise.resolve()
    if (this.applied === this.desired) { this.hold(false); return Promise.resolve() }
    this.pending = (async () => {
      while (!this.closed && this.applied !== this.desired) {
        const language = this.desired
        try {
          await this.apply(language, () => this.closed)
          if (this.closed) return
          writeJson(stateFile(this.dataDir), { language })
          this.applied = language
          this.error = null
          this.logger.log?.(`[memory-language] OpenViking output language set to ${language}`)
        } catch (error) { if (!this.closed) this.report(error); return }
      }
      if (!this.closed && this.applied === this.desired) this.hold(false)
    })().finally(() => { this.pending = null })
    return this.pending
  }
  watch() {
    if (this.closed) return
    let buffer = ''; let data = []; let size = 0; let discard = false; let reconnecting = false
    const reconnect = () => {
      if (this.closed || reconnecting) return
      reconnecting = true
      this.watchTimer = setTimeout(() => { this.watch(); void this.refresh().catch(error => this.report(error)) }, this.pollMs)
      this.watchTimer.unref()
    }
    const req = this.request('/events', res => {
      if (res.statusCode !== 200) { res.resume(); reconnect(); return }
      res.setEncoding('utf8')
      res.on('data', chunk => {
        buffer += chunk
        let end
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1)
          if (!line) {
            if (!discard && data.length) {
              try {
                const event = JSON.parse(data.join('\n'))
                if (event.type === 'settings:language') this.select(event)
              } catch { /* Other event payloads are not language settings. */ }
            }
            data = []; size = 0; discard = false
          } else if (line.startsWith('data:') && !discard) {
            size += line.length
            if (size > 16384) { discard = true; data = [] }
            else data.push(line.slice(5).trimStart())
          }
        }
        if (buffer.length > 65536) { buffer = ''; discard = true }
      })
      res.on('end', reconnect); res.on('error', reconnect)
    })
    req.setTimeout(30000, () => req.destroy())
    req.on('error', reconnect); req.on('close', reconnect)
  }
  async stop() {
    this.closed = true
    clearTimeout(this.timer); clearTimeout(this.watchTimer)
    for (const req of this.requests) req.destroy()
    await this.pending
  }
}

module.exports = { LanguageSync, normalizeLanguage, resolveLanguage, readLanguageState }
