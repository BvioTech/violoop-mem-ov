// Panel writes use native schemas and native content/write. No model call is
// needed to choose a URI; OpenViking owns the subsequent summaries and vectors.
const { validateVikingUri } = require('./openviking_uri')
const TYPES = ['entities', 'events', 'preferences', 'profile']
const fail = message => Object.assign(new Error(message), { status: 400, code: 'invalid_query' })
function segment(value, field, lower = false) {
  if (typeof value !== 'string' || !value.trim()) throw fail(`${field} is required`)
  const text = value.trim().normalize('NFC')
  if (text.length > 120 || text.startsWith('.') || /[/\\\x00-\x1f\x7f]/.test(text)) throw fail(`Invalid ${field}`)
  return lower ? text.toLowerCase() : text
}
function filename(value) {
  // Native content/write normalizes whitespace-bearing segments. Normalize
  // names before previewing so the shown URI is exactly the stored URI.
  let safe = value.replace(/[^\p{L}\p{N}_.-]/gu, '_').replace(/_+/g, '_').replace(/^[_.]+|[_.]+$/g, '')
  safe = [...safe].slice(0, 46).join('') || 'unnamed'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = '_' + safe
  return safe
}
function planMemory(body, client) {
  const memoryType = body.memoryType
  if (!TYPES.includes(memoryType)) throw fail('Choose entities, events, preferences or profile')
  const root = `viking://user/${client.user}/memories`
  let suffix, fields = {}
  if (memoryType === 'entities') {
    const category = segment(body.category, 'category'), name = segment(body.name, 'name')
    fields = { category, name }; suffix = `entities/${filename(category.toLowerCase())}/${filename(name.toLowerCase())}.md`
  } else if (memoryType === 'preferences') {
    const user = segment(body.owner, 'owner'), topic = segment(body.topic, 'topic')
    fields = { user, topic }; suffix = `preferences/${filename(user.toLowerCase())}/${filename(topic.toLowerCase())}.md`
  } else if (memoryType === 'events') {
    const name = segment(body.name, 'name'), date = body.date
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw fail('Choose a valid event date')
    fields = { event_name: name, event_date: date, goal: name, summary: body.content || '', ranges: '' }
    suffix = `events/${date.replaceAll('-', '/')}/${filename(name)}.md`
  } else suffix = 'profile.md'
  const uri = root + '/' + suffix
  validateVikingUri(uri)
  return { uri, key: uri, level: 2, memoryType, fields }
}
async function previewMemory(body, client) {
  const plan = planMemory(body, client)
  let exists = false
  try { await client.stat(plan.uri); exists = true }
  catch (e) { if (e.upstreamStatus !== 404 && e.status !== 404) throw e }
  return { ...plan, exists }
}
function serializeMemory(plan, content) {
  if (typeof content !== 'string' || !content.trim() || content.length > 1000000) throw fail('content is required (maximum 1000000 characters)')
  if (/<!--\s*MEMORY_FIELDS\b/i.test(content)) throw fail('Reserved memory metadata cannot be entered in the body')
  const now = new Date().toISOString()
  const fields = { ...plan.fields, memory_type: plan.memoryType, version: 1, created_at: now, updated_at: now }
  return content + '\n\n<!-- MEMORY_FIELDS\n' + JSON.stringify(fields, null, 2).replaceAll('-->', '--\\u003e') + '\n-->'
}
module.exports = { planMemory, previewMemory, serializeMemory }
