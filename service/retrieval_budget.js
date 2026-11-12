// Budgets count preview text and its truncation marker, in UTF-16 code units.
// Titles, URIs, metadata and the separate read-more notice are not included.
const MAX_BUDGET_CHARS = 100000
const TRUNCATION_MARKER = '\n…[truncated]'
const TRUNCATION_NOTICE = 'Preview truncated. Use memory.get with level=2 and this URI to read the file; follow next while hasMore is true.'

function previewBudget(value, fallback = 8000) {
  const budget = value === undefined ? fallback : value
  if (!Number.isInteger(budget) || budget < 1 || budget > MAX_BUDGET_CHARS) {
    throw Object.assign(new Error(`budgetChars must be an integer in [1, ${MAX_BUDGET_CHARS}]`),
      { status: 400, code: 'invalid_query' })
  }
  return budget
}
function withTruncationNotice(hit) {
  return hit.truncated ? { ...hit, truncationNotice: TRUNCATION_NOTICE } : hit
}
function prefix(text, length) {
  // A UTF-16 budget must not leave half of an emoji at the cut.
  if (length > 0 && /[\uD800-\uDBFF]/.test(text[length - 1])) length--
  return text.slice(0, length)
}
function truncatePreview(text, budget) {
  if (text.length <= budget) return text
  if (!budget) return ''
  const marker = budget < TRUNCATION_MARKER.length ? '…' : TRUNCATION_MARKER
  return prefix(text, budget - marker.length) + marker
}
function boundPreviews(hits, totalChars) {
  totalChars = previewBudget(totalChars)
  const previews = hits.map(h => String(h.abstract || h.content || ''))
  const lengths = new Array(hits.length)
  let remaining = totalChars
  const ordered = previews.map((text, index) => ({ index, length: text.length }))
    .sort((a, b) => a.length - b.length)
  // Allocate short entries first so their savings go to longer entries.
  for (let i = 0; i < ordered.length; i++) {
    const { index, length } = ordered[i]
    lengths[index] = Math.min(length, Math.floor(remaining / (ordered.length - i)))
    remaining -= lengths[index]
  }
  return hits.map((hit, index) => {
    const content = truncatePreview(previews[index], lengths[index])
    return withTruncationNotice({ ...hit, abstract: content, content,
      truncated: !!hit.truncated || previews[index].length > lengths[index] })
  })
}
module.exports = { MAX_BUDGET_CHARS, TRUNCATION_MARKER, previewBudget, withTruncationNotice, boundPreviews }
