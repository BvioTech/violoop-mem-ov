const fs = require('fs')
const path = require('path')
const { readLegacySnapshot, hash, legacyFacts } = require('./legacy_source')
const { writeJson } = require('./durable_json')
const { startStage, appendTiming } = require('./migration_timing')

const SKIPPED_STATUSES = new Set(['failed'])
const AUTOMATIC_RETRY_DELAYS_MS = Object.freeze([10000, 30000, 60000])
const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 413, 415, 422])

function permanentFailure(error) {
  if (!error) return false
  if (typeof error === 'object') {
    const status = Number(error.upstreamStatus ?? error.status_code ?? error.statusCode ?? error.http_status ?? error.status)
    if (PERMANENT_HTTP_STATUSES.has(status)) return true
    for (const key of ['message', 'error', 'code', 'type']) {
      if (typeof error[key] === 'string' && permanentFailure(error[key])) return true
    }
    return false
  }
  const message = String(error)
  // Only explicit protocol errors: ordinary prose/numbers are not HTTP codes.
  const status = message.match(/\b(?:HTTP(?:\s+status)?|status(?:_code|\s+code)?|error\s+code)['"]?\s*[:=]?\s*['"]?(\d{3})\b/i)
  return (status && PERMANENT_HTTP_STATUSES.has(Number(status[1])))
    || /\b(?:AuthenticationError|PermissionDeniedError|BadRequestError|invalid_api_key|authentication_error|permission_denied|invalid_request_error|context_length_exceeded|model_not_found)\b/i.test(message)
}

class LegacyMigration {
  constructor({ dataDir, sourceFile = path.join(dataDir, 'graph.db'), client, journal, pollMs = 3000, autoResume = true,
    retryDelaysMs = AUTOMATIC_RETRY_DELAYS_MS, now = Date.now, coexistence = false }) {
    if (!Array.isArray(retryDelaysMs) || retryDelaysMs.length !== 3 || retryDelaysMs.some(ms => !Number.isFinite(ms) || ms < 0)) {
      throw new Error('Migration requires three non-negative automatic retry delays')
    }
    this.retryDelaysMs = [...retryDelaysMs]
    this.now = now
    this.coexistence = coexistence
    this.dir = path.join(dataDir, 'legacy-migration')
    this.file = path.join(this.dir, 'state.json')
    this.issuesFile = path.join(this.dir, 'issues.json')
    this.timingDir = path.join(this.dir, 'timings')
    this.sourceFile = sourceFile
    this.client = client
    this.journal = journal
    this.pollMs = pollMs
    this.state = null
    this.running = false
    this.starting = false
    this.stopped = false
    this.paused = false
    this.lastError = null
    this.timer = null
    try {
      if (fs.existsSync(this.file)) {
        this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        this.validate()
        if (autoResume) this.resume()
      }
    } catch (e) { this.loadError = e; this.lastError = { message: e.message, at: Date.now() } }
  }
  setPaused(paused) {
    this.paused = paused
    if (paused) clearTimeout(this.timer)
    else this.resume({ autoStart: true })
  }
  resume({ autoStart = false } = {}) {
    if (this.paused) return
    if (this.state?.started && !this.stopped && !this.loadError) {
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.run(), 0)
    } else if (this.coexistence && this.state && !this.state.activatedAt && !this.stopped && !this.loadError) {
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.checkSource(), this.pollMs)
    } else if (autoStart && !this.state && !this.stopped && !this.loadError && (this.coexistence || fs.existsSync(this.sourceFile))) {
      // First deployment starts automatically, after socket ownership is
      // established. Completed/failed rounds are never replayed on restart.
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.startAutomatically(), 0)
    }
  }
  async startAutomatically() {
    if (this.paused || this.stopped || this.state || this.starting || this.loadError) return
    try {
      // The managed engine may still be warming up after the adapter listens.
      if (!await this.client.ready() || !await this.client.migrationReady()) {
        if (!this.stopped) this.timer = setTimeout(() => this.startAutomatically(), this.pollMs)
        return
      }
      await this.start()
    } catch (err) {
      this.lastError = { message: err.message, at: Date.now() }
      if (!permanentFailure(err) && !this.stopped && !this.state && !this.loadError) this.timer = setTimeout(() => this.startAutomatically(), this.pollMs)
    }
  }
  validate() {
    const s = this.state
    if (!s || s.version !== 1 || s.scope !== hash(this.client.scope) || !Array.isArray(s.batches) || !Array.isArray(s.resources)) {
      throw new Error('Migration state is invalid or belongs to a different OpenViking scope')
    }
    if (s.automaticRetryCount !== undefined && (!Number.isInteger(s.automaticRetryCount) || s.automaticRetryCount < 0 || s.automaticRetryCount > 3)) {
      throw new Error('Invalid migration automatic retry count')
    }
    if (s.nextRetryAt !== undefined && (!Number.isFinite(s.nextRetryAt) || s.nextRetryAt < 0)) throw new Error('Invalid migration retry time')
    for (const b of s.batches) this.body(b)
  }
  originalBody(b) {
    if (!/^[a-f0-9]{64}$/.test(b.id)) throw new Error('Invalid migration batch ID')
    const text = fs.readFileSync(path.join(this.dir, 'batches', b.id + '.json'), 'utf8')
    if (hash(text) !== b.checksum) throw new Error(`Migration batch ${b.id} is damaged`)
    return JSON.parse(text)
  }
  body(b) {
    const original = this.originalBody(b)
    if (b.attempt === undefined || b.attempt === 0) return original
    if (!Number.isSafeInteger(b.attempt) || b.attempt < 1) throw new Error('Invalid migration retry attempt')
    const text = fs.readFileSync(path.join(this.dir, 'retries', b.id, b.attempt + '.json'), 'utf8')
    if (hash(text) !== b.retryChecksum) throw new Error(`Migration retry ${b.id}/${b.attempt} is damaged`)
    const body = JSON.parse(text)
    if (body.episode?.sessionId !== `${original.episode.sessionId}-retry-${b.attempt}`
      || JSON.stringify(body.episode.messages) !== JSON.stringify(original.episode.messages)) {
      throw new Error(`Migration retry ${b.id}/${b.attempt} does not match its source`)
    }
    return body
  }
  issue(b, index, attempt = b) {
    return { batch: index + 1, batchId: b.id, status: attempt.status,
      error: attempt.error || attempt.status, recordedAt: attempt.issueRecordedAt,
      taskId: attempt.taskId || null, ingestId: attempt.ingestId || null,
      sourceTokens: b.tokens, sourceGroups: b.groups,
      attempt: attempt.attempt || 0, trigger: attempt.trigger || 'primary' }
  }
  save() {
    const issues = this.state.batches.flatMap((b, index) => {
      if (!SKIPPED_STATUSES.has(b.status)) return []
      b.issueRecordedAt ||= Date.now()
      return [this.issue(b, index)]
    })
    const history = this.state.batches.flatMap((b, index) => (b.attempts || [])
      .filter(a => SKIPPED_STATUSES.has(a.status)).map(a => this.issue(b, index, a)))
    // Persist the problem record before saving progress past a skipped batch.
    if (issues.length || history.length || fs.existsSync(this.issuesFile)) {
      writeJson(this.issuesFile, { version: 1, scope: this.state.scope, batches: issues, history })
    }
    writeJson(this.file, this.state)
  }
  automaticRetryCount() {
    if (this.state?.automaticRetryCount !== undefined) return this.state.automaticRetryCount
    // In-progress receipts from the previous one-round policy keep that round.
    return this.state?.phase === 'automatic-retry' ? 1 : 0
  }
  automaticRetryCandidate(b) {
    return b.status === 'failed' && b.retryable !== false && !permanentFailure(b.error)
  }
  prepareRetries(trigger) {
    const automatic = trigger === 'automatic-retry'
    const failed = this.state.batches.filter(b => automatic ? this.automaticRetryCandidate(b) : b.status === 'failed')
    // Save inherited failures before moving them into the immutable attempt history.
    this.save()
    for (const b of failed) {
      const original = this.originalBody(b)
      const attempt = (b.attempt || 0) + 1
      const body = { ...original, episode: { ...original.episode,
        sessionId: `${original.episode.sessionId}-retry-${attempt}` } }
      // The new session changes the ingest identity, not the evidence or its time.
      writeJson(path.join(this.dir, 'retries', b.id, attempt + '.json'), body)
      const previous = { attempt: b.attempt || 0, trigger: b.trigger || 'primary', status: b.status }
      for (const key of ['ingestId', 'taskId', 'error', 'issueRecordedAt', 'startedAt', 'finishedAt', 'lastAttemptError', 'retryChecksum', 'retryable']) {
        if (b[key] !== undefined) previous[key] = b[key]
      }
      b.attempts ||= []
      b.attempts.push(previous)
      for (const key of ['ingestId', 'taskId', 'error', 'issueRecordedAt', 'startedAt', 'finishedAt', 'lastAttemptError', 'timingRecorded', 'retryable']) delete b[key]
      Object.assign(b, { attempt, trigger, retryChecksum: hash(JSON.stringify(body)), status: 'pending' })
    }
    this.state.automaticRetryCount = this.automaticRetryCount() + (automatic ? 1 : 0)
    this.state.phase = trigger
    this.state.automaticRetryDone = !automatic || this.state.automaticRetryCount >= 3
    delete this.state.nextRetryAt
    this.state.lastError = null
    this.lastError = null
    // Persist the whole retry round before any new upstream submission.
    this.save()
    return failed.length
  }
  lastIssue() {
    const b = this.state?.batches.filter(b => SKIPPED_STATUSES.has(b.status)).at(-1)
    return b ? { message: `Migration batch ${b.id} skipped (${b.status}): ${b.error || b.status}`,
      at: b.issueRecordedAt || null } : null
  }
  status() {
    if (this.loadError) throw this.loadError
    let pendingCount
    if (!this.state) {
      if (!fs.existsSync(this.sourceFile)) {
        return { backend: 'openviking', migration: true, enabled: true,
          pendingCount: 0, running: false, lastError: null, sourceAvailable: false,
          initialized: false, totalBatches: 0, completedBatches: 0, failedBatches: 0,
          activated: false, readyForCutover: !this.coexistence, sourceRevision: null }
      }
      if (this.inventoryCount === undefined) {
        const s = readLegacySnapshot(this.sourceFile)
        this.inventoryCount = s.memories.length + s.entities.length + s.relations.length
      }
      pendingCount = this.inventoryCount
    } else {
      const completed = new Set(this.state.batches.filter(b => b.status === 'completed').flatMap(b => b.claims))
      pendingCount = this.state.resources.filter(r => !r.claims.every(c => completed.has(c))).length
    }
    const sourceRevision = this.state?.sourceRevision || null
    const sourceCurrent = !this.coexistence || !!this.state?.activatedAt ||
      (sourceRevision && fs.existsSync(this.sourceFile) && hash(JSON.stringify(legacyFacts(readLegacySnapshot(this.sourceFile)))) === sourceRevision)
    const readyForCutover = !!this.state && !this.running && !this.starting && !this.state.started && !this.state.resetPending
      && this.state.batches.every(b => b.status === 'completed') && !this.lastError && !this.state.lastError && !!sourceCurrent
    return { backend: 'openviking', migration: true, enabled: true,
      activated: !!this.state?.activatedAt, activatedAt: this.state?.activatedAt || null,
      readyForCutover, sourceRevision, sourceCurrent: !!sourceCurrent,
      initialized: !!this.state, sourceAvailable: fs.existsSync(this.sourceFile),
      pendingCount: sourceCurrent ? pendingCount : Math.max(1, pendingCount), running: this.starting || this.running || !!this.state?.started, lastError: this.lastError || this.state?.lastError || this.lastIssue(),
      phase: this.state?.phase || null, automaticRetryDone: !!this.state?.automaticRetryDone,
      automaticRetryCount: this.automaticRetryCount(), automaticRetryLimit: 3, nextRetryAt: this.state?.nextRetryAt || null,
      totalBatches: this.state?.batches.length || 0,
      completedBatches: this.state?.batches.filter(b => b.status === 'completed').length || 0,
      failedBatches: this.state?.batches.filter(b => b.status === 'failed').length || 0,
      lastRunAt: this.state?.lastRunAt || null, lastTickAt: this.lastTickAt || null }
  }
  async activate(sourceRevision) {
    if (this.activating) return this.activating
    this.activating = this._activate(sourceRevision).finally(() => { this.activating = null })
    return this.activating
  }
  async _activate(sourceRevision) {
    if (this.state?.activatedAt) return this.status()
    if (!await this.client.ready()) throw Object.assign(new Error('OpenViking is not ready'), { status: 503 })
    // Edge holds its routing fence while this synchronous source check and
    // durable commit run. No legacy writes can cross the handoff boundary.
    const status = this.status()
    if (!status.readyForCutover || sourceRevision !== status.sourceRevision) {
      throw Object.assign(new Error('Legacy migration has not caught up'), { status: 409 })
    }
    if (!this.state) throw Object.assign(new Error('Migration has not initialized'), { status: 409 })
    this.state.activatedAt = Date.now()
    this.save()
    clearTimeout(this.timer)
    return this.status()
  }
  async checkSource() {
    if (this.paused || this.stopped || this.running || this.starting || this.state?.started || this.state?.activatedAt) return
    this.starting = true
    try {
      if (!this.state?.batches.every(b => b.status === 'completed')) return
      const snapshot = readLegacySnapshot(this.sourceFile)
      const facts = legacyFacts(snapshot), revision = hash(JSON.stringify(facts))
      if (revision === this.state.sourceRevision && !this.state.resetPending) { this.lastError = null; return }
      const current = new Set(facts)
      const reset = this.state.resetPending || !this.state.sourceFacts || this.state.sourceFacts.some(f => !current.has(f))
      if (reset) {
        // Only the migration-owned staging store may be rebuilt. Once active,
        // native user data must never be reset because the old daemon changed.
        if (!this.state.coexistence) throw new Error('Existing native migration requires handoff review')
        if (!this.state.resetPending) {
          this.state.resetPending = true
          this.state.generation = (this.state.generation || 0) + 1
          this.save()
        }
        await this.client.resetMigrationMemory()
      }
      const plan = require('./legacy_migration_plan').planMigration(snapshot)
      const previous = new Map(reset ? [] : this.state.batches.map(b => [b.id, b]))
      const generation = this.state.generation || 0
      const batches = plan.batches.map(b => {
        const id = generation ? hash(`${generation}:${b.id}`) : b.id
        if (previous.has(id)) return previous.get(id)
        const body = { episode: { sessionId: 'legacy-' + id, title: '旧记忆迁移', messages: b.messages } }
        writeJson(path.join(this.dir, 'batches', id + '.json'), body)
        return { id, checksum: hash(JSON.stringify(body)), claims: b.claims, groups: b.groups, tokens: b.tokens, status: 'pending' }
      })
      Object.assign(this.state, { batches, resources: plan.resources, sourceFacts: facts, sourceRevision: revision,
        resetPending: false, started: true, phase: 'catch-up', automaticRetryDone: false, automaticRetryCount: 0, lastError: null })
      this.lastError = null
      this.save()
    } catch (err) {
      this.lastError = { message: err.message, at: Date.now() }
    } finally {
      this.starting = false
      if (!this.stopped && !this.paused) {
        this.timer = setTimeout(() => this.state?.started ? this.run() : this.checkSource(), this.pollMs)
      }
    }
  }
  async start() {
    if (this.paused) throw Object.assign(new Error('Memory background is paused'), { status: 503 })
    if (this.loadError) throw this.loadError
    if (this.starting || this.running || this.state?.started) return { started: false, reason: 'busy' }
    this.starting = true
    try {
      if (this.stopped) throw new Error('Migration service is stopped')
      if (!await this.client.ready()) throw new Error('OpenViking is not ready')
      if (!await this.client.migrationReady()) throw new Error('OpenViking runtime must be upgraded for legacy memory migration')
      if (this.stopped) throw new Error('Migration service is stopped')
      if (this.paused) return { started: false, reason: 'paused' }
      if (!this.state) {
        const readDone = startStage(this.timingDir, 'planning', 'source.read_and_associate')
        let snapshot
        try { snapshot = readLegacySnapshot(this.sourceFile); readDone('ok', {
          memories: snapshot.memories.length, entities: snapshot.entities.length, relations: snapshot.relations.length,
        }) } catch (err) { readDone('error'); throw err }
        const { planMigration } = require('./legacy_migration_plan')
        const planDone = startStage(this.timingDir, 'planning', 'source.plan_and_tokenize')
        let plan
        try { plan = planMigration(snapshot); planDone('ok', { batches: plan.batches.length }) }
        catch (err) { planDone('error'); throw err }
        const persistDone = startStage(this.timingDir, 'planning', 'source.persist_batches')
        const batches = plan.batches.map(b => {
          const body = { episode: { sessionId: 'legacy-' + b.id, title: '旧记忆迁移', messages: b.messages } }
          const text = JSON.stringify(body)
          writeJson(path.join(this.dir, 'batches', b.id + '.json'), body)
          return { id: b.id, checksum: hash(text), claims: b.claims, groups: b.groups,
            tokens: b.tokens, status: 'pending' }
        })
        this.state = { version: 1, scope: hash(this.client.scope), sourceFile: this.sourceFile,
          snapshotHash: hash(JSON.stringify(snapshot)), tokenizer: plan.tokenizer,
          maxTokens: plan.maxTokens, resources: plan.resources, batches, started: false,
          phase: 'primary', automaticRetryDone: false, automaticRetryCount: 0 }
        if (this.coexistence) Object.assign(this.state, { coexistence: true, sourceFacts: legacyFacts(snapshot),
          sourceRevision: hash(JSON.stringify(legacyFacts(snapshot))) })
        persistDone('ok', { batches: batches.length })
        this.save()
      }
      this.validate()
      let retriedBatches = 0
      const runnable = this.state.batches.some(b => b.status !== 'completed' && !SKIPPED_STATUSES.has(b.status))
      if (!runnable) {
        if (this.state.batches.some(b => b.status === 'failed')) retriedBatches = this.prepareRetries('manual-retry')
        else { if (this.coexistence) this.resume(); return { started: false, reason: 'complete' } }
      }
      this.state.phase ||= 'primary' // Resume in-progress states from older releases.
      this.state.started = true
      this.state.lastError = null
      this.lastError = null
      this.save() // Persist user intent before doing any upstream work.
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.run(), 0)
      return { started: true, phase: this.state.phase, retriedBatches }
    } finally { this.starting = false }
  }
  async step(b) {
    const body = this.body(b)
    b.startedAt ||= Date.now()
    let receipt = await this.journal.lookup(body)
    if (['not_found', 'retryable'].includes(receipt.status)) {
      if (this.paused) return false
      b.status = 'submitting'; this.save()
      const done = startStage(this.timingDir, b.id, 'batch.submit', { batchId: b.id, sourceTokens: b.tokens,
        attempt: b.attempt || 0, trigger: b.trigger || 'primary' })
      try { receipt = await this.journal.ingest(body); done('ok', { taskId: receipt.taskId }) }
      catch (err) { done('error'); throw err }
    }
    b.ingestId = receipt.ingestId
    b.taskId = receipt.taskId
    b.status = receipt.status === 'completed' ? 'completed' : 'submitted'
    if (['failed', 'cancelled'].includes(receipt.status)) {
      b.status = receipt.status
      const taskError = receipt.task?.error || receipt.task?.result?.error || receipt.error
      b.error = (typeof taskError === 'object' ? JSON.stringify(taskError) : taskError) || receipt.status
      if (receipt.status === 'failed') b.retryable = ![receipt.task, receipt.task?.result, taskError].some(permanentFailure)
      b.finishedAt = Date.now()
      this.save()
      if (SKIPPED_STATUSES.has(b.status)) return true
      throw Object.assign(new Error(`Migration batch ${b.id}: ${b.error}`), { pauseMigration: true })
    }
    if (!['accepted', 'pending', 'queued', 'running', 'processing', 'completed'].includes(receipt.status)) {
      throw new Error(`Unknown migration task status: ${receipt.status}`)
    }
    b.error = null
    if (b.status === 'completed' && !b.timingRecorded) {
      b.finishedAt = Date.now()
      appendTiming(this.timingDir, b.id, { event: 'batch.completed', batchId: b.id, taskId: b.taskId,
        attempt: b.attempt || 0, trigger: b.trigger || 'primary',
        sourceTokens: b.tokens, processingSeconds: receipt.task?.processing_seconds,
        taskCreatedAt: receipt.task?.created_at, taskUpdatedAt: receipt.task?.updated_at })
      b.timingRecorded = true
    }
    this.save()
    return b.status === 'completed'
  }
  async run() {
    if (this.paused || this.running || this.stopped || !this.state?.started || this.loadError) return
    clearTimeout(this.timer)
    this.timer = null
    this.running = true
    try {
      this.validate()
      if (this.state.nextRetryAt > this.now()) return
      // Also record failures saved by older versions before moving past them.
      if (this.state.batches.some(b => SKIPPED_STATUSES.has(b.status))) this.save()
      if (!await this.client.ready()) throw Object.assign(new Error('OpenViking is not ready'), { retryMigration: true })
      if (!await this.client.migrationReady()) throw Object.assign(new Error('OpenViking runtime must be upgraded for legacy memory migration'), { retryMigration: true })
      if (this.paused) return
      this.state.lastRunAt = Date.now()
      while (!this.paused && !this.stopped && this.state.started) {
        this.lastTickAt = Date.now()
        const b = this.state.batches.find(b => b.status !== 'completed' && !SKIPPED_STATUSES.has(b.status))
        if (!b) {
          if (!this.state.automaticRetryDone && this.state.phase !== 'manual-retry') {
            if (this.automaticRetryCount() < 3 && this.state.batches.some(b => this.automaticRetryCandidate(b))) {
              if (this.state.nextRetryAt === undefined) {
                this.state.nextRetryAt = this.now() + this.retryDelaysMs[this.automaticRetryCount()]
                this.save()
              }
              if (this.state.nextRetryAt > this.now()) break
              this.prepareRetries('automatic-retry')
              continue
            }
            this.state.automaticRetryDone = true
          }
          delete this.state.nextRetryAt
          this.state.started = false; this.state.lastError = null; this.lastError = null; this.save(); break
        }
        try {
          if (await this.step(b)) { this.lastError = null; this.state.lastError = null; continue }
        } catch (e) {
          this.lastError = this.state.lastError = { message: e.message, at: Date.now() }
          b.lastAttemptError = this.lastError
          if (e.pauseMigration || permanentFailure(e)) this.state.started = false
          this.save()
        }
        // Network recovery re-checks this exact durable attempt. Failed batches
        // only get fresh identities at a retry-round boundary, never here.
        // Submission failures use the same bounded retry rounds; cancellation pauses the run.
        break
      }
    } catch (e) {
      this.lastError = { message: e.message, at: Date.now() }
      if (permanentFailure(e)) {
        this.state.started = false; this.state.lastError = this.lastError; this.save()
      } else if (e.retryMigration || e.code === 'upstream_unavailable' || e.code === 'upstream_error') {
        this.state.lastError = this.lastError; this.save()
      } else this.loadError = e // Damaged state must not be reconstructed silently.
    } finally {
      this.running = false
      if (!this.paused && !this.stopped && this.state?.started && !this.loadError) {
        const delay = this.state.nextRetryAt > this.now() ? this.state.nextRetryAt - this.now() : this.pollMs
        this.timer = setTimeout(() => this.run(), delay)
      } else if (this.coexistence && !this.paused && !this.stopped && !this.state?.activatedAt && !this.loadError) {
        this.timer = setTimeout(() => this.checkSource(), this.pollMs)
      }
    }
  }
  stop() { this.stopped = true; clearTimeout(this.timer) }
}

module.exports = { LegacyMigration }
