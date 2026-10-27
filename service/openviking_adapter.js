const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { createEntries } = require('./openviking_entries')
const { validateVikingUri } = require('./openviking_uri')
const { keywordsPattern, mergeSearch } = require('./hybrid_search')
const { PREVIEW_CHARS, boundPreviews } = require('./retrieval_budget')
const { searchOptions, createMutations, enrich, metadata, levelOf, canonical } = require('./openviking_agent')

const MAX_BODY_BYTES = 10 * 1024 * 1024
const TRIVIAL_RE = /^(continue|go on|next|ok(ay)?|yep|yes|no|sure|done|thx|thanks?|嗯+|哦+|好+的?|继续|行|对|是的?|可以|没事了?|不用了?|算了)[\s.!~。！？]*$/i
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status })
const hash = value => createHash('sha256').update(value).digest('hex')

function integer(value, fallback, max = 50) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 0 || value > max) throw fail('invalid_query', `limit must be an integer in [0, ${max}]`)
  return value
}
function query(value, name = 'query') {
  if (typeof value !== 'string' || !value.trim()) throw fail('invalid_query', `${name} must be a non-empty string`)
  return value.trim().slice(0, 6000)
}
function uri(value) {
  validateVikingUri(value)
  if (value === 'viking://') return value
  return value.replace(/\/(\.abstract|\.overview)\.md$/, '').replace(/\/$/, '')
}
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}'
  return JSON.stringify(value)
}
async function readJson(req) {
  const chunks = await new Promise((resolve, reject) => {
    let size = 0, oversized = false
    const buffered = []
    req.on('data', chunk => {
      if (oversized) return // drain without retaining more input
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        oversized = true
        buffered.length = 0
        reject(fail('invalid_query', 'request body too large', 413))
      } else buffered.push(chunk)
    })
    req.on('end', () => { if (!oversized) resolve(buffered) })
    req.on('error', reject)
    req.on('aborted', () => reject(fail('invalid_query', 'request aborted')))
  })
  let body
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw fail('invalid_query', 'invalid JSON body') }
  if (!body || Array.isArray(body) || typeof body !== 'object') throw fail('invalid_query', 'JSON object required')
  return body
}

function flatten(result, limit, maxChars) {
  if (!result || !['memories', 'resources', 'skills'].every(k => Array.isArray(result[k]))) {
    throw fail('upstream_error', 'invalid OpenViking retrieval result', 502)
  }
  const seen = new Set()
  return [...result.memories, ...result.resources, ...result.skills]
    .filter(h => h && typeof h.uri === 'string' && h.uri.startsWith('viking://') && Number.isFinite(h.score))
    .sort((a, b) => b.score - a.score)
    .filter(h => { const key = uri(h.uri); if (seen.has(key)) return false; seen.add(key); return true })
    .slice(0, limit)
    .map(h => {
      const full = typeof h.abstract === 'string' ? h.abstract : ''
      const heading = String(full).match(/^#+\s+(.+)$/m)?.[1]
      const title = heading || String(h.abstract || '').split('\n')[0] || h.uri.split('/').pop()
      return {
        key: uri(h.uri), uri: uri(h.uri), title: title.slice(0, 120),
        abstract: String(full).slice(0, maxChars), content: String(full).slice(0, maxChars), score: h.score,
        contextType: h.context_type, level: h.level,
        ...(Array.isArray(h.tags) ? { tags: h.tags } : {}),
        truncated: String(full).length > maxChars,
      }
    })
}
function entity(hit, recall = false) {
  // This is a wire envelope for a document, never a persisted graph entity.
  const chars = recall ? 160 : 400
  const observations = []
  for (let i = 0; i < hit.content.length && observations.length < 5; i += chars) observations.push(hit.content.slice(i, i + chars))
  return {
    id: hit.uri, name: hit.title, type: 'memory', aliases: [], domains: [],
    observations, relations: [], matchedBy: 'semantic', score: hit.score,
    uri: hit.uri, key: hit.key, truncated: hit.truncated,
  }
}

function episodeMessages(body) {
  const ep = body.episode
  if (!ep || typeof ep !== 'object' || Array.isArray(ep)) throw fail('missing_field', 'episode is required')
  if (ep.messages !== undefined && !Array.isArray(ep.messages)) throw fail('invalid_input', 'episode.messages must be an array')
  if (ep.sessionId !== undefined && typeof ep.sessionId !== 'string') throw fail('invalid_input', 'episode.sessionId must be a string')
  for (const field of ['entities', 'relations']) {
    if (body[field] !== undefined && !Array.isArray(body[field])) throw fail('invalid_input', `${field} must be an array`)
  }
  const messages = (ep.messages || []).map(m => {
    if (!m || typeof m.content !== 'string' || !m.content.trim()) throw fail('invalid_input', 'each message requires non-empty string content')
    const role = ['user', 'assistant', 'system', 'tool'].includes(m.role) ? m.role : 'user'
    let createdAt = m.createdAt
    // Device episode_extractor sends created_at in milliseconds; native
    // AddMessageRequest expects a string. Preserve historical message time.
    if (typeof createdAt === 'number') {
      if (!Number.isFinite(new Date(createdAt).getTime())) throw fail('invalid_input', 'invalid message createdAt')
      createdAt = new Date(createdAt).toISOString()
    }
    if (createdAt !== undefined && typeof createdAt !== 'string') throw fail('invalid_input', 'message createdAt must be a string or millisecond timestamp')
    // Source/note records remain explicitly marked as evidence.
    return {
      role, content: role === m.role ? m.content : `[${String(m.role || 'source')}] ${m.content}`,
      ...(createdAt === undefined ? {} : { created_at: createdAt }),
      ...(m.id !== undefined ? { source_message_ids: [String(m.id)] } : {}),
    }
  })
  if (!messages.length) {
    // Older screen distillation / graph_observe / graph_link send no raw turns.
    // Preserve their facts as labelled source text for native extraction.
    const supplied = { title: ep.title, summary: ep.summary, entities: body.entities || [], relations: body.relations || [], excerpts: body.excerpts || {} }
    if (!ep.summary && !supplied.entities.length && !supplied.relations.length) throw fail('invalid_input', 'ingest requires messages, summary, observations or relations')
    messages.push({ role: 'user', content: '[Imported device evidence; observations may be inferred, not statements by the user]\n' + JSON.stringify(supplied) })
  }
  // Keep source metadata in the ingest journal, not in the conversation:
  // OpenViking derives Session Time from the first and last messages.
  return messages
}

class IngestJournal {
  constructor(client, dataDir, onTerminal) {
    this.client = client
    this.dir = path.join(dataDir, 'openviking-adapter', 'ingests')
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    this.pending = new Map()
    this.onTerminal = onTerminal
    this.watching = new Set()
    this.timer = null
    this.monitor = null
    this.stopped = false
    this.monitorEnabled = false
  }
  read(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw fail('invalid_input', 'invalid ingest ID')
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, id + '.json'), 'utf8')) } catch (err) {
      if (err.code === 'ENOENT') return null
      throw err
    }
  }
  save(record) {
    const dest = path.join(this.dir, record.id + '.json')
    require('./durable_json').writeJson(dest, record)
  }
  async lookup(body) {
    episodeMessages(body)
    const id = hash(this.client.scope + '\n' + stable(body))
    if (this.pending.has(id)) {
      try { await this.pending.get(id) } catch { /* Read the durable outcome. */ }
    }
    return this.read(id) ? this.status(id) : { ingestId: id, status: 'not_found' }
  }
  async ingest(body) {
    const messages = episodeMessages(body)
    const id = hash(this.client.scope + '\n' + stable(body))
    if (this.pending.has(id)) return this.pending.get(id)
    const promise = this.submit(id, body, messages)
    this.pending.set(id, promise)
    try { return await promise } finally { this.pending.delete(id) }
  }
  async submit(id, body, messages) {
    let record = this.read(id)
    if (record?.result) { if (!record.terminal) this.watch(id); return { ...record.result, duplicate: true } }
    if (record && ['batch_started', 'commit_started'].includes(record.phase)) {
      throw fail('ingest_uncertain', `prior upstream write may have succeeded; inspect native session ${record.sessionId} before retrying ingest ${id}`, 409)
    }
    const migration = messages.length && messages.every(m => m.source_message_ids?.length
      && m.source_message_ids.every(id => id.startsWith('violoop-legacy-migration:')))
    record ||= { id, sessionId: (migration ? 'vm-legacy-' : 'vm-') + id, sourceSessionId: body.episode.sessionId || null, createdAt: new Date().toISOString(), phase: 'new', messagesWritten: 0 }
    // Native batch API has a hard cap of 100 messages.
    // Persist before every write; a timeout must never blindly replay a batch.
    while ((record.messagesWritten || 0) < messages.length) {
      const offset = record.messagesWritten || 0
      const batch = messages.slice(offset, offset + 100)
      record.phase = 'batch_started'
      this.save(record)
      await this.client.addMessages(record.sessionId, batch)
      record.messagesWritten = offset + batch.length
      record.phase = 'messages_written'
      this.save(record)
    }
    record.phase = 'commit_started'
    this.save(record)
    const commit = await this.client.commit(record.sessionId)
    if (!commit || typeof commit.task_id !== 'string') throw fail('upstream_error', 'OpenViking commit did not return a task_id; inspect native session before retry', 502)
    record.phase = 'accepted'
    record.result = {
      backend: 'openviking', status: 'accepted', ingestId: id,
      sessionId: record.sessionId, taskId: commit.task_id, archiveUri: commit.archive_uri || null,
      episode: { id, sessionId: body.episode.sessionId || record.sessionId },
      entities: [], relations: [],
    }
    this.save(record)
    this.watch(id)
    return record.result
  }
  watch(id) {
    this.watching.add(id)
    if (!this.onTerminal || !this.monitorEnabled || this.stopped || this.timer || this.monitor) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.monitor = this.poll().finally(() => {
        this.monitor = null
        if (this.watching.size && !this.stopped) this.watch([...this.watching][0])
      })
    }, 2000)
    this.timer.unref()
  }
  async poll() {
    for (const id of [...this.watching]) {
      if (this.stopped) break
      try { await this.status(id) }
      catch (err) { console.warn('[memory-graph] pending task check failed:', err.message) }
    }
  }
  resume() {
    if (!this.onTerminal || this.stopped) return
    this.monitorEnabled = true
    for (const file of fs.readdirSync(this.dir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue
      try {
        const record = this.read(file.slice(0,-5))
        if (record?.result && (!record.terminal || record.graphPending)) this.watch(record.id)
      } catch (err) { console.warn('[memory-graph] pending receipt could not be read:', err.message) }
    }
    if (this.watching.size) this.watch([...this.watching][0])
  }
  async stop() {
    this.stopped = true
    clearTimeout(this.timer)
    await this.monitor
  }
  async finish(record) {
    if (!this.onTerminal || (record.graphProjected && !record.graphPending)) return true
    record.graphPending = true
    this.save(record)
    try {
      await this.onTerminal(record)
      delete record.graphPending
      record.graphProjected = true
      this.save(record)
      return true
    } catch (err) {
      // Graph projection failure must not turn a completed native extraction
      // into a failed/replayed extraction. Keep a durable retry flag instead.
      console.warn('[memory-graph] completion update pending:', err.message)
      return false
    }
  }
  async status(id) {
    const record = this.read(id)
    if (!record) throw fail('not_found', 'ingest not found', 404)
    if (!record.result) return { ingestId: id, sessionId: record.sessionId,
      status: ['batch_started', 'commit_started'].includes(record.phase) ? 'uncertain' : 'retryable',
      phase: record.phase, messagesWritten: record.messagesWritten || 0 }
    if (record.terminal) {
      if (await this.finish(record)) this.watching.delete(id)
      return { ...record.result, ...record.terminal }
    }
    let task
    try { task = await this.client.task(record.result.taskId) } catch (e) {
      if (e.upstreamStatus !== 404) throw e
      task = { status: 'uncertain', error: 'Native task missing and no terminal archive marker found' }
      if (record.result.archiveUri) for (const [file, state, field] of [
        ['.done', 'completed', 'ending_message_id'], ['.failed.json', 'failed', 'error'],
      ]) {
        try {
          const marker = JSON.parse(await this.client.read(record.result.archiveUri + '/' + file, 2, { limit: -1 }))
          if (marker && Object.hasOwn(marker, field)) { task = { status: state, recoveredFrom: 'archive', result: marker }; break }
        } catch (readError) { if (readError.upstreamStatus !== 404) throw readError }
      }
    }
    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      record.terminal = { status: task.status, task }
      this.save(record)
      if (await this.finish(record)) this.watching.delete(id)
    }
    return { ...record.result, status: task.status, task }
  }
}

function createApp(client, { dataDir, recallMaxChars = 2500, searchMaxChars = 8000,
  abstractMaxChars = 600, readMaxChars = 6000, legacySourceFile } = {}) {
  if (!dataDir) throw new Error('adapter dataDir is required')
  for (const value of [recallMaxChars, searchMaxChars, abstractMaxChars, readMaxChars]) {
    if (!Number.isInteger(value) || value < 1 || value > 100000) throw new Error('content limits must be integers in [1, 100000]')
  }
  const graph = new (require('./openviking_graph').OpenVikingGraph)(client, { dataDir })
  const journal = new IngestJournal(client, dataDir, async record => {
    try {
      if (record.terminal.status !== 'completed') return
      if (graph.hasCompletion(record.id)) {
        await graph.sync(); graph.completionErrors.delete(record.id); return
      }
      const archive = record.result.archiveUri
      const artifact = record.terminal.task?.result?.memory_diff_uri || (archive ? archive + '/memory_diff.json' : null)
      let changed = []
      if (artifact) {
        try {
          const diff = JSON.parse(await client.read(artifact, 2, { limit: -1 }))
          if (Array.isArray(diff.changed_uris)) changed = diff.changed_uris
          else {
            // One-time compatibility for already-completed old-version tasks;
            // current extraction results always include the complete URI list.
            await graph.sync(true)
            if (graph.error) throw new Error(graph.error)
          }
        } catch (err) { if (err.upstreamStatus !== 404) throw err }
      }
      await graph.completion(record.id, changed)
      graph.completionErrors.delete(record.id)
    } catch (err) {
      graph.completionErrors.set(record.id, err.message || 'Completed memory changes could not be indexed')
      throw err
    }
  })
  const migration = new (require('./legacy_migration').LegacyMigration)({ dataDir,
    ...(legacySourceFile ? { sourceFile: legacySourceFile } : {}), client, journal, autoResume: false })
  const entries = createEntries(client)
  const consolidation = new (require('./openviking_consolidation').MemoryConsolidation)(client, graph,
    { dataDir, invalidate: () => entries.invalidate() })
  const nativeMutate = createMutations(client, () => entries.invalidate())
  const manual = require('./openviking_manual')
  const mutate = async (...args) => {
    const result = await nativeMutate(...args)
    // These API writes have already persisted the file when they return.
    // Indexing stays separate from the native vector-processing task.
    graph.queueCompletion(hash('write:' + process.hrtime.bigint()), [
      result.uri.replace('viking://~/', `viking://user/${client.user}/`),
    ])
    return result
  }
  async function nativeRetrieve(q, options) {
    try { return await client.retrieve(q, options) }
    catch (e) {
      if ([400, 422].includes(e.upstreamStatus)) throw fail('invalid_query', e.message)
      throw e
    }
  }
  const json = (res, status, value) => {
    const body = JSON.stringify(value)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }
  async function retrieve(body, mode, requestedLimit) {
    if (!['recall', 'search'].includes(mode)) throw fail('invalid_query', 'mode must be recall or search')
    const pattern = keywordsPattern(body.keywords)
    const options = searchOptions(body, client, { automatic: mode === 'recall' })
    if (mode === 'recall' && pattern) throw fail('invalid_query', 'keywords are only supported by search')
    let q = query(body.query)
    const requested = integer(requestedLimit ?? body.limit, 10)
    const limit = mode === 'recall' || pattern ? Math.min(requested, 10) : requested
    // No default score floor. Explicit caller thresholds remain wire-compatible.
    const minScore = body.minScore ?? body.minSim
    if (minScore !== undefined && !Number.isFinite(minScore)) throw fail('invalid_query', 'minScore must be finite')
    const targetUri = body.targetUri || body.prefix
    if (targetUri !== undefined && (typeof targetUri !== 'string' || !targetUri.startsWith('viking://'))) {
      throw fail('unsupported_prefix', 'prefix/targetUri must be a viking:// URI; legacy dotted namespaces are not available')
    }
    if (targetUri !== undefined) validateVikingUri(targetUri)
    if (body.sessionId !== undefined && typeof body.sessionId !== 'string') throw fail('invalid_query', 'sessionId must be a string')
    if (!limit) return []
    if (mode === 'recall') {
      q = q.slice(0, 600)
      if (q.length < 8 || TRIVIAL_RE.test(q)) return []
    }
    const level = body.level === undefined ? undefined : integer(body.level, 0, 2)
    if (pattern) {
      // Both branches use the same explicit scope. With keywords, the default
      // is the user's memories; no-keyword calls retain native default scope.
      const scope = targetUri || 'viking://~/memories'
      const [result, grep] = await Promise.all([
        nativeRetrieve(q, { ...options, mode, limit, minScore, targetUri: scope, sessionId: body.sessionId, level }),
        runGrep({ pattern, prefix: scope, limit: Math.min(50, Math.max(10, limit * 4)), caseInsensitive: true }),
      ])
      const semantic = flatten(result, limit, PREVIEW_CHARS).filter(h => minScore === undefined || h.score >= minScore)
      let matches = grep.result.matches
      // grep has no time/type predicates. Check candidates against native
      // filter-only find, separately per level (find deduplicates by URI).
      if (options.filter || options.tags?.length || options.since || options.until || options.contextType) {
        const eligible = new Set()
        await Promise.all([0, 1, 2].filter(l => level === undefined || l === level).map(async l => {
          const candidates = [...new Set(matches.filter(m => levelOf(m.uri) === l).map(m => canonical(m.uri)))]
          if (!candidates.length) return
          const filtered = await nativeRetrieve('', { ...options, includeProvenance: false, mode: 'recall',
            eventsTimeDecayProtection: undefined, // Filter-only eligibility has no semantic score to decay.
            targetUri: scope, level: l, limit: candidates.length,
            filter: options.filter ? { op: 'and', conds: [options.filter,
              { op: 'must', field: 'uri', conds: candidates, para: '-d=0' }] }
              : { op: 'must', field: 'uri', conds: candidates, para: '-d=0' } })
          for (const h of flatten(filtered, candidates.length, 0)) eligible.add(l + ':' + h.uri)
        }))
        matches = matches.filter(m => eligible.has(levelOf(m.uri) + ':' + canonical(m.uri)))
      }
      return enrich(client, mergeSearch(semantic, matches, { limit, maxChars: searchMaxChars, level }), result, options.includeProvenance)
    }
    const result = await nativeRetrieve(q, { ...options, mode, limit, minScore, targetUri, sessionId: body.sessionId, level })
    const hits = flatten(result, limit, PREVIEW_CHARS)
      .filter(h => minScore === undefined || h.score >= minScore)
    return enrich(client, boundPreviews(hits, mode === 'recall' ? recallMaxChars : searchMaxChars), result, options.includeProvenance)
  }
  async function readMemory(key, params) {
    const requestedUri = uri(key)
    const level = integer(params.level, 1, 2)
    const offset = integer(params.offset, 0, 100000000)
    const limit = integer(params.limit, 80, 200)
    const charOffset = integer(params.charOffset, 0, 100000000)
    if (!limit) throw fail('invalid_query', 'limit must be positive')
    const info = await client.stat(requestedUri)
    const isDir = info.isDir ?? info.is_dir ?? info.type === 'directory'
    const resolvedUri = level < 2 && !isDir ? requestedUri.slice(0, requestedUri.lastIndexOf('/')) : requestedUri
    if (level === 2 && isDir) return { backend: 'openviking', key: requestedUri, uri: requestedUri,
      level, kind: 'directory', content: '', hint: 'Use memory.list on this URI, then memory.get(level=2) on a file URI.' }
    if (level < 2 && offset) throw fail('invalid_query', 'line offset is only supported for L2')
    const text = await client.read(resolvedUri, level, { offset, limit })
    if (typeof text !== 'string') throw fail('upstream_error', 'invalid native content response', 502)
    const cap = level === 0 ? abstractMaxChars : readMaxChars
    const content = text.slice(charOffset, charOffset + cap)
    const truncated = charOffset + content.length < text.length
    const lineCount = text ? text.replace(/\n$/, '').split('\n').length : 0
    const next = truncated ? { level, offset, limit, charOffset: charOffset + content.length }
      : level === 2 && lineCount === limit ? { level, offset: offset + lineCount, limit, charOffset: 0 } : null
    return { backend: 'openviking', key: resolvedUri, uri: resolvedUri, requestedUri, level,
      kind: level < 2 ? 'directory' : 'file', content, truncated, hasMore: !!next, next,
      ...(params.includeProvenance ? metadata(await client.attrs(resolvedUri)) : {}) }
  }
  async function runGrep(body) {
    if (typeof body.pattern !== 'string' || !body.pattern.trim() || body.pattern.length > 1000) {
      throw fail('invalid_pattern', 'pattern must be a non-empty regex string of at most 1000 characters')
    }
    const target = validateVikingUri(body.prefix ?? body.uri ?? 'viking://~/memories')
    const limit = integer(body.limit, 10)
    const caseInsensitive = body.caseInsensitive ?? false
    if (typeof caseInsensitive !== 'boolean') throw fail('invalid_query', 'caseInsensitive must be boolean')
    if (!limit) return { target, limit, result: { matches: [], files_scanned: 0 } }
    let result
    try { result = await client.grep(body.pattern, { uri: target, limit, caseInsensitive }) }
    catch (err) {
      if ([400, 422].includes(err.upstreamStatus)) throw fail('invalid_pattern', err.message, 400)
      if (err.upstreamStatus === 404) throw fail('not_found', 'Memory grep scope not found', 404)
      throw err
    }
    if (!Array.isArray(result?.matches) || result.matches.some(m => !m || typeof m.uri !== 'string'
      || !m.uri.startsWith('viking://') || !Number.isInteger(m.line) || m.line < 1 || typeof m.content !== 'string')) {
      throw fail('upstream_error', 'invalid native grep response', 502)
    }
    return { result, target, limit }
  }
  async function grepMemory(body) {
    const { result, target, limit } = await runGrep(body)
    const hits = result.matches.slice(0, limit)
    const perHitChars = hits.length ? Math.min(600, Math.floor(6000 / hits.length)) : 600
    const matches = hits.map(m => ({ uri: m.uri, line: m.line,
      level: m.uri.endsWith('/.abstract.md') ? 0 : m.uri.endsWith('/.overview.md') ? 1 : 2,
      content: m.content.slice(0, perHitChars), truncated: m.content.length > perHitChars }))
    return { backend: 'openviking', uri: target, pattern: body.pattern, matches, count: matches.length,
      limited: limit > 0 && result.matches.length >= limit, truncated: result.matches.length > limit || matches.some(m => m.truncated),
      filesScanned: Number.isFinite(result.files_scanned) ? result.files_scanned : null }
  }
  const app = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const p = url.pathname.replace(/\/$/, '')
      if (req.method === 'GET' && p === '/v2/memory/consolidation/status') return json(res, 200, consolidation.status())
      if (req.method === 'POST' && p === '/v2/memory/consolidation/start') return json(res, 202, await consolidation.start())
      if (req.method === 'POST' && p === '/v2/graph/sync' && url.searchParams.get('view') === 'memory') {
        return json(res, 202, graph.startSync())
      }
      if (req.method === 'GET') {
        if (p === '/v2/graph/status' && url.searchParams.get('view') === 'memory') {
          return json(res, 200, await graph.status())
        }
        // Explicit presentation-only view. Existing graph callers (prompts,
        // consolidator, retrieval) must not consume this document projection.
        if (p === '/v2/graph/export' && url.searchParams.get('view') === 'memory') {
          const limit = integer(url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined, 5000, 10000)
          return json(res, 200, await graph.export({ limit,
            skeleton: url.searchParams.get('skeleton') !== '0',
            revision: url.searchParams.get('revision'), rebuild: url.searchParams.get('rebuild') === '1' }))
        }
        if (p === '/v2/graph/details' && url.searchParams.get('view') === 'memory') {
          return json(res, 200, await graph.detail(query(url.searchParams.get('id'), 'id')))
        }
        if (p === '/healthz') return json(res, 200, { status: 'ok', backend: 'openviking' })
        if (p === '/v2/migration/status') {
          try { return json(res, 200, migration.status()) }
          catch (e) { throw fail('migration_unavailable', e.message, 503) }
        }
        if (p === '/readyz') {
          try {
            const ready = await client.ready()
            return json(res, ready ? 200 : 503, { ready, backend: 'openviking' })
          } catch { return json(res, 503, { ready: false, backend: 'openviking' }) }
        }
        if (p === '/v1/memory-entries') {
          return json(res, 200, { backend: 'openviking', items: await entries.list() })
        }
        const entry = p.match(/^\/v1\/memory-entries\/(.+)$/)
        if (entry) return json(res, 200, await entries.get(decodeURIComponent(entry[1])))
        const ingest = p.match(/^\/v2\/ingests\/([a-f0-9]{64})$/)
        if (ingest) return json(res, 200, await journal.status(ingest[1]))
        const task = p.match(/^\/v2\/tasks\/([^/]+)$/)
        if (task) return json(res, 200, { backend: 'openviking', task: await client.task(decodeURIComponent(task[1])) })
        const memory = p.match(/^\/v1\/memories\/(.+)$/)
        if (memory) {
          const params = Object.fromEntries(['level', 'offset', 'limit', 'charOffset'].map(k => [k,
            url.searchParams.has(k) ? Number(url.searchParams.get(k)) : undefined]))
          if (url.searchParams.has('includeProvenance')) {
            if (!['true', 'false'].includes(url.searchParams.get('includeProvenance'))) throw fail('invalid_query', 'includeProvenance must be boolean')
            params.includeProvenance = url.searchParams.get('includeProvenance') === 'true'
          }
          return json(res, 200, await readMemory(decodeURIComponent(memory[1]), params))
        }
        if (p === '/v1/memories' && url.searchParams.get('prefix')?.startsWith('viking://')) {
          const prefix = uri(url.searchParams.get('prefix'))
          const offset = integer(url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : undefined, 0, 100000000)
          const limit = integer(url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined, 20, 50)
          if (!limit) throw fail('invalid_query', 'limit must be positive')
          const listing = await client.list(prefix, { offset, limit })
          if (!Array.isArray(listing.result)) throw fail('upstream_error', 'invalid native directory response', 502)
          return json(res, 200, { backend: 'openviking', uri: prefix, items: listing.result,
            hasMore: !!listing.has_more, nextOffset: listing.has_more ? offset + listing.result.length : null })
        }
        // Device boot reads these catalogues. There is no old tree/graph to list.
        const catalogues = {
          '/v1/memories': { items: [] }, '/v1/tree/simple': { flat: [] }, '/v1/zones': { zones: [] },
          '/v2/graph/export': { entities: [], relations: [] }, '/v2/domains': { domains: [] },
          '/v2/entities/dirty': { entities: [] },
        }
        if (catalogues[p]) return json(res, 200, { ...catalogues[p], backend: 'openviking' })
      }
      if (req.method === 'POST' && p === '/v1/memory-entries/preview') {
        return json(res, 200, await manual.previewMemory(await readJson(req), client))
      }
      if (req.method === 'POST' && p === '/v1/memory-entries') {
        const body = await readJson(req), plan = manual.planMemory(body, client)
        return json(res, 201, await mutate('create', plan.uri, { content: manual.serializeMemory(plan, body.content) }))
      }
      const panelMutation = p.match(/^\/v1\/memory-entries\/(.+)$/)
      if (req.method === 'PATCH' && panelMutation) {
        return json(res, 200, await mutate('replace', decodeURIComponent(panelMutation[1]), await readJson(req)))
      }
      if (req.method === 'POST' && p === '/v1/memories') {
        const body = await readJson(req)
        return json(res, 201, await mutate('create', body.key, body))
      }
      const memoryMutation = p.match(/^\/v1\/memories\/(.+)$/)
      if (memoryMutation && ['PATCH', 'DELETE'].includes(req.method)) {
        return json(res, 200, await mutate(req.method === 'PATCH' ? 'update' : 'delete',
          decodeURIComponent(memoryMutation[1]), req.method === 'PATCH' ? await readJson(req) : {}))
      }
      if (p === '/v2/search/subgraph') throw fail('unsupported_operation', 'Use /v1/search; graph traversal is not available', 501)
      if (req.method === 'POST' && p === '/v2/migration/start') {
        try { return json(res, 202, await migration.start()) }
        catch (e) { throw fail('migration_unavailable', e.message, 503) }
      }
      if (req.method === 'POST' && p === '/v2/ingests/lookup') return json(res, 200, await journal.lookup(await readJson(req)))
      if (req.method === 'POST' && p === '/v1/grep') return json(res, 200, await grepMemory(await readJson(req)))
      if (req.method === 'POST' && ['/v1/search', '/v2/search', '/v2/recall', '/v2/ingest'].includes(p)) {
        const body = await readJson(req)
        if (p === '/v2/ingest') return json(res, 202, await journal.ingest(body))
        if (p === '/v2/recall') {
          const text = query(body.text, 'text').slice(0, 600)
          const maxEntities = integer(body.maxEntities, 10)
          integer(body.maxRelations, 5)
          if (text.length < 8 || TRIVIAL_RE.test(text)) return json(res, 200, { backend: 'openviking', results: [], entities: [], relations: [] })
          const hits = await retrieve({ ...body, query: text }, 'recall', maxEntities)
          return json(res, 200, { backend: 'openviking', results: hits, entities: hits.map(h => entity(h, true)), relations: [] })
        }
        // Agent/proactive search uses native search; automatic recall uses
        // /v2/recall and native find. Return summaries for progressive reading.
        const mode = body.mode ?? 'search'
        const hits = await retrieve(body, mode)
        return json(res, 200, { backend: 'openviking', results: hits })
      }
      if (/^\/v[12]\/(memories|tree|zones|import|backup|restore|rollback|entities|relations|episodes|provenance|prune|touch|domains|graph|stats|match)(\/|$)/.test(p)) {
        throw fail('unsupported_operation', 'legacy tree/graph management is unavailable in the OpenViking backend', 501)
      }
      throw fail('not_found', `no route for ${req.method} ${p}`, 404)
    } catch (err) {
      if (req.method === 'GET' && err.upstreamStatus === 404) return json(res, 404, { error: { code: 'not_found', message: 'Memory URI not found' } })
      if (!err.status) console.error('[violoop-mem] adapter error:', err.message)
      return json(res, err.status || 500, { error: { code: err.code || 'internal', message: err.status ? err.message : 'internal error' } })
    }
  }
  app.setPaused = paused => migration.setPaused(paused)
  app.drainSubmissions = async () => {
    while (journal.pending.size || migration.starting || migration.running) {
      await Promise.allSettled([...journal.pending.values()])
      if (migration.starting || migration.running) await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  app.close = async () => { await migration.stop(); await journal.stop(); await consolidation.stop(); await graph.close() }
  app.resume = () => { journal.resume(); consolidation.resume(); return migration.resume({ autoStart: true }) }
  return app
}

module.exports = { createApp, IngestJournal }
