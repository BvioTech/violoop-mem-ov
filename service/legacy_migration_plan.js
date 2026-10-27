const { encode } = require('gpt-tokenizer/encoding/o200k_base')
const { hash, observationHash } = require('./legacy_source')

const MAX_TOKENS = 5000
const SOURCE_PREFIX = 'violoop-legacy-migration:'
const INTRO = '旧记忆迁移材料。以下是旧系统保存的记录，不是用户当前发言。按事实含义提取所有适合的记忆类型，不强制条目=events或实体=entities。相同旧ID表示相同来源，不是重复确认；保留关系方向和不确定性。记录时间作为该材料的相对时间参照，不是迁移时间，也不必然是事件发生时间。明确日期以正文为准，不生成“执行迁移”事件。'
const countMessages = messages => messages.reduce((n, m) => n + encode(m.role + '\n' + m.content + '\n' + m.createdAt).length + 8, 0)
const obsKey = (e, o) => `observation:${e.id}:${observationHash(o)}`
const entKey = e => `entity:${e.id}`
const relKey = r => `relation:${r.id}`
const noteKey = m => `memory:${m.id}`

function timestamp(value) {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Legacy record has invalid created_at: ${String(value)}`)
  }
  return new Date(value).toISOString()
}
function identity(e) { return { id: e.id, name: e.name, type: e.type, aliases: e.aliases } }
function card(e, observations) {
  return { ...identity(e), observations, properties: e.properties, domains: e.domains, curated: !!e.curated }
}

function planMigration(snapshot, { maxTokens = MAX_TOKENS, count = countMessages } = {}) {
  const entities = new Map(snapshot.entities.map(e => [e.id, e]))
  const relations = new Map(snapshot.relations.map(r => [r.id, r]))
  const covered = new Set(), resources = [], associated = [], remaining = []
  const relationData = r => {
    const source = entities.get(r.source), target = entities.get(r.target)
    if (!source || !target) throw new Error(`Legacy relation ${r.id} has a missing endpoint`)
    return { id: r.id, source: identity(source), target: identity(target), relationType: r.relation_type,
      properties: r.properties, confidence: r.confidence, validUntil: r.valid_until, decay: r.decay }
  }
  function group(id, type, data, createdAt, claims) {
    const time = timestamp(createdAt)
    return { id, claims: [...new Set(claims)], messages: [{
      id: SOURCE_PREFIX + hash(id), role: 'user', createdAt: time,
      content: INTRO + '\n来源类型：' + type + '\n记录时间：' + time + '\n' + JSON.stringify(data),
    }] }
  }
  for (const m of snapshot.memories) {
    resources.push({ id: noteKey(m), claims: [noteKey(m)] })
    const a = snapshot.associations[m.key] || { observations: {}, relations: [] }
    const related = [], claims = [noteKey(m)]
    for (const [id, hashes] of Object.entries(a.observations)) {
      const e = entities.get(id)
      if (!e) continue
      const observations = e.observations.filter(o => hashes.includes(observationHash(o)))
      related.push(card(e, observations))
      claims.push(entKey(e), ...observations.map(o => obsKey(e, o)))
    }
    const links = a.relations.map(id => relations.get(id)).filter(Boolean)
    claims.push(...links.map(relKey))
    const g = group(noteKey(m), '旧条目式记忆及其来源关联', {
      entry: { id: m.id, key: m.key, title: m.title, content: m.content,
        type: m.type, tags: m.tags ? JSON.parse(m.tags) : [], updatedAt: m.updated_at },
      entities: related, relations: links.map(relationData),
    }, m.created_at, claims)
    if (related.length || links.length) { associated.push(g); claims.forEach(c => covered.add(c)) }
    else remaining.push(g)
  }
  for (const e of snapshot.entities) {
    const all = [entKey(e), ...e.observations.map(o => obsKey(e, o))]
    resources.push({ id: entKey(e), claims: [...new Set(all)] })
    const observations = e.observations.filter(o => !covered.has(obsKey(e, o)))
    const claims = all.filter(c => !covered.has(c))
    if (claims.length) remaining.push(group(entKey(e), '旧实体剩余事实', card(e, observations), e.created_at, claims))
  }
  for (const r of snapshot.relations) {
    resources.push({ id: relKey(r), claims: [relKey(r)] })
    if (!covered.has(relKey(r))) remaining.push(group(relKey(r), '旧关系', relationData(r), r.created_at, [relKey(r)]))
  }
  const batches = []
  let batch = { messages: [], claims: [], groups: [], tokens: 0 }
  const flush = () => {
    if (!batch.messages.length) return
    batch.claims = [...new Set(batch.claims)]
    batch.id = hash(JSON.stringify(batch.messages))
    batches.push(batch)
    batch = { messages: [], claims: [], groups: [], tokens: 0 }
  }
  for (const g of [...associated, ...remaining]) {
    const tokens = count(g.messages)
    if (batch.messages.length && batch.tokens + tokens > maxTokens) flush()
    batch.messages.push(...g.messages); batch.claims.push(...g.claims)
    batch.groups.push(g.id); batch.tokens += tokens
    if (batch.tokens >= maxTokens) flush() // oversized indivisible groups travel alone
  }
  flush()
  return { resources, batches, tokenizer: 'o200k_base', maxTokens }
}

module.exports = { planMigration, countMessages, MAX_TOKENS, SOURCE_PREFIX }
