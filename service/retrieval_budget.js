// Budgets count preview text only; titles, URIs and truncation notices are separate.
const PREVIEW_CHARS = 800
const TRUNCATION_NOTICE = 'Preview truncated. Use memory.get with level=2 and this URI to read the file; follow next while hasMore is true.'

function withTruncationNotice(hit) {
  return hit.truncated ? { ...hit, truncationNotice: TRUNCATION_NOTICE } : hit
}

function boundPreviews(hits, totalChars, perHitChars = PREVIEW_CHARS) {
  const previews = hits.map(h => String(h.abstract || h.content || ''))
  const lengths = new Array(hits.length)
  let remaining = totalChars
  const ordered = previews.map((text, index) => ({ index, length: Math.min(text.length, perHitChars) }))
    .sort((a, b) => a.length - b.length)
  for (let i = 0; i < ordered.length; i++) {
    const { index, length } = ordered[i]
    lengths[index] = Math.min(length, Math.floor(remaining / (ordered.length - i)))
    remaining -= lengths[index]
  }
  return hits.map((hit, index) => withTruncationNotice({ ...hit,
    abstract: previews[index].slice(0, lengths[index]),
    content: previews[index].slice(0, lengths[index]),
    truncated: !!hit.truncated || previews[index].length > lengths[index],
  }))
}

module.exports = { PREVIEW_CHARS, withTruncationNotice, boundPreviews }
