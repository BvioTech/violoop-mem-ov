/**
 * Compatible CLI/env/qmd.yaml configuration for the managed OpenViking service.
 * Historical zone keys remain parseable but OpenViking owns memory layout and
 * retrieval. Source defaults resolve this repository's engine and virtualenv;
 * installed packages retain /opt/violoop-mem-ov/openviking-python.
 */

const fs = require('fs')
const path = require('path')

// Matches violoop-edge config/qmd.yaml (the reference zone tuning) so a box
// with no config file behaves identically to the shipped default.
const DEFAULT_ZONES = [
  { name: 'core', keyPrefix: 'core', maxDepth: 3, maxItems: 20, defaultType: 'core' },
  { name: 'daily', keyPrefix: 'daily', maxDepth: 2, defaultType: 'daily', defaultHalfLife: 30 },
  { name: 'working', keyPrefix: 'working', maxDepth: 3, defaultType: 'working', defaultHalfLife: 7 },
  { name: 'life', keyPrefix: 'life', maxDepth: 5, defaultType: 'archival', defaultHalfLife: 90 },
  { name: 'work', keyPrefix: 'work', maxDepth: 5, defaultType: 'archival', defaultHalfLife: 180 },
  { name: 'knowledge', keyPrefix: 'knowledge', maxDepth: 5, defaultType: 'archival', defaultHalfLife: 180 },
]

function loadConfig(argv = process.argv.slice(2), env = process.env) {
  const args = _parseArgs(argv)

  const configPath = args.config || env.QMD_CONFIG
    || (fs.existsSync('/etc/qmd/qmd.yaml') ? '/etc/qmd/qmd.yaml' : null)
  const fileCfg = configPath ? _parseYamlSubset(fs.readFileSync(configPath, 'utf-8')) : {}

  const socket = args.socket || fileCfg.socket
    || (process.platform === 'win32' ? '\\\\.\\pipe\\violoop-mem-ov' : '/run/violoop-mem-ov/violoop-mem-ov.sock')
  const dataDir = args['data-dir'] || env.VIOLOOP_MEM_OV_DATA_DIR || env.QMD_DATA_DIR || fileCfg.data_dir
    || path.join(process.cwd(), 'data')

  // HTTP listener is OPT-IN (debug/UI access). The socket is the product
  // surface; a TCP port exposing unauthenticated memory read/write must be
  // asked for explicitly, and binds loopback unless overridden.
  const httpPort = _int(args['http-port'] ?? env.QMD_HTTP_PORT ?? fileCfg.http_port)
  const httpHost = args['http-host'] || env.QMD_HTTP_HOST || fileCfg.http_host || '127.0.0.1'

  const embeddingCfg = (fileCfg.embedding && !Array.isArray(fileCfg.embedding)) ? fileCfg.embedding : {}
  return {
    backend: args.backend || env.VIOLOOP_MEM_OV_BACKEND || fileCfg.backend || 'openviking',
    openviking: {
      mode: args['openviking-mode'] || env.OPENVIKING_MODE || fileCfg.openviking?.mode || 'managed',
      python: env.OPENVIKING_PYTHON || (fs.existsSync(path.join(__dirname, '../.venv/bin/python')) ? path.join(__dirname, '../.venv/bin/python') : '/usr/bin/python3'),
      pythonPath: env.OPENVIKING_PYTHONPATH || (fs.existsSync(path.join(__dirname, '../engine/openviking/server/bootstrap.py')) ? path.join(__dirname, '../engine') : '/opt/violoop-mem-ov/openviking-python'),
      runtimeDir: env.OPENVIKING_RUNTIME_DIR || path.dirname(socket),
      deviceModelUrl: env.OPENVIKING_DEVICE_MODEL_URL || 'http://127.0.0.1:9090/internal/memory/chat/completions',
      llmMaxTokens: Number(env.OPENVIKING_LLM_MAX_TOKENS || 4096),
      legacySourceFile: env.VIOLOOP_LEGACY_MEMORY_DB || path.join(dataDir, 'graph.db'),
      migrationEmbedding: {
        timeoutMs: Number(env.VIOLOOP_MIGRATION_EMBEDDING_TIMEOUT_MS || 60000),
      },
      url: args['openviking-url'] || env.OPENVIKING_URL || fileCfg.openviking?.url || 'http://127.0.0.1:1933',
      apiKey: env.OPENVIKING_API_KEY || '',
      account: env.OPENVIKING_ACCOUNT || fileCfg.openviking?.account || 'default',
      user: env.OPENVIKING_USER || fileCfg.openviking?.user || 'default',
      actorPeer: env.OPENVIKING_ACTOR_PEER || fileCfg.openviking?.actor_peer || 'violoop',
      timeoutMs: Number(env.OPENVIKING_TIMEOUT_MS ?? fileCfg.openviking?.timeout_ms ?? 15000),
      recallMaxChars: Number(env.OPENVIKING_RECALL_MAX_CHARS ?? fileCfg.openviking?.recall_max_chars ?? 2500),
      searchMaxChars: Number(env.OPENVIKING_SEARCH_MAX_CHARS ?? fileCfg.openviking?.search_max_chars ?? 8000),
      abstractMaxChars: Number(env.OPENVIKING_ABSTRACT_MAX_CHARS ?? fileCfg.openviking?.abstract_max_chars ?? 600),
      readMaxChars: Number(env.OPENVIKING_READ_MAX_CHARS ?? fileCfg.openviking?.read_max_chars ?? 6000),
    },
    configPath,
    socket,
    dataDir,
    httpPort: httpPort || null,
    httpHost,
    socketMode: args['socket-mode'] || fileCfg.socket_mode || null,
    socketGroup: args['socket-group'] || fileCfg.socket_group || null,
    // 旧 qmd 的 markdown 存量目录(qmd.yaml memory_dir)——首启空库时自动导入用
    legacyMemoryDir: fileCfg.memory_dir || null,
    embedding: {
      // Same default as the qmd deb config: enabled, degrade when the model
      // file is absent. auto_rerank is accepted-but-ignored (not ported).
      enabled: args['no-embedding'] ? false : embeddingCfg.enabled !== false,
      modelPath: args['embedding-model'] || embeddingCfg.model_path || null,
    },
    zones: Array.isArray(fileCfg.zones) && fileCfg.zones.length
      ? fileCfg.zones.map(_normalizeZone).filter(Boolean)
      : DEFAULT_ZONES,
  }
}

function _parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const name = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { out[name] = next; i++ }
    else out[name] = true
  }
  return out
}

function _int(v) {
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : null
}

function _normalizeZone(z) {
  if (!z || !z.key_prefix && !z.keyPrefix) return null
  return {
    name: z.name || z.key_prefix || z.keyPrefix,
    keyPrefix: z.key_prefix || z.keyPrefix,
    maxItems: _int(z.max_items ?? z.maxItems) || undefined,
    maxDepth: _int(z.max_depth ?? z.maxDepth) || undefined,
    defaultType: z.default_type || z.defaultType || undefined,
    defaultHalfLife: (z.default_half_life ?? z.defaultHalfLife) !== undefined
      ? Number(z.default_half_life ?? z.defaultHalfLife)
      : undefined,
  }
}

/**
 * Line-based YAML subset parser. Supports exactly what qmd.yaml uses:
 *   - `key: value` at column 0
 *   - `zones:` followed by `  - key: value` items with `    key: value`
 *     continuation lines
 *   - flat nested maps (`embedding:` + `  enabled: true`)
 *   - comments / blank lines
 * Deeper nesting is not modeled and gets skipped.
 */
function _parseYamlSubset(text) {
  const out = {}
  const lines = String(text || '').split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) { i++; continue }

    const top = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
    if (!top) { i++; continue }
    const key = top[1]
    const rest = _stripComment(top[2])

    if (rest !== '') {
      out[key] = _scalar(rest)
      i++
      continue
    }

    // block value: a list of objects, or a flat nested map
    const items = []
    const map = {}
    let mapKeys = 0
    let j = i + 1
    while (j < lines.length) {
      const l = lines[j]
      if (!l.trim() || l.trim().startsWith('#')) { j++; continue }
      if (!/^\s/.test(l)) break // next top-level key

      const itemStart = l.match(/^\s+-\s+([A-Za-z0-9_]+):\s*(.*)$/)
      if (itemStart) {
        const obj = {}
        obj[itemStart[1]] = _scalar(_stripComment(itemStart[2]))
        items.push(obj)
        j++
        continue
      }
      const prop = l.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/)
      if (prop) {
        if (items.length) {
          items[items.length - 1][prop[1]] = _scalar(_stripComment(prop[2]))
        } else if (_stripComment(prop[2]) !== '') {
          map[prop[1]] = _scalar(_stripComment(prop[2]))
          mapKeys++
        }
        j++
        continue
      }
      j++ // deeper nesting we don't model — skip
    }
    if (items.length) out[key] = items
    else if (mapKeys) out[key] = map
    i = j
  }
  return out
}

function _stripComment(s) {
  const idx = s.search(/\s#/)
  return (idx >= 0 ? s.slice(0, idx) : s).trim()
}

function _scalar(v) {
  let s = String(v).trim()
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1)
  }
  if (s === 'true') return true
  if (s === 'false') return false
  if (s !== '' && /^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  return s
}

module.exports = { loadConfig, DEFAULT_ZONES, _parseYamlSubset }
