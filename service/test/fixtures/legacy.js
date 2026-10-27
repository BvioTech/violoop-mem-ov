const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const time = '2023-05-07T01:02:03.000Z'
function createLegacyDatabase(file, rows = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  try {
    db.exec(fs.readFileSync(path.join(__dirname, 'legacy.sql'), 'utf8'))
    db.transaction(() => {
      for (const [table, entries] of Object.entries(rows)) for (const entry of entries) {
        const values = { created_at: time, ...entry }
        if (['memories', 'entities'].includes(table)) values.updated_at ||= time
        const keys = Object.keys(values)
        if (![table, ...keys].every(k => /^[a-z_]+$/.test(k))) throw new Error('invalid fixture field')
        db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
          .run(...keys.map(k => Array.isArray(values[k]) || (values[k] && typeof values[k] === 'object' && !Buffer.isBuffer(values[k])) ? JSON.stringify(values[k]) : values[k]))
      }
    })()
  } finally { db.close() }
  return file
}
function linkedLegacyDatabase(file) {
  return createLegacyDatabase(file, {
    memories: [{ id: 'a', key: 'a', content: 'original note' }],
    entities: [{ id: 'hub', name: 'hub', observations: ['linked', 'residual'] }, { id: 'other', name: 'other' }],
    relations: [{ id: 'r', source: 'hub', target: 'other', relation_type: 'knows' }],
    episodes: [{ id: 'ep-a', session_id: 'note:a' }],
    entity_sources: [{ entity_id: 'hub', episode_id: 'ep-a' }],
    entity_obs_sources: [{ entity_id: 'hub', episode_id: 'ep-a', obs_hash: crypto.createHash('md5').update('linked').digest('hex') }],
    relation_sources: [{ relation_id: 'r', episode_id: 'ep-a' }],
  })
}
module.exports = { createLegacyDatabase, linkedLegacyDatabase }
