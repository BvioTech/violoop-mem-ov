// Viking paths are identifiers, not HTTP URLs. Keep filename characters
// literal; OpenVikingClient encodes them at the HTTP transport boundary.
function validateVikingUri(value) {
  const invalid = () => Object.assign(new Error('key/prefix must be a viking:// URI without control characters or traversal'),
    { status: 400, code: 'invalid_uri' })
  if (typeof value !== 'string' || !value.startsWith('viking://') || /[\\\x00-\x1f\x7f]/.test(value)) throw invalid()
  for (const segment of value.slice(9).split('/')) {
    // Check escaped separators/traversal too, without decoding the identifier
    // sent upstream. A literal percent sign is allowed in an ordinary name.
    let decoded = segment
    try { decoded = decodeURIComponent(segment) } catch { /* Literal %, not an encoded segment. */ }
    if (decoded === '.' || decoded === '..' || /[/\\\x00-\x1f\x7f]/.test(decoded)) throw invalid()
  }
  return value
}

module.exports = { validateVikingUri }
