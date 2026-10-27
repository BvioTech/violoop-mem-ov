// Agent-facing validation and metadata. Mutations always use native APIs so
// memory metadata, schema summaries and vector cleanup stay owned by OpenViking.
const { validateVikingUri } = require('./openviking_uri')
const { eventTimeDecay } = require('./event_time_decay')
const fail = (message, status = 400, code = 'invalid_query') => Object.assign(new Error(message), { status, code })
const levelOf = value => value.endsWith('/.abstract.md') ? 0 : value.endsWith('/.overview.md') ? 1 : 2
const canonical = value => value.replace(/\/(\.abstract|\.overview)\.md$/, '').replace(/\/$/, '')

function tags(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 20) throw fail('tags must be an array of at most 20 k=v strings')
  const seen = new Set()
  return value.map(tag => {
    if (typeof tag !== 'string' || tag.length > 200 || !/^[^=\s\x00-\x1f]+=[^=\x00-\x1f]+$/.test(tag)) throw fail('tags must use non-empty k=v strings')
    const normalized = tag.toLowerCase().trim()
    if (!normalized.split('=')[1].trim()) throw fail('tag value must not be blank')
    const key = normalized.split('=')[0]
    if (seen.has(key)) throw fail('duplicate tag key: ' + key)
    seen.add(key)
    return normalized
  })
}
function searchOptions(body, client, policy) {
  const out = {}
  const protection = eventTimeDecay(body, policy)
  if (protection !== undefined) out.eventsTimeDecayProtection = protection
  if (body.tags !== undefined) out.tags = tags(body.tags)
  if (body.memoryType !== undefined) {
    if (typeof body.memoryType !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(body.memoryType)) throw fail('memoryType must be a schema name, e.g. entities or events')
    const typeTag = 'memory_type=' + body.memoryType
    if (out.tags?.some(t => t.startsWith('memory_type=') && t !== typeTag)) throw fail('memoryType conflicts with tags')
    // Native reserves memory_type tags for extraction; content/write creates
    // ordinary files without that tag. Include their actual schema directory
    // as well, so Agent-created memories participate in the same type filter.
    const roots = client ? [`viking://user/${client.user}/memories`,
      `viking://user/${client.user}/peers/${client.actorPeer}/memories`] : []
    out.filter = { op: 'or', conds: [
      { op: 'must', field: 'search_tags', conds: [typeTag] },
      ...roots.map(root => ({ op: 'must', field: 'uri', conds: [root + '/' + body.memoryType], para: '-d=-1' })),
    ] }
  }
  if (body.contextType !== undefined) {
    if (!['memory', 'resource', 'skill'].includes(body.contextType)) throw fail('contextType must be memory, resource or skill')
    out.contextType = body.contextType
  }
  if (body.timeField !== undefined) {
    if (!['created_at', 'updated_at'].includes(body.timeField)) throw fail('timeField must be created_at or updated_at')
    out.timeField = body.timeField
  }
  const now = Date.now(), bounds = {}
  for (const key of ['since', 'until']) {
    const value = body[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.length > 64) throw fail(key + ' must be an ISO date/time or relative duration such as 7d')
    const relative = /^(\d+)([smhdw])$/.exec(value)
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value)
    if (!relative && !dateOnly && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw fail(key + ' must include a timezone, or use YYYY-MM-DD or 7d')
    const milliseconds = relative ? now - Number(relative[1]) * { s:1000, m:60000, h:3600000, d:86400000, w:604800000 }[relative[2]]
      : Date.parse(value + (dateOnly ? (key === 'until' ? 'T23:59:59.999Z' : 'T00:00:00Z') : ''))
    if (!Number.isFinite(milliseconds) || (!relative && new Date(milliseconds).toISOString().slice(0, 10) !== value.slice(0, 10) && dateOnly)) throw fail('invalid ' + key)
    bounds[key] = milliseconds
    // Freeze relative bounds once so semantic and keyword branches share the
    // same instant, even if query planning takes seconds.
    out[key] = relative ? new Date(milliseconds).toISOString() : value
  }
  if (bounds.since !== undefined && bounds.until !== undefined && bounds.since > bounds.until) throw fail('since must not be after until')
  if (body.includeProvenance !== undefined) {
    if (typeof body.includeProvenance !== 'boolean') throw fail('includeProvenance must be boolean')
    out.includeProvenance = body.includeProvenance
  }
  return out
}
function memoryUri(value, client, { allowDisabledSingletonDelete = false } = {}) {
  validateVikingUri(value)
  const parts = value.slice(9).split('/')
  let tail
  if (parts[0] === '~') tail = parts.slice(1)
  else if (parts[0] === 'user' && parts[1] === client.user) tail = parts.slice(2)
  else throw fail('writes are restricted to the current user memory namespace')
  if (tail[0] === 'peers' && tail[1] === client.actorPeer) tail = tail.slice(2)
  const singleton = tail.length === 2 && (tail[1] === 'profile.md'
    || (allowDisabledSingletonDelete && ['identity.md', 'soul.md'].includes(tail[1])))
  if (tail[0] !== 'memories' || (tail.length < 3 && !singleton) || parts.some(p => !p || p.startsWith('.') || /^%2e/i.test(p)) || !value.endsWith('.md')) {
    throw fail('key must name a single .md file under memories/<schema>/; directories, hidden files and traversal are forbidden')
  }
  return value
}
function text(value, name, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > 1000000) throw fail(name + ' must be ' + (allowEmpty ? 'a' : 'a non-empty') + ' string of at most 1000000 characters')
  return value
}
function metadata(attrs) {
  const source = attrs?.attrs?.memory || {}
  const fields = ['memory_type', 'created_at', 'updated_at', 'source_extraction_id', 'source_extraction_ids', 'last_update_trace_id', 'version']
  return { ...(Array.isArray(attrs?.attrs?.tags) ? { tags: attrs.attrs.tags } : {}),
    memory: Object.fromEntries(fields.filter(k => source[k] !== undefined).map(k => [k, source[k]])) }
}
async function enrich(client, hits, nativeResult, includeProvenance) {
  if (!includeProvenance) return hits
  return Promise.all(hits.map(async hit => {
    let details
    try { details = metadata(await client.attrs(hit.uri)) }
    catch (e) { details = { metadataUnavailable: e.message } }
    const retrieval = []
    for (const trace of nativeResult?.provenance || []) {
      const matched = (trace.matched_contexts || []).filter(m => canonical(m.uri || '') === hit.uri)
      for (const match of matched) retrieval.push({ query: trace.query, tier: match.tier,
        matchReason: match.match_reason, score: match.score })
    }
    return { ...hit, ...details, provenance: { retrieval,
      ...(hit.keywordMatches?.length ? { keywordMatches: hit.keywordMatches } : {}) } }
  }))
}
function createMutations(client, invalidate) {
  const pending = new Map()
  return async function mutate(action, key, body = {}) {
    const target = memoryUri(key, client, { allowDisabledSingletonDelete: action === 'delete' })
    const normalizedTags = tags(body.tags)
    if (action === 'create') text(body.content, 'content')
    if (action === 'update') { text(body.oldText, 'oldText'); text(body.newText, 'newText', true) }
    if (action === 'replace') {
      text(body.expectedContent, 'expectedContent'); text(body.content, 'content')
      if (/<!--\s*MEMORY_FIELDS\b/i.test(body.content)) throw fail('Reserved memory metadata cannot be entered in the body')
    }
    // Serialize alias/canonical requests for the same file in this process.
    const lockKey = target.replace('viking://~/', `viking://user/${client.user}/`)
    const prior = pending.get(lockKey) || Promise.resolve()
    const job = prior.catch(() => {}).then(async () => {
      try {
        let result
        if (action === 'delete') {
          const stat = await client.stat(target)
          if (stat.isDir ?? stat.is_dir ?? stat.type === 'directory') throw fail('deleting directories is forbidden')
          result = await client.deleteMemory(target)
        } else {
          let content = body.content
          if (action === 'replace') {
            const original = await client.read(target, 2, { limit: -1 })
            if (original !== body.expectedContent) throw fail('Memory changed since it was opened; reopen it before saving', 409, 'edit_conflict')
          } else if (action === 'update') {
            const original = await client.read(target, 2, { limit: -1 })
            if (typeof original !== 'string') throw fail('invalid native content', 502, 'upstream_error')
            const start = original.indexOf(body.oldText)
            if (start < 0 || original.indexOf(body.oldText, start + 1) >= 0) throw fail('oldText must match exactly once; read the current file and retry', 409, 'edit_conflict')
            content = original.slice(0, start) + body.newText + original.slice(start + body.oldText.length)
            text(content, 'resulting content')
          }
          result = await client.writeMemory(target, content, { mode: action === 'create' ? 'create' : 'replace', tags: normalizedTags })
        }
        return { backend: 'openviking', action, uri: target, key: target,
          ...(action === 'delete' ? { deleted: true } : {}), result,
          notice: 'Native processing statuses are returned in result. Queued indexing is not completion.' }
      } catch (e) {
        if ([400, 403, 404, 409, 422].includes(e.upstreamStatus)) { e.status = e.upstreamStatus; e.code = e.upstreamStatus === 409 ? 'edit_conflict' : 'native_rejected' }
        if (e.code === 'upstream_unavailable' || e.upstreamStatus >= 500) e.message += '; the write may have applied. Read the file before retrying.'
        throw e
      } finally { invalidate() }
    })
    pending.set(lockKey, job)
    try { return await job } finally { if (pending.get(lockKey) === job) pending.delete(lockKey) }
  }
}
module.exports = { searchOptions, createMutations, enrich, metadata, levelOf, canonical }
