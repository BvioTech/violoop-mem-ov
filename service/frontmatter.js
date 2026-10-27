/**
 * frontmatter.js — minimal YAML-frontmatter codec, gray-matter compatible for
 * the subset qmd actually writes: flat scalar fields + string arrays.
 *
 * Used by the legacy-qmd import path (backup restore + migrate script) to read
 * `/var/lib/qmd/memory/**\/*.md`, and by nothing else. Not a general YAML
 * parser: nested maps degrade to raw strings, which is acceptable because
 * qmd's MemoryMetadata is flat (id/key/type/title/tags/half_life_days/
 * created_at/updated_at plus caller extras like source/sourceId/status).
 */

function parse(raw) {
  const text = String(raw || '')
  if (!text.startsWith('---')) return { data: {}, content: text }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { data: {}, content: text }
  const head = text.slice(text.indexOf('\n') + 1, end)
  // skip the closing '---' line and exactly one following newline
  let content = text.slice(end + 4)
  if (content.startsWith('\r\n')) content = content.slice(2)
  else if (content.startsWith('\n')) content = content.slice(1)

  const data = {}
  const lines = head.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let value = m[2]

    if (value === '' || value === '|' || value === '>') {
      // block array (`- item` lines) or empty value
      const items = []
      let j = i + 1
      while (j < lines.length) {
        const im = lines[j].match(/^\s+-\s+(.*)$/)
        if (!im) break
        items.push(_scalar(im[1]))
        j++
      }
      if (items.length) {
        data[key] = items
        i = j - 1
      } else {
        data[key] = null
      }
      continue
    }

    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value.slice(1, -1).split(',').map((s) => _scalar(s.trim())).filter((s) => s !== '')
      continue
    }

    data[key] = _scalar(value)
  }
  return { data, content }
}

function _scalar(v) {
  let s = String(v).trim()
  // strip inline comments only on unquoted values
  const quoted = (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
    || (s.startsWith('"') && s.endsWith('"') && s.length >= 2)
  if (quoted) {
    s = s.slice(1, -1)
    if (v[0] === '"') s = s.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    else s = s.replace(/''/g, "'")
    return s
  }
  if (s === 'null' || s === '~') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (s !== '' && !Number.isNaN(Number(s)) && /^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  return s
}

function stringify(content, data) {
  const lines = ['---']
  for (const [key, value] of Object.entries(data || {})) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      lines.push(`${key}:`)
      for (const item of value) lines.push(`  - ${_quote(item)}`)
    } else {
      lines.push(`${key}: ${_quote(value)}`)
    }
  }
  lines.push('---')
  return lines.join('\n') + '\n' + String(content || '')
}

function _quote(v) {
  if (v === null) return 'null'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  const s = String(v)
  // quote when YAML would misread it
  if (s === '' || /[:#'"\n[\]{}|>&*!%@`]/.test(s) || /^\s|\s$/.test(s)
    || ['null', 'true', 'false', '~'].includes(s) || /^-?\d/.test(s)) {
    return "'" + s.replace(/'/g, "''") + "'"
  }
  return s
}

module.exports = { parse, stringify }
