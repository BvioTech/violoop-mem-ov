// Read-only catalogue for the existing PC memory panel. A sidecar's actual
// file URI preserves identity: a directory's L0 and L1 are separate entries.
const { basename, dirname } = require('path').posix
const { validateVikingUri } = require('./openviking_uri')

function describe(key, stat = {}) {
  validateVikingUri(key)
  const name = basename(key)
  const level = name === '.abstract.md' ? 0 : name === '.overview.md' ? 1 : 2
  const target = level < 2 ? dirname(key) : key
  const label = basename(target).replace(/\.md$/, '') || target
  const title = `[L${level}] ${label}`
  const updatedAt = stat.modTime || stat.mtime || stat.updated_at || null
  const relative = target.split('/memories/')[1] || ''
  const memoryType = relative.split('/')[0].replace(/\.md$/, '')
  return { key, uri: target, level, memoryType, title, type: 'archival', source: 'openviking',
    updated_at: updatedAt, frontmatter: { title, type: 'archival', source: 'openviking',
      level, uri: target, memoryType, updated_at: updatedAt } }
}

function createEntries(client) {
  let cached, expiresAt = 0, pending, generation = 0
  async function scan() {
    const queue = ['viking://~/memories'], seen = new Set(), files = new Map()
    for (let i = 0; i < queue.length; i++) {
      const directory = queue[i]
      if (seen.has(directory)) continue
      seen.add(directory)
      if (seen.size > 1000) throw Object.assign(new Error('Memory catalogue exceeds 1000 directories'), { status: 413 })
      let offset = 0
      for (;;) {
        const page = await client.listFiles(directory, { offset, limit: 200 })
        if (!Array.isArray(page.result)) throw Object.assign(new Error('invalid native listing'), { status: 502 })
        for (const item of page.result) {
          if (item.access === 'denied') continue
          const key = item.uri || (item.name ? directory + '/' + item.name : null)
          if (!key) continue
          validateVikingUri(key)
          const name = basename(key)
          if (name.startsWith('.') && !['.abstract.md', '.overview.md'].includes(name)) continue
          if (item.isDir ?? item.is_dir ?? item.type === 'directory') queue.push(key)
          else files.set(key, describe(key, item))
          if (files.size > 5000 || queue.length > 1000) {
            throw Object.assign(new Error('Memory catalogue is too large for the flat panel'), { status: 413 })
          }
        }
        if (!page.has_more) break
        if (!page.result.length) throw Object.assign(new Error('native listing pagination made no progress'), { status: 502 })
        offset += page.result.length
        if (offset > 10000) throw Object.assign(new Error('Memory directory is too large for the flat panel'), { status: 413 })
      }
    }
    return [...files.values()].sort((a, b) => a.key.localeCompare(b.key))
  }
  return {
    invalidate() { generation++; cached = undefined; expiresAt = 0; pending = undefined },
    async list() {
      if (cached && Date.now() < expiresAt) return cached
      const current = generation
      if (!pending) pending = scan().then(items => {
        if (generation === current) { cached = items; expiresAt = Date.now() + 5000 }
        return items
      }).finally(() => { if (generation === current) pending = null })
      return pending
    },
    async get(key) {
      const item = describe(key)
      const stat = await client.stat(key) // Missing sidecars never become placeholder entries.
      if (stat.isDir ?? stat.is_dir ?? stat.type === 'directory') {
        throw Object.assign(new Error('Select a memory file or an L0/L1 sidecar'), { status: 400, code: 'invalid_uri' })
      }
      const entry = describe(key, stat)
      const text = await client.read(item.uri, item.level, { limit: -1 })
      if (typeof text !== 'string') throw Object.assign(new Error('invalid native content'), { status: 502 })
      const truncated = text.length > 60000
      return { ...entry, backend: 'openviking', truncated,
        content: text.slice(0, 60000)
          + (truncated ? '\n\n[正文超过 60000 字符，面板预览已截断；可通过 memory.get 分页读取完整内容。]' : '') }
    },
  }
}

module.exports = { createEntries }
