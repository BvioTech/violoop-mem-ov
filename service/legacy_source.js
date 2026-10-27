// Read-only legacy graph.db access. Never construct GraphStore here: its
// constructor initializes schema and changes journal settings.
const crypto = require('crypto')
const fs = require('fs')
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const parse = (value, fallback) => value ? JSON.parse(value) : fallback

function readLegacySnapshot(file) {
  if (!fs.existsSync(file)) throw new Error(`Legacy memory database not found: ${file}`)
  const Database = require('better-sqlite3')
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only = ON')
    return db.transaction(() => {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name))
      for (const t of ['memories', 'entities', 'relations', 'episodes']) {
        if (!tables.has(t)) throw new Error(`Legacy database is missing ${t}`)
      }
      const rows = t => db.prepare(`SELECT * FROM ${t}`).all()
      const memories = rows('memories').sort((a, b) => a.key.localeCompare(b.key))
      const entities = rows('entities').sort((a, b) => a.id.localeCompare(b.id)).map(e => ({
        ...e, aliases: parse(e.aliases, []), observations: parse(e.observations, []),
        properties: parse(e.properties, {}), domains: parse(e.domains, []),
      }))
      const relations = rows('relations').sort((a, b) => a.id.localeCompare(b.id)).map(r => ({ ...r, properties: parse(r.properties, {}) }))
      // Only provenance identities are needed; never load 10k raw conversations.
      const episodes = db.prepare('SELECT id, session_id, status FROM episodes').all().filter(e => e.status !== 'retracted')
      const byNote = new Map()
      for (const e of episodes) if (e.session_id?.startsWith('note:')) {
        byNote.set(e.id, e.session_id.slice(5))
      }
      const associations = Object.fromEntries(memories.map(m => [m.key, { observations: {}, relations: [] }]))
      if (tables.has('entity_obs_sources')) for (const s of rows('entity_obs_sources')) {
        const a = associations[byNote.get(s.episode_id)]
        if (a) (a.observations[s.entity_id] ||= []).push(s.obs_hash)
      }
      if (tables.has('relation_sources')) for (const s of rows('relation_sources')) {
        const a = associations[byNote.get(s.episode_id)]
        if (a && !a.relations.includes(s.relation_id)) a.relations.push(s.relation_id)
      }
      // Earlier stores only have entity-level provenance. Include identity in
      // the note group, but leave unproven observations for the residual pass.
      if (tables.has('entity_sources')) for (const s of rows('entity_sources')) {
        const a = associations[byNote.get(s.episode_id)]
        if (a) a.observations[s.entity_id] ||= []
      }
      return { memories, entities, relations, associations }
    })()
  } finally { db.close() }
}

// Same observation fingerprint used by the legacy provenanceByKey method.
function observationHash(text) { return crypto.createHash('md5').update(String(text ?? '')).digest('hex') }
module.exports = { readLegacySnapshot, observationHash, hash }
