// A rebuildable, read-only projection of OpenViking memory files. Never open
// legacy graph.db, run extraction, or participate in retrieval/model prompts.
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const Database = require('better-sqlite3')
const { validateVikingUri } = require('./openviking_uri')

const digest = value => createHash('sha256').update(value).digest('hex')
const failure = message => Object.assign(new Error(message), { status: 503, code: 'graph_unavailable' })
const fieldsPattern = /<!--\s*MEMORY_FIELDS\b([\s\S]*?)\s*-->/g
function parseMemory(raw, uri) {
  if (typeof raw !== 'string') throw failure('Invalid memory content')
  const match = [...raw.matchAll(fieldsPattern)][0]
  let fields = match ? JSON.parse(match[1]) : {}
  // Native parsing also accepts a singleton array; native writes valid JSON.
  if (Array.isArray(fields)) fields = fields[0]
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw failure('Invalid memory metadata')
  const content = raw.replace(fieldsPattern, '').trim()
  const parts = uri.split('/')
  const type = typeof fields.memory_type === 'string' && fields.memory_type
    ? fields.memory_type : parts.at(-2) === 'memories' ? parts.at(-1).replace(/\.md$/, '') : parts.at(-2)
  const name = typeof fields.name === 'string' && fields.name ? fields.name : parts.at(-1).replace(/\.md$/, '')
  const category = typeof fields.category === 'string' ? fields.category : ''
  return { id: uri, name, type, category, content, createdAt: fields.created_at || null,
    updatedAt: fields.updated_at || null, links: Array.isArray(fields.links) ? fields.links : [] }
}

class OpenVikingGraph {
  constructor(client, { dataDir } = {}) {
    this.client = client
    this.file = path.join(dataDir, 'openviking-graph.db')
    this.scope = client.scope
    this.root = `viking://user/${client.user || 'default'}/memories`
    validateVikingUri(this.root)
    this.error = null
    this.completionErrors = new Map()
    this.pending = null
    this.manualSync = null
    this.lastManualSyncAt = null
    this.closed = false
  }

  open() {
    if (this.db) return this.db
    this.db = new Database(this.file)
    fs.chmodSync(this.file, 0o600)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projection_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, changes TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS projection_events_scope ON projection_events(scope,id);
      CREATE TABLE IF NOT EXISTS projection_receipts (scope TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS projection_meta (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, synced_at TEXT);
      CREATE TABLE IF NOT EXISTS projection_nodes (
        scope TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT, name TEXT NOT NULL,
        type TEXT NOT NULL, category TEXT NOT NULL, content TEXT NOT NULL,
        created_at TEXT, updated_at TEXT, PRIMARY KEY (scope,id));
      CREATE TABLE IF NOT EXISTS projection_edges (
        scope TEXT NOT NULL, owner TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL,
        target TEXT NOT NULL, type TEXT NOT NULL, weight REAL NOT NULL, description TEXT NOT NULL,
        PRIMARY KEY (scope,owner,id));
      CREATE INDEX IF NOT EXISTS projection_edges_source ON projection_edges(scope,source);
      CREATE INDEX IF NOT EXISTS projection_edges_target ON projection_edges(scope,target);
    `)
    if (!this.db.prepare('PRAGMA table_info(projection_meta)').all().some(c => c.name === 'cursor')) {
      this.db.exec('ALTER TABLE projection_meta ADD COLUMN cursor INTEGER')
    }
    return this.db
  }

  inScope(uri) { return typeof uri === 'string' && uri.startsWith(this.root + '/') }

  hasCompletion(id) {
    return !!this.open().prepare('SELECT 1 FROM projection_receipts WHERE scope=? AND id=?').get(this.scope, id)
  }

  queueCompletion(id, uris) {
    if (!Array.isArray(uris)) throw failure('Invalid completed memory change list')
    const changes = [...new Set(uris)].filter(uri => this.inScope(uri)
      && uri.endsWith('.md') && !uri.slice(this.root.length + 1).split('/').some(p => p.startsWith('.')))
      .map(uri => { validateVikingUri(uri); return { uri, kind: 'file' } })
    const db = this.open()
    db.transaction(() => {
      const added = db.prepare('INSERT OR IGNORE INTO projection_receipts VALUES (?,?)').run(this.scope,id)
      if (added.changes && changes.length) db.prepare('INSERT INTO projection_events(scope,changes,created_at) VALUES (?,?,?)')
        .run(this.scope, JSON.stringify(changes), new Date().toISOString())
    })()
  }

  async completion(id, uris) {
    this.queueCompletion(id, uris)
    await this.sync()
  }

  async inventory(root = 'viking://~/memories') {
    const queue = [root], visited = new Set(), files = new Map()
    for (let i = 0; i < queue.length; i++) {
      if (this.closed) throw failure('Memory graph is closed')
      const directory = queue[i]
      if (visited.has(directory)) continue
      visited.add(directory)
      if (visited.size > 10000) throw failure('Memory graph directory limit exceeded')
      let offset = 0
      for (;;) {
        let page
        try { page = await this.client.listFiles(directory, { offset, limit: 200 }) }
        catch (err) {
          // A newly provisioned user may not have a memory directory yet.
          if (i === 0 && offset === 0 && err.upstreamStatus === 404) break
          throw err // An incomplete listing must never delete cached nodes.
        }
        if (!Array.isArray(page?.result)) throw failure('Invalid memory graph listing')
        for (const item of page.result) {
          if (item.access === 'denied') continue
          const id = item.uri
          if (!this.inScope(id)) throw failure('Memory graph listing escaped the user scope')
          validateVikingUri(id)
          if (id.split('/').slice(this.root.split('/').length).some(part => part.startsWith('.'))) continue
          if (item.isDir ?? item.is_dir ?? item.type === 'directory') queue.push(id)
          else if (id.endsWith('.md')) {
            const stamp = item.modTime ?? item.mtime ?? item.updated_at
            const fingerprint = stamp ? JSON.stringify([stamp, item.size ?? null]) : null
            files.set(id, { fingerprint, updatedAt: stamp || null })
          }
          if (files.size > 100000 || queue.length > 10000) throw failure('Memory graph size limit exceeded')
        }
        if (!page.has_more) break
        if (!page.result.length || offset > 100000) throw failure('Memory graph pagination made no progress')
        offset += page.result.length
      }
    }
    return files
  }

  async sync(force = false) {
    if (this.closed) throw failure('Memory graph is closed')
    if (this.pending) {
      await this.pending
      if (!force) return
    }
    this.pending = this.synchronize(force || this.repairRequired).catch(err => {
      if (force) this.repairRequired = true
      this.error = err.message || 'Memory graph update failed'
      if (!this.open().prepare('SELECT 1 FROM projection_meta WHERE scope=?').get(this.scope)) throw failure(this.error)
    }).finally(() => { this.pending = null })
    await this.pending
  }

  async readNode(id) {
    let raw
    try { raw = await this.client.readRaw(id) }
    catch (error) { if (error.upstreamStatus === 404) return null; throw error }
    const node = parseMemory(raw, id)
    const links = new Map()
    for (const link of node.links) {
      if (!link || typeof link !== 'object') continue
      const source = link.from_uri || id, target = link.to_uri
      if (!this.inScope(source) || !this.inScope(target)) continue
      validateVikingUri(source); validateVikingUri(target)
      const type = typeof link.link_type === 'string' && link.link_type ? link.link_type : 'related_to'
      const weight = link.weight === undefined ? 1 : Number(link.weight)
      if (!Number.isFinite(weight)) throw failure('Invalid memory link weight')
      const edgeId = 'ov-edge-' + digest(JSON.stringify([source, target, type]))
      if (!links.has(edgeId)) links.set(edgeId, { id: edgeId, source, target, type, weight,
        description: typeof link.description === 'string' ? link.description : '' })
    }
    return { ...node, links: [...links.values()], fingerprint: digest(raw) }
  }

  commit(updates, deleted, cursor) {
    const db = this.open()
    const upsert = db.prepare(`INSERT OR REPLACE INTO projection_nodes
      (scope,id,fingerprint,name,type,category,content,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    const clearEdges = db.prepare('DELETE FROM projection_edges WHERE scope=? AND owner=?')
    const insertEdge = db.prepare('INSERT INTO projection_edges VALUES (?,?,?,?,?,?,?,?)')
    db.transaction(() => {
      let changed = false
      for (const id of deleted) {
        if (db.prepare('DELETE FROM projection_nodes WHERE scope=? AND id=?').run(this.scope, id).changes) changed = true
        clearEdges.run(this.scope, id)
      }
      for (const node of updates) {
        const old = db.prepare('SELECT fingerprint FROM projection_nodes WHERE scope=? AND id=?').get(this.scope, node.id)
        if (old?.fingerprint === node.fingerprint) continue
        changed = true
        upsert.run(this.scope, node.id, node.fingerprint, node.name, node.type, node.category,
          node.content, node.createdAt, node.updatedAt)
        clearEdges.run(this.scope, node.id)
        for (const e of node.links) insertEdge.run(this.scope, node.id, e.id, e.source, e.target, e.type, e.weight, e.description)
      }
      const oldMeta = db.prepare('SELECT revision FROM projection_meta WHERE scope=?').get(this.scope)
      db.prepare('INSERT OR REPLACE INTO projection_meta(scope,revision,synced_at,cursor) VALUES (?,?,?,?)')
        .run(this.scope, (oldMeta?.revision || 0) + (changed || !oldMeta ? 1 : 0), new Date().toISOString(), cursor)
    })()
  }

  async synchronize(force) {
    const db = this.open()
    let meta = db.prepare('SELECT * FROM projection_meta WHERE scope=?').get(this.scope)
    if (force || !meta || meta.cursor === null) {
      // Establish one baseline only. Capture the journal position first so any
      // concurrent commits are replayed after the initial directory walk.
      const cursor = db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM projection_events WHERE scope=?').get(this.scope).id
      const files = await this.inventory()
      const updates = [], deleted = db.prepare('SELECT id FROM projection_nodes WHERE scope=?').all(this.scope)
        .map(n => n.id).filter(id => !files.has(id))
      for (const id of files.keys()) {
        if (this.closed) throw failure('Memory graph is closed')
        const node = await this.readNode(id)
        if (node) updates.push(node); else deleted.push(id)
      }
      this.commit(updates, deleted, cursor)
      meta = db.prepare('SELECT * FROM projection_meta WHERE scope=?').get(this.scope)
    }
    const target = db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM projection_events WHERE scope=?').get(this.scope).id
    let cursor = meta.cursor
    while (cursor < target) {
      if (this.closed) throw failure('Memory graph is closed')
      const rows = db.prepare(`SELECT id,changes FROM projection_events
        WHERE scope=? AND id>? AND id<=? ORDER BY id LIMIT 250`).all(this.scope,cursor,target)
      if (!rows.length) break
      const affected = new Map()
      for (const row of rows) {
        const changes = JSON.parse(row.changes)
        if (!Array.isArray(changes)) throw failure('Invalid native memory change journal')
        for (const change of changes) {
          if (change.uri !== this.root && !this.inScope(change.uri)) throw failure('Memory change escaped the user scope')
          validateVikingUri(change.uri)
          if (!['file','tree','delete'].includes(change.kind)) throw failure('Invalid native memory change kind')
          affected.set(change.uri, change.kind)
        }
      }
      const ids = new Set(), updates = [], deleted = []
      for (const [id, kind] of affected) {
        if (kind === 'tree' || kind === 'delete') {
          for (const row of db.prepare('SELECT id FROM projection_nodes WHERE scope=?').all(this.scope)) {
            if (row.id === id || row.id.startsWith(id + '/')) ids.add(row.id)
          }
        }
        if (kind === 'tree') for (const child of (await this.inventory(id)).keys()) ids.add(child)
        if (id.endsWith('.md')) ids.add(id)
      }
      // Read final persisted state, not the LLM's proposed operations. This also
      // makes replay idempotent and handles delete/recreate of the same URI.
      for (const id of ids) {
        const node = await this.readNode(id)
        if (node) updates.push(node); else deleted.push(id)
      }
      cursor = rows.at(-1).id
      // Cursor and graph rows are committed together. Failed reads leave both
      // unchanged so the next completion/status check can safely retry.
      this.commit(updates, deleted, cursor)
    }
    this.error = null
    this.repairRequired = false
  }

  startSync() {
    if (this.manualSync) return { started: false, reason: 'busy' }
    if (this.closed) throw failure('Memory graph is closed')
    this.lastManualSyncAt = Date.now()
    // Read existing native files and links only. Never submit an extraction or
    // migration request. Keep this async so large libraries do not time out RPC.
    this.manualSync = Promise.resolve().then(() => this.sync(true))
      .catch(err => { this.error = err.message || 'Memory graph update failed' })
      .finally(() => { this.manualSync = null })
    return { started: true }
  }

  async status() {
    if (!this.manualSync) await this.sync()
    const db = this.open()
    const meta = db.prepare('SELECT revision,cursor FROM projection_meta WHERE scope=?').get(this.scope)
    const pendingCount = db.prepare('SELECT count(*) AS n FROM projection_events WHERE scope=? AND id>?')
      .get(this.scope, meta?.cursor || 0).n
    return { revision: digest(this.scope) + ':' + (meta?.revision || 0),
      running: !!this.manualSync, pendingCount, lastRunAt: this.lastManualSyncAt,
      error: this.error || this.completionErrors.values().next().value || null, readOnly: true }
  }

  visibleEdges() {
    // Missing endpoints are retained in the index and appear when both files
    // exist again. Deduplicate the same triple stored in multiple files.
    return this.open().prepare(`SELECT e.* FROM projection_edges e
      JOIN projection_nodes s ON s.scope=e.scope AND s.id=e.source
      JOIN projection_nodes t ON t.scope=e.scope AND t.id=e.target
      WHERE e.scope=? ORDER BY e.owner,e.id`).all(this.scope)
  }

  node(row, skeleton) {
    return { id: row.id, uri: row.id, name: row.name, type: row.type, category: row.category,
      domains: [row.type], curated: false, obsCount: row.content ? 1 : 0,
      updatedAt: row.updated_at, createdAt: row.created_at, readOnly: true,
      ...(!skeleton ? { observations: row.content ? [row.content] : [], content: row.content, sources: [], properties: {} } : {}) }
  }

  edge(row) {
    // confidence is only a legacy layout compatibility field; the UI labels
    // and displays the actual OpenViking weight, with no confidence/decay claim.
    return { id: row.id, source: row.source, target: row.target, relationType: row.type,
      weight: row.weight, confidence: row.weight, description: row.description, readOnly: true }
  }

  async export({ limit = 5000, skeleton = true, revision, rebuild = false } = {}) {
    await this.sync(rebuild)
    const db = this.open()
    const meta = db.prepare('SELECT * FROM projection_meta WHERE scope=?').get(this.scope)
    const all = db.prepare('SELECT id,name,type,category,length(content)>0 AS has_content,created_at,updated_at FROM projection_nodes WHERE scope=? ORDER BY name COLLATE NOCASE,id').all(this.scope)
    const unique = new Map()
    for (const e of this.visibleEdges()) if (!unique.has(e.id)) unique.set(e.id, e)
    const domains = [...new Set(all.map(n => n.type))].sort()
    const stats = { entityCount: all.length, memoryCount: all.length, relationCount: unique.size,
      entityTypes: domains.map(type => ({ type, count: all.filter(n => n.type === type).length })) }
    const stamp = digest(this.scope) + ':' + meta.revision
    const base = { backend: 'openviking', graphKind: 'memory-links', readOnly: true, revision: stamp,
      syncedAt: meta.synced_at, syncError: this.error || this.completionErrors.values().next().value || null,
      stats, domains, limited: all.length > limit, skeleton }
    if (!rebuild && revision === stamp) return { ...base, unchanged: true }
    const rows = skeleton ? all.slice(0, limit) : db.prepare('SELECT * FROM projection_nodes WHERE scope=? ORDER BY name COLLATE NOCASE,id LIMIT ?').all(this.scope, limit)
    const ids = new Set(rows.map(n => n.id))
    return { ...base, entities: rows.map(n => skeleton ? { ...this.node(n, true), obsCount: n.has_content ? 1 : 0 } : this.node(n, false)),
      relations: [...unique.values()].filter(e => ids.has(e.source) && ids.has(e.target)).map(e => this.edge(e)) }
  }

  async detail(id) {
    await this.sync()
    const db = this.open()
    const row = db.prepare('SELECT * FROM projection_nodes WHERE scope=? AND id=?').get(this.scope, id)
    if (row) return { ...this.node(row, false), type: 'entity', memoryType: row.type,
      sources: [], observations: row.content ? [{ text: row.content, episodeIds: [] }] : [] }
    const edge = this.visibleEdges().find(e => e.id === id)
    if (edge) return { ...this.edge(edge), type: 'relation', sources: [] }
    throw Object.assign(new Error('Memory graph item not found'), { status: 404, code: 'not_found' })
  }

  async close() {
    this.closed = true
    if (this.manualSync) await this.manualSync
    if (this.pending) await this.pending.catch(() => {})
    this.db?.close()
  }
}

module.exports = { OpenVikingGraph, parseMemory }
