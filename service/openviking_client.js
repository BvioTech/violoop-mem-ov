// Native HTTP API, verified against OpenViking 76511554eee2c2efb0ae08f9a2284041aed39840.
// No local graph, embeddings or lexical fallback participates in this backend.
class OpenVikingClient {
  constructor({ url = 'http://127.0.0.1:1933', apiKey = '', account = 'default', user = 'default', actorPeer = 'violoop', timeoutMs = 15000, migrationEmbedding } = {}) {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('OPENVIKING_URL must be an HTTP(S) base URL without credentials/query/fragment')
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('OPENVIKING_TIMEOUT_MS must be a positive integer')
    this.url = url.replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
    this.account = account
    this.user = user
    this.actorPeer = actorPeer
    this.remoteMigrationEmbedding = Boolean(migrationEmbedding)
    this.scope = JSON.stringify([this.url, account, user, actorPeer])
    this.headers = {
      'content-type': 'application/json',
      'X-OpenViking-Account': account,
      'X-OpenViking-User': user,
      'X-OpenViking-Actor-Peer': actorPeer,
      ...(apiKey ? { 'X-API-Key': apiKey } : {}),
    }
  }

  async request(method, route, body, { raw = false, timeoutMs = this.timeoutMs } = {}) {
    try {
      const response = await fetch(this.url + route, {
        method, headers: this.headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
      })
      const data = await response.json()
      if (!response.ok || data.status === 'error') {
        const err = new Error(data.error?.message || (typeof data.detail === 'string' ? data.detail : '') || `OpenViking returned HTTP ${response.status}`)
        err.code = 'upstream_error'
        err.status = response.status >= 500 ? 503 : 502
        err.upstreamStatus = response.status
        throw err
      }
      if (raw) return data
      if (data.status !== 'ok' || !Object.hasOwn(data, 'result')) throw new Error('invalid OpenViking response envelope')
      return data.result
    } catch (err) {
      if (err.code === 'upstream_error') throw err
      const failure = new Error(err.name === 'TimeoutError' ? 'OpenViking request timed out' : 'OpenViking unavailable or returned invalid JSON')
      failure.code = 'upstream_unavailable'
      failure.status = err.name === 'TimeoutError' ? 504 : 503
      throw failure
    }
  }

  async ready() {
    const result = await this.request('GET', '/ready', undefined, { raw: true })
    return result.status === 'ready'
  }

  async migrationReady() {
    const result = await this.request('GET', '/ready', undefined, { raw: true })
    return result.status === 'ready' && result.violoop_legacy_migration === 1
      && (!this.remoteMigrationEmbedding || result.violoop_migration_embedding === 1)
  }

  retrieve(query, { mode, limit, minScore, targetUri, sessionId, level, readContent = false,
    tags, since, until, timeField, contextType, includeProvenance, filter, eventsTimeDecayProtection } = {}) {
    return this.request('POST', `/api/v1/search/${mode === 'recall' ? 'find' : 'search'}`, {
      query, limit, read_content: readContent,
      ...(level === undefined ? {} : { level }),
      ...(minScore === undefined ? {} : { score_threshold: minScore }),
      ...(targetUri ? { target_uri: targetUri } : {}),
      ...(sessionId && mode !== 'recall' ? { session_id: sessionId } : {}),
      ...Object.fromEntries(Object.entries({ tags, since, until, time_field: timeField,
        events_time_decay_protection: eventsTimeDecayProtection,
        context_type: contextType, include_provenance: includeProvenance, filter }).filter(([, v]) => v !== undefined)),
    })
  }

  waitProcessed() {
    return this.request('POST', '/api/v1/system/wait', { timeout: 1 }, { timeoutMs: 3000 })
  }

  stat(uri) { return this.request('GET', '/api/v1/fs/stat?' + new URLSearchParams({ uri })) }
  attrs(uri) { return this.request('GET', '/api/v1/fs/attrs?' + new URLSearchParams({ uri })) }
  writeMemory(uri, content, { mode, tags } = {}) {
    return this.request('POST', '/api/v1/content/write', {
      uri, content, mode, wait: false, ...(tags === undefined ? {} : { tags, tag_mode: 'replace' }),
    }, { timeoutMs: Math.max(this.timeoutMs, 120000) })
  }
  deleteMemory(uri) {
    return this.request('DELETE', '/api/v1/fs?' + new URLSearchParams({ uri, recursive: false, wait: false }),
      undefined, { timeoutMs: Math.max(this.timeoutMs, 120000) })
  }
  grep(pattern, { uri = 'viking://~/memories', limit = 10, caseInsensitive = false } = {}) {
    return this.request('POST', '/api/v1/search/grep', {
      uri, pattern, node_limit: limit, case_insensitive: caseInsensitive,
    })
  }
  read(uri, level, { offset = 0, limit = 80 } = {}) {
    const route = ['abstract', 'overview', 'read'][level]
    return this.request('GET', '/api/v1/content/' + route + '?' + new URLSearchParams({ uri,
      ...(level === 2 ? { offset, limit } : {}),
    }))
  }
  // Graph projection needs stored MEMORY_FIELDS, not the cleaned agent view.
  readRaw(uri) {
    return this.request('GET', '/api/v1/content/read?' + new URLSearchParams({ uri, raw: true, limit: -1 }))
  }
  list(uri, { offset = 0, limit = 20 } = {}) {
    return this.request('GET', '/api/v1/fs/ls?' + new URLSearchParams({ uri, offset, limit,
      output: 'agent', include_abstract: true, include_overview: false,
    }), undefined, { raw: true })
  }

  listFiles(uri, { offset = 0, limit = 200 } = {}) {
    return this.request('GET', '/api/v1/fs/ls?' + new URLSearchParams({ uri, offset, limit,
      output: 'original', recursive: false, show_all_hidden: true,
      include_abstract: false, include_overview: false,
    }), undefined, { raw: true })
  }

  addMessages(sessionId, messages) {
    return this.request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/batch`, { messages })
  }
  commit(sessionId) {
    return this.request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`, { keep_recent_count: 0 })
  }
  task(taskId) { return this.request('GET', `/api/v1/tasks/${encodeURIComponent(taskId)}`) }
  consolidateMemories(target) {
    return this.request('POST', '/api/v1/compile', { to: target, skill: 'memory' })
  }
}

module.exports = { OpenVikingClient }
