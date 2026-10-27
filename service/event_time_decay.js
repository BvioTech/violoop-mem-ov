// Automatic recall uses a fixed protection period. Explicit periods or null
// always win. Query wording and date filters do not change this policy.
const DEFAULT_PROTECTION = '30d'
const MAX_DURATION_MS = 3000 * 365 * 24 * 60 * 60 * 1000

function eventTimeDecay(body, { automatic = false } = {}) {
  const camel = body.eventsTimeDecayProtection, snake = body.events_time_decay_protection
  const invalid = message => Object.assign(new Error(message), { status: 400, code: 'invalid_query' })
  if (camel !== undefined && snake !== undefined && camel !== snake) throw invalid('Conflicting event time-decay parameters')
  const value = camel !== undefined ? camel : snake !== undefined ? snake : automatic ? 'auto' : undefined
  if (value === undefined || value === null) return value
  if (value === 'auto') return DEFAULT_PROTECTION
  if (typeof value !== 'string' || !/^(?:0|\d+[mhd])$/.test(value)) throw invalid('eventsTimeDecayProtection must be null, auto, 0, or a duration such as 30d')
  const duration = value === '0' ? 0 : Number(value.slice(0, -1)) * { m: 60000, h: 3600000, d: 86400000 }[value.at(-1)]
  if (!Number.isFinite(duration) || duration > MAX_DURATION_MS) throw invalid('Event time-decay protection exceeds 1095000d')
  return value
}

module.exports = { eventTimeDecay, DEFAULT_PROTECTION }
