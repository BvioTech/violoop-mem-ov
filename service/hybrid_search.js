// Optional literal-keyword branch over native OpenViking grep. This module
// fuses evidence without inventing a comparable vector score for regex hits.
const { PREVIEW_CHARS, withTruncationNotice } = require('./retrieval_budget')
const invalid = message => Object.assign(new Error(message), { status: 400, code: 'invalid_query' })
const canonical = value => value.replace(/\/(\.abstract|\.overview)\.md$/, '').replace(/\/$/, '')
const levelOf = value => value.endsWith('/.abstract.md') ? 0 : value.endsWith('/.overview.md') ? 1 : 2
const typeOf = value => {
  if (/^viking:\/\/(resources(?:\/|$)|user\/[^/]+\/(?:peers\/[^/]+\/)?resources(?:\/|$))/.test(value)) return 'resource'
  if (/^viking:\/\/(agent\/skills(?:\/|$)|user\/[^/]+\/(?:peers\/[^/]+\/)?skills(?:\/|$))/.test(value)) return 'skill'
  return 'memory'
}

function keywordsPattern(value) {
  if (value === undefined) return ''
  if (!Array.isArray(value) || value.length > 8 || value.some(k => typeof k !== 'string' || !k.trim() || k.length > 60)) {
    throw invalid('keywords must contain at most 8 non-empty literal strings of at most 60 characters each')
  }
  const unique = new Map()
  for (const keyword of value) unique.set(keyword.trim().toLowerCase(), keyword.trim())
  return [...unique.values()].map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
}

function mergeSearch(semantic, matches, { limit = 10, maxChars = 8000, level } = {}) {
  limit = Math.min(limit, 10)
  let lexical = new Map()
  for (const match of matches) {
    const matchLevel = levelOf(match.uri)
    if (level !== undefined && matchLevel !== level) continue
    const key = canonical(match.uri)
    let hit = lexical.get(key)
    if (!hit) {
      hit = { key, uri: key, title: key.split('/').pop().replace(/\.md$/, '').slice(0, 120), level: matchLevel,
        score: null, contextType: typeOf(key),
        keywordMatches: [], keywordTruncated: false }
      lexical.set(key, hit)
    }
    if (hit.keywordMatches.some(m => m.uri === match.uri && m.line === match.line)) continue
    if (hit.keywordMatches.length < 3) hit.keywordMatches.push({ ...match, level: matchLevel })
    else hit.keywordTruncated = true
  }
  // Cap both candidate pools before cross-branch deduplication. A shared
  // document uses one semantic slot and carries both kinds of evidence.
  lexical = new Map([...lexical].slice(0, limit))
  const semanticGroup = []
  for (const [index, hit] of semantic.slice(0, limit).entries()) {
    const key = canonical(hit.uri)
    const keywordHit = lexical.get(key)
    if (keywordHit) {
      semanticGroup.push({ ...hit, group: 'semantic', semanticRank: index + 1,
        keywordMatches: keywordHit.keywordMatches, keywordTruncated: keywordHit.keywordTruncated })
      lexical.delete(key)
    } else semanticGroup.push({ ...hit, group: 'semantic', semanticRank: index + 1, keywordMatches: [] })
  }
  const keywordGroup = [...lexical.values()].map(hit => ({ ...hit, group: 'keyword' }))
  const selected = []
  let used = 0
  // Select round-robin, preserving order inside each pool. Never shorten a
  // preview merely to fit the remaining total budget or skip ahead past it.
  selection: for (let i = 0; i < Math.max(semanticGroup.length, keywordGroup.length); i++) {
    for (const hit of [semanticGroup[i], keywordGroup[i]]) {
      if (!hit) continue
      const rendered = renderPreview(hit)
      if (used + rendered.content.length > maxChars) break selection
      selected.push(rendered)
      used += rendered.content.length
    }
  }
  // Selection is interleaved; display remains grouped without implying that
  // keyword matches have a semantic relevance score.
  return [...selected.filter(hit => hit.group === 'semantic'), ...selected.filter(hit => hit.group === 'keyword')]
}

function renderPreview(hit) {
  const perHitChars = PREVIEW_CHARS
  const hasSemantic = Number.isFinite(hit.score)
  const hasKeyword = hit.keywordMatches.length > 0
  const sources = [...(hasSemantic ? ['semantic'] : []), ...(hasKeyword ? ['keyword'] : [])]
  const semanticText = hasSemantic ? String(hit.abstract || hit.content || '') : ''
  const keywordText = hit.keywordMatches.map(m => `[L${m.level} line ${m.line}] ${m.content}`).join('\n')
  const blocks = []
  // Split a dual hit's preview between its two evidence types before final
  // clipping, so a long directory summary cannot hide keyword evidence.
  const semanticBudget = hasKeyword ? Math.floor(Math.max(0, perHitChars - 24) / 2) : Math.max(0, perHitChars - 11)
  if (hasSemantic) blocks.push('[Semantic]\n' + semanticText.slice(0, semanticBudget))
  const remaining = Math.max(0, perHitChars - blocks.join('\n').length - (blocks.length ? 1 : 0) - 10)
  if (hasKeyword) blocks.push('[Keyword]\n' + keywordText.slice(0, remaining))
  const content = blocks.join('\n').slice(0, perHitChars)
  return withTruncationNotice({ ...hit, score: hasSemantic ? hit.score : null, semanticScore: hasSemantic ? hit.score : null,
    retrievalSources: sources, abstract: content, content,
    keywordMatches: hit.keywordMatches.map(m => ({ uri: m.uri, line: m.line, level: m.level })),
    truncated: !!hit.truncated || !!hit.keywordTruncated || semanticText.length > semanticBudget || keywordText.length > remaining })
}

module.exports = { keywordsPattern, mergeSearch }
