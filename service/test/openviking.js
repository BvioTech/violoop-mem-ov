// Real HTTP + Unix socket contract tests with a deterministic native API stub.
// These verify integration behavior, not OpenViking's model/retrieval quality.
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { once } = require('events')
const { spawn } = require('child_process')
const { start } = require('../server')
const { loadConfig } = require('../config')
const { mergeSearch } = require('../hybrid_search')
const { boundPreviews } = require('../retrieval_budget')

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-ov-'))
const socket = path.join(temp, 'mem.sock')
const calls = []
let adapter, upstream, config
let ready = true, behavior = 'ok', taskStatus = 'completed'
let hybridGrepStarted = false, releaseHybridSearch
const uri = 'viking://user/test/memories/preferences/deployment.md'
const hit = { uri, abstract: 'Deployment preferences', content: '# Deployment preferences\n' + '分批部署并验证日志。'.repeat(1000), score: 0.91, level: 2, context_type: 'memory' }

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, method, path: route, agent: false, headers: { 'content-type': 'application/json' } }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

before(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
    calls.push({ route: req.url, body, headers: req.headers })
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    if (req.url === '/ready') return send(ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready', violoop_legacy_migration: 1, violoop_migration_embedding: 1 })
    if (behavior === 'error' || (behavior === 'commit_error' && req.url.endsWith('/commit'))) return send(500, { status: 'error', error: { message: 'native extraction failed' } })
    if (behavior === 'timeout') return // client must time out without a local fallback
    if (req.url === '/api/v1/search/grep') {
      assert.deepEqual(Object.keys(body).sort(), ['case_insensitive', 'node_limit', 'pattern', 'uri'])
      if (body.pattern === '[') return send(400, { status: 'error', error: { message: 'invalid regular expression' } })
      if (behavior === 'malformed') return send(200, { status: 'ok', result: {} })
      if (behavior === 'search_limits') return send(200, { status: 'ok', result: {
        matches: Array.from({ length: 30 }, (_, i) => ({ uri: `viking://user/test/memories/k-${i}.md`, line: 1, content: '乙'.repeat(2000) })),
      } })
      if (behavior.startsWith('hybrid')) {
        hybridGrepStarted = true
        releaseHybridSearch?.()
        if (behavior === 'hybrid_grep_error') return send(500, { status: 'error', error: { message: 'grep unavailable' } })
        const pattern = new RegExp(body.pattern, body.case_insensitive ? 'i' : '')
        const documents = [
          { uri: behavior === 'hybrid_secondary' ? uri + '2' : uri, line: 7, content: '海拉尔项目部署的原始证据。' + '证据'.repeat(2000) },
          { uri: behavior === 'hybrid_secondary' ? uri + '2' : uri, line: 7, content: '海拉尔项目部署的原始证据。' + '证据'.repeat(2000) },
          { uri: 'viking://user/test/memories/events/travel.md', line: 3, content: '呼伦贝尔航班安排' },
          { uri: 'viking://user/test/memories/literal.md', line: 4, content: 'C++ bge.m3 file[1] a|b x\\y' },
          { uri: 'viking://user/test/memories/wrong.md', line: 5, content: 'C bgeXm3 file1 a b xy' },
        ]
        const matches = documents.filter(m => pattern.test(m.content))
        return send(200, { status: 'ok', result: { matches, files_scanned: documents.length } })
      }
      const matches = body.pattern === 'sidecars'
        ? [{ uri: 'viking://user/test/memories/.abstract.md', line: 4, content: 'abstract' }, { uri: 'viking://user/test/memories/.overview.md', line: 5, content: 'overview' }]
        : body.pattern === 'NOT_PRESENT' ? [] : body.pattern === 'many'
        ? Array.from({ length: 60 }, (_, i) => ({ uri, line: i + 1, content: '匹配片段'.repeat(1000) }))
        : [{ uri, line: 7, content: '海拉尔旅行计划' }, { uri, line: 8, content: '呼伦贝尔'.repeat(1000) }]
      return send(200, { status: 'ok', result: { matches, count: matches.length, files_scanned: 3 } })
    }
    if (req.url.startsWith('/api/v1/search/')) {
      const allowed = ['query', 'limit', 'read_content', 'score_threshold', 'target_uri', 'session_id', 'level', 'events_time_decay_protection']
      assert.ok(Object.keys(body).every(k => allowed.includes(k)))
      if (behavior === 'hybrid_parallel' && !hybridGrepStarted) await new Promise(resolve => { releaseHybridSearch = resolve })
      if (behavior === 'hybrid_search_error') return send(500, { status: 'error', error: { message: 'semantic search unavailable' } })
      if (behavior === 'hybrid_empty_semantic') return send(200, { status: 'ok', result: { memories: [], resources: [], skills: [] } })
      if (behavior === 'malformed') return send(200, { status: 'ok', result: {} })
      if (behavior === 'search_limits') return send(200, { status: 'ok', result: {
        memories: Array.from({ length: 30 }, (_, i) => ({ ...hit, uri: `viking://user/test/memories/s-${i}.md`, abstract: '甲'.repeat(2000), score: 0.9 - i * 0.01 })),
        resources: [], skills: [],
      } })
      if (behavior === 'mixed_recall') return send(200, { status: 'ok', result: {
        memories: Array.from({ length: 12 }, (_, i) => ({ ...hit,
          uri: `viking://user/test/memories/candidate-${i}/` + ['.abstract.md', '.overview.md', 'note.md'][i % 3],
          level: i % 3, score: 0.59 - i * 0.01, abstract: '记忆预览'.repeat(1000),
        })), resources: [], skills: [],
      } })
      return send(200, { status: 'ok', result: {
        memories: [hit, { ...hit, uri: uri + '2', score: 0.3 }],
        resources: [{ ...hit, score: 0.8 }], skills: [],
      } })
    }
    const u = new URL(req.url, 'http://stub')
    if (u.pathname === '/api/v1/fs/stat') return send(u.searchParams.get('uri').includes('missing') ? 404 : 200, { status: 'ok', result: { isDir: !u.searchParams.get('uri').endsWith('.md'), modTime: '2026-10-10T01:00:00Z' } })
    if (u.pathname === '/api/v1/content/abstract') return send(200, { status: 'ok', result: '目录摘要' })
    if (u.pathname === '/api/v1/content/overview') return send(200, { status: 'ok', result: '目录概览' })
    if (u.pathname === '/api/v1/content/read') {
      if (u.searchParams.get('uri').endsWith('/very-long.md')) return send(200, { status: 'ok', result: '长'.repeat(65000) })
      const lines = fullText.match(/[^\n]*\n|[^\n]+$/g) || []
      const offset = Number(u.searchParams.get('offset') || 0), limit = Number(u.searchParams.get('limit') || 80)
      return send(200, { status: 'ok', result: (limit === -1 ? lines.slice(offset) : lines.slice(offset, offset + limit)).join('') })
    }
    if (u.pathname === '/api/v1/fs/ls' && u.searchParams.get('output') === 'original') {
      assert.equal(u.searchParams.get('show_all_hidden'), 'true')
      assert.equal(u.searchParams.get('recursive'), 'false')
      const root = 'viking://user/test/memories'
      const dir = u.searchParams.get('uri').replace('viking://~', 'viking://user/test')
      const dirItem = suffix => ({ uri: root + suffix, isDir: true })
      const fileItem = suffix => ({ uri: root + suffix, isDir: false })
      const fixtures = {
        [root]: [dirItem('/preferences'), dirItem('/events'), fileItem('/.abstract.md'), fileItem('/.overview.md'), fileItem('/.internal.json'), { ...dirItem('/private'), access: 'denied' }],
        [root + '/preferences']: [dirItem('/preferences/deep')],
        [root + '/preferences/deep']: [fileItem('/preferences/deep/.overview.md'), fileItem('/preferences/deep/note.md')],
        [root + '/events']: [dirItem('/events/2026')],
        [root + '/events/2026']: [dirItem('/events/2026/10')],
        [root + '/events/2026/10']: [dirItem('/events/2026/10/10')],
        [root + '/events/2026/10/10']: [fileItem('/events/2026/10/10/hailar.md')],
      }
      const items = fixtures[dir] || []
      const offset = Number(u.searchParams.get('offset'))
      return send(200, { status: 'ok', result: items.slice(offset, offset + 2), has_more: offset + 2 < items.length })
    }
    if (u.pathname === '/api/v1/fs/ls') return send(200, { status: 'ok', result: [{ uri, name: 'deployment.md', isDir: false }], has_more: true })
    if (req.url.endsWith('/messages/batch')) {
      assert.ok(body.messages.length <= 100)
      assert.ok(body.messages.every(m => typeof m.role === 'string' && typeof m.content === 'string'))
      return send(200, { status: 'ok', result: { added: body.messages.length } })
    }
    if (req.url.endsWith('/commit')) {
      assert.deepEqual(body, { keep_recent_count: 0 })
      return send(200, { status: 'ok', result: { status: 'accepted', task_id: 'native-task', archive_uri: 'viking://user/test/sessions/archive_001' } })
    }
    if (req.url.startsWith('/api/v1/tasks/')) return send(200, { status: 'ok', result: { status: taskStatus, result: { memories_extracted: 1 } } })
    send(404, { status: 'error' })
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const configFile = path.join(temp, 'test.yaml')
  fs.writeFileSync(configFile, '')
  config = loadConfig(['--config', configFile, '--socket', socket, '--data-dir', temp], {
    OPENVIKING_URL: `http://127.0.0.1:${upstream.address().port}`,
    OPENVIKING_MODE: 'external',
    OPENVIKING_USER: 'test', OPENVIKING_ACCOUNT: 'pilot', OPENVIKING_ACTOR_PEER: 'device',
    OPENVIKING_API_KEY: 'test-key', OPENVIKING_TIMEOUT_MS: '1000',
  })
  // Existing graph data must never be opened/modified by the new backend.
  fs.writeFileSync(path.join(temp, 'graph.db'), 'old graph sentinel')
  config.openviking.legacySourceFile = path.join(temp, 'migration-source', 'graph.db')
  adapter = await start(config)
})

after(async () => {
  adapter?.shutdown()
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  fs.rmSync(temp, { recursive: true, force: true })
})

test('device health reflects backend readiness; boot catalogues retain wire shapes', async () => {
  assert.equal((await request('GET', '/healthz')).body.backend, 'openviking')
  assert.equal((await request('GET', '/readyz')).body.ready, true)
  ready = false
  assert.equal((await request('GET', '/readyz')).status, 503)
  ready = true
  for (const [route, field] of [['/v1/memories?prefix=core&depth=3', 'items'], ['/v1/tree/simple', 'flat'], ['/v2/graph/export', 'entities'], ['/v2/domains', 'domains'], ['/v2/entities/dirty', 'entities']]) {
    assert.deepEqual((await request('GET', route)).body[field], [])
  }
  assert.equal((await request('PUT', '/v1/memories/work.test', { content: 'test' })).status, 501)
  assert.equal((await request('DELETE', '/v2/entities/test')).body.error.code, 'unsupported_operation')
  assert.equal(fs.readFileSync(path.join(temp, 'graph.db'), 'utf8'), 'old graph sentinel')
  assert.ok(!Object.keys(require.cache).some(p => /graph_store_sqlite|legacy_server|embedder/.test(p)))
})

test('agent search uses native search once and returns summaries without reading L2', async () => {
  const offset = calls.length
  const result = await request('POST', '/v1/search', { query: '如何部署设备并检查服务日志', limit: 5 })
  assert.equal(result.status, 200)
  assert.equal(result.body.results.length, 2)
  assert.equal(result.body.results[0].key, uri)
  assert.equal(result.body.results[0].content, hit.abstract)
  assert.equal(result.body.results[0].truncated, false)
  assert.equal(calls.length, offset + 1)
  const sent = calls.at(-1)
  assert.equal(sent.route, '/api/v1/search/search')
  assert.equal(sent.body.read_content, false)
  assert.equal(sent.headers['x-openviking-account'], 'pilot')
  assert.equal(sent.headers['x-openviking-user'], 'test')
  assert.equal(sent.headers['x-openviking-actor-peer'], 'device')
  assert.equal(sent.headers['x-api-key'], 'test-key')
  await request('POST', '/v1/search', { query: '部署', sessionId: 'native-session', prefix: 'viking://user/test/memories/' })
  assert.equal(calls.at(-1).body.session_id, 'native-session')
})

test('hybrid search runs both native branches concurrently and merges actual keyword evidence by URI', async () => {
  const count = calls.length
  behavior = 'hybrid_parallel'
  hybridGrepStarted = false
  releaseHybridSearch = undefined
  try {
    const result = await request('POST', '/v1/search', { query: '之前的旅行计划', keywords: ['海拉尔', '呼伦贝尔'], limit: 3 })
    assert.equal(result.status, 200)
    assert.equal(calls.length, count + 2)
    const sent = calls.slice(count)
    const search = sent.find(c => c.route === '/api/v1/search/search')
    const grep = sent.find(c => c.route === '/api/v1/search/grep')
    assert.equal(search.body.query, '之前的旅行计划')
    assert.equal(search.body.target_uri, 'viking://~/memories')
    assert.equal(grep.body.uri, search.body.target_uri)
    assert.equal(grep.body.pattern, '海拉尔|呼伦贝尔')
    assert.equal(grep.body.case_insensitive, true)
    assert.ok(!Object.hasOwn(search.body, 'keywords'))
    const hits = result.body.results
    assert.equal(hits.length, 3)
    assert.equal(new Set(hits.map(h => h.uri)).size, 3)
    assert.equal(hits[0].uri, uri)
    assert.deepEqual(hits.map(h => h.group), ['semantic', 'semantic', 'keyword'])
    assert.deepEqual(hits[0].retrievalSources, ['semantic', 'keyword'])
    assert.equal(hits[0].score, 0.91)
    assert.equal(hits[0].semanticScore, 0.91)
    assert.equal(hits[0].keywordMatches.length, 1)
    assert.ok(hits[0].content.includes('Deployment preferences'))
    assert.ok(hits[0].content.includes('海拉尔项目部署的原始证据'))
    assert.ok(hits[0].truncated)
    const keyword = hits.find(h => h.retrievalSources.length === 1 && h.retrievalSources[0] === 'keyword')
    assert.equal(keyword.score, null)
    assert.equal(keyword.semanticScore, null)
    assert.ok(keyword.content.includes('呼伦贝尔航班安排'))
    assert.ok(hits.every(h => h.content.length <= 800))
    assert.ok(hits.reduce((n, h) => n + h.content.length, 0) <= 8000)
  } finally { behavior = 'ok'; releaseHybridSearch?.(); releaseHybridSearch = undefined }
})
test('literal keywords are escaped, deduplicated and never interpreted as regex operators', async () => {
  behavior = 'hybrid'
  try {
    const result = await request('POST', '/v1/search', {
      query: '查这些标识符', keywords: ['C++', 'bge.m3', 'file[1]', 'a|b', 'x\\y', 'c++'], limit: 10,
      prefix: 'viking://user/test/memories', sessionId: 'native-session',
    })
    assert.equal(result.status, 200)
    const grep = calls.at(-1).route.endsWith('/grep') ? calls.at(-1) : calls.at(-2)
    assert.equal(grep.body.pattern, 'c\\+\\+|bge\\.m3|file\\[1\\]|a\\|b|x\\\\y')
    const search = calls.slice(-2).find(c => c.route.endsWith('/search'))
    assert.equal(search.body.target_uri, grep.body.uri)
    assert.equal(search.body.session_id, 'native-session')
    assert.ok(result.body.results.some(h => h.uri.endsWith('/literal.md')))
    assert.ok(!result.body.results.some(h => h.uri.endsWith('/wrong.md')))
  } finally { behavior = 'ok' }
})
test('short keyword supplements and semantic candidates both fit the budget', async () => {
  try {
    behavior = 'hybrid_empty_semantic'
    const only = await request('POST', '/v1/search', { query: '旅行计划', keywords: ['呼伦贝尔'], limit: 2 })
    assert.equal(only.status, 200)
    assert.equal(only.body.results.length, 1)
    assert.equal(only.body.results[0].score, null)
    assert.deepEqual(only.body.results[0].retrievalSources, ['keyword'])
    behavior = 'hybrid'
    const mixed = await request('POST', '/v1/search', { query: '旅行计划', keywords: ['呼伦贝尔'], limit: 2 })
    assert.equal(mixed.body.results.length, 3)
    assert.deepEqual(mixed.body.results.map(h => h.group), ['semantic', 'semantic', 'keyword'])
    assert.deepEqual(mixed.body.results.slice(0, 2).map(h => h.score), [0.91, 0.3])
    assert.equal(mixed.body.results[0].score, 0.91)
  } finally { behavior = 'ok' }
})
test('missing/empty keywords preserve semantic-only calls; invalid keywords fail before native traffic', async () => {
  let count = calls.length
  await request('POST', '/v1/search', { query: '设备如何部署', keywords: [] })
  assert.equal(calls.length, count + 1)
  assert.equal(calls.at(-1).route, '/api/v1/search/search')
  assert.ok(!Object.hasOwn(calls.at(-1).body, 'target_uri'))
  count = calls.length
  for (const keywords of ['海拉尔', null, [''], [' '], [123], new Array(9).fill('x'), ['x'.repeat(61)]]) {
    assert.equal((await request('POST', '/v1/search', { query: '设备如何部署', keywords })).status, 400)
  }
  assert.equal((await request('POST', '/v1/search', { query: '设备如何部署', keywords: ['部署'], limit: 0 })).body.results.length, 0)
  assert.equal((await request('POST', '/v2/recall', { text: '设备如何部署并检查日志', keywords: ['部署'] })).status, 400)
  assert.equal(calls.length, count)
})
test('failure in either hybrid branch is surfaced rather than silently dropping evidence', async () => {
  try {
    for (const failure of ['hybrid_grep_error', 'hybrid_search_error']) {
      behavior = failure
      const result = await request('POST', '/v1/search', { query: '旅行计划', keywords: ['呼伦贝尔'] })
      assert.equal(result.status, 503)
      assert.ok(!Object.hasOwn(result.body, 'results'))
    }
  } finally { behavior = 'ok' }
})
test('hybrid evidence obeys a shared body budget across many documents and an explicit level filter', () => {
  const semantic = Array.from({ length: 30 }, (_, i) => ({ uri: `viking://user/test/memories/s-${i}.md`,
    key: `viking://user/test/memories/s-${i}.md`, abstract: '语义摘要'.repeat(1000), level: 2, score: 0.9 - i * 0.01 }))
  const matches = Array.from({ length: 40 }, (_, i) => ({ uri: `viking://user/test/memories/k-${i}.md`, line: 7, content: '关键词证据'.repeat(1000) }))
  const hits = mergeSearch(semantic, matches, { limit: 50, maxChars: 8000 })
  assert.equal(hits.length, 10)
  assert.equal(new Set(hits.map(h => h.uri)).size, 10)
  assert.deepEqual(hits.filter(h => h.group === 'semantic').map(h => h.uri), semantic.slice(0, 5).map(h => h.uri))
  assert.deepEqual(hits.filter(h => h.group === 'keyword').map(h => h.uri), matches.slice(0, 5).map(h => h.uri))
  assert.ok(hits.reduce((n, h) => n + h.content.length, 0) <= 8000)
  assert.ok(hits.every(h => h.content.length <= 800 && h.truncated && h.truncationNotice))
  assert.ok(hits.filter(h => h.retrievalSources[0] === 'keyword').every(h => h.score === null))
  const scoped = mergeSearch([], [
    { uri: 'viking://user/test/memories/.abstract.md', line: 3, content: 'L0摘要' },
    { uri: 'viking://user/test/memories/.overview.md', line: 5, content: 'L1概要' },
    matches[0],
  ], { limit: 5, maxChars: 6000, level: 1 })
  assert.equal(scoped.length, 1)
  assert.equal(scoped[0].level, 1)
  assert.ok(scoped[0].content.includes('L1概要'))
})
test('dual matches enrich evidence without promoting lower-ranked semantic documents', async () => {
  behavior = 'hybrid_secondary'
  try {
    const result = await request('POST', '/v1/search', { query: '旅行计划', keywords: ['海拉尔', '呼伦贝尔'], limit: 2 })
    assert.equal(result.status, 200)
    assert.deepEqual(result.body.results.slice(0, 2).map(h => h.uri), [uri, uri + '2'])
    assert.deepEqual(result.body.results.slice(0, 2).map(h => h.semanticRank), [1, 2])
    assert.deepEqual(result.body.results[1].retrievalSources, ['semantic', 'keyword'])
    assert.ok(result.body.results[1].content.includes('海拉尔'))
    assert.equal(result.body.results[2].group, 'keyword')
  } finally { behavior = 'ok' }
})
test('an explicit semantic score threshold does not pretend keyword evidence has a vector score', async () => {
  behavior = 'hybrid'
  try {
    const result = await request('POST', '/v1/search', { query: '旅行计划', keywords: ['呼伦贝尔'], minScore: 0.95 })
    assert.equal(result.status, 200)
    assert.equal(result.body.results.length, 1)
    assert.equal(result.body.results[0].score, null)
    assert.deepEqual(result.body.results[0].retrievalSources, ['keyword'])
  } finally { behavior = 'ok' }
})
test('keyword document type follows its namespace rather than words in the filename', () => {
  const uris = ['viking://user/test/memories/resources-plan.md', 'viking://resources/doc.md', 'viking://user/test/peers/violoop/skills/guide.md']
  const result = mergeSearch([], uris.map(uri => ({ uri, line: 1, content: 'evidence' })), { limit: 3, maxChars: 6000 })
  assert.deepEqual(result.map(h => h.contextType), ['memory', 'resource', 'skill'])
})

test('grep calls native grep only, preserving regex, file scope and line evidence without vector scores', async () => {
  const count = calls.length
  const result = await request('POST', '/v1/grep', { pattern: '海拉尔|呼伦贝尔' })
  assert.equal(result.status, 200)
  assert.equal(calls.length, count + 1)
  assert.equal(calls.at(-1).route, '/api/v1/search/grep')
  assert.deepEqual(calls.at(-1).body, { uri: 'viking://~/memories', pattern: '海拉尔|呼伦贝尔', node_limit: 10, case_insensitive: false })
  assert.equal(result.body.matches[0].uri, uri)
  assert.equal(result.body.matches[0].line, 7)
  assert.equal(result.body.matches[0].level, 2)
  assert.equal(result.body.matches[0].content, '海拉尔旅行计划')
  assert.ok(!Object.hasOwn(result.body.matches[0], 'score'))
  assert.equal(result.body.matches[1].content.length, 600)
  assert.equal(result.body.matches[1].truncated, true)
  assert.equal(result.body.filesScanned, 3)
  const fileScope = 'viking://user/test/memories/.overview.md'
  await request('POST', '/v1/grep', { pattern: 'BGE', prefix: fileScope, limit: 3, caseInsensitive: true })
  assert.equal(calls.at(-1).body.uri, fileScope) // Do not normalize sidecars into directory scope.
  assert.equal(calls.at(-1).body.case_insensitive, true)
  assert.equal(calls.at(-1).body.node_limit, 3)
  const sidecars = await request('POST', '/v1/grep', { pattern: 'sidecars' })
  assert.deepEqual(sidecars.body.matches.map(m => m.level), [0, 1])
})
test('grep bounds total snippets and distinguishes misses, invalid patterns and upstream failures', async () => {
  const many = await request('POST', '/v1/grep', { pattern: 'many', limit: 50 })
  assert.equal(many.body.matches.length, 50)
  assert.equal(many.body.matches.reduce((n, m) => n + m.content.length, 0), 6000)
  assert.equal(many.body.limited, true)
  assert.equal(many.body.truncated, true)
  assert.equal((await request('POST', '/v1/grep', { pattern: 'NOT_PRESENT' })).body.count, 0)
  const count = calls.length
  for (const body of [{}, { pattern: [] }, { pattern: ' ' }, { pattern: 'x'.repeat(1001) },
    { pattern: 'BGE', limit: 51 }, { pattern: 'BGE', caseInsensitive: 'yes' }, { pattern: 'BGE', prefix: 'work.' }]) {
    assert.equal((await request('POST', '/v1/grep', body)).status, 400)
  }
  assert.equal((await request('POST', '/v1/grep', { pattern: 'BGE', limit: 0 })).body.count, 0)
  assert.equal(calls.length, count)
  const invalid = await request('POST', '/v1/grep', { pattern: '[' })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'invalid_pattern')
  try {
    behavior = 'error'
    assert.equal((await request('POST', '/v1/grep', { pattern: 'BGE' })).status, 503)
    behavior = 'malformed'
    assert.equal((await request('POST', '/v1/grep', { pattern: 'BGE' })).status, 502)
  } finally { behavior = 'ok' }
})

test('recall uses all-level find once without a default score floor; subgraph is disabled', async () => {
  const count = calls.length
  const recall = await request('POST', '/v2/recall', { text: '部署新版本需要怎样检查日志', maxEntities: 2, maxRelations: 4 })
  assert.equal(recall.body.results.length, 2)
  assert.equal(recall.body.entities[0].id, uri)
  assert.deepEqual(recall.body.relations, [])
  assert.equal(calls.length, count + 1)
  assert.equal(calls.at(-1).route, '/api/v1/search/find')
  assert.ok(!Object.hasOwn(calls.at(-1).body, 'level'))
  assert.equal(calls.at(-1).body.read_content, false)
  assert.equal(calls.at(-1).body.events_time_decay_protection, '30d')
  assert.ok(!Object.hasOwn(calls.at(-1).body, 'score_threshold'))
  assert.equal(calls.at(-1).body.limit, 2)
  const sub = await request('POST', '/v2/search/subgraph', { query: '部署' })
  assert.equal(sub.status, 501)
  assert.equal(calls.length, count + 1)
})

test('retired recall score environment/config values do not restore a default gate', () => {
  const legacyConfig = path.join(temp, 'old-score.yaml')
  fs.writeFileSync(legacyConfig, 'openviking:\n  recall_min_score: 0.60\n')
  const loaded = loadConfig(['--config', legacyConfig], { OPENVIKING_RECALL_MIN_SCORE: '0.60' })
  assert.ok(!Object.hasOwn(loaded.openviking, 'recallMinScore'))
})

test('recall fetches top ten across all levels and bounds each returned preview', async () => {
  behavior = 'mixed_recall'
  try {
    for (const body of [{ text: '部署'.repeat(1000) }, { text: '部署'.repeat(1000), maxEntities: 50 }]) {
      const result = await request('POST', '/v2/recall', body)
      assert.equal(result.status, 200)
      assert.equal(result.body.results.length, 10)
      assert.deepEqual([...new Set(result.body.results.map(h => h.level))].sort(), [0, 1, 2])
      assert.ok(result.body.results.every(h => h.score < 0.6))
      assert.ok(result.body.results.every(h => h.content.length === 250 && h.truncated && h.truncationNotice))
      assert.equal(result.body.results.reduce((total, h) => total + h.content.length, 0), 2500)
      assert.ok(result.body.entities.every(e => e.observations.join('').length === 250 && e.truncated))
      assert.equal(calls.at(-1).body.query.length, 600)
      assert.equal(calls.at(-1).body.limit, 10)
    }
    const explicit = await request('POST', '/v2/recall', { text: '设备如何部署并检查日志', level: 2, minScore: 0.4, maxEntities: 1 })
    assert.equal(explicit.body.results.length, 1)
    assert.equal(calls.at(-1).body.level, 2)
    assert.equal(calls.at(-1).body.score_threshold, 0.4)
    const compat = await request('POST', '/v1/search', { query: '设备如何部署并检查日志', mode: 'recall', limit: 50 })
    assert.equal(compat.body.results.length, 10)
    assert.equal(calls.at(-1).body.limit, 10)
    assert.ok(!Object.hasOwn(calls.at(-1).body, 'level'))
    assert.ok(!Object.hasOwn(calls.at(-1).body, 'score_threshold'))
  } finally { behavior = 'ok' }
})

const parent = uri.slice(0, uri.lastIndexOf('/'))
const fullText = '长正文'.repeat(2500) + '\nsecond line\nthird line\n'
const getMemory = (key, params = {}) => request('GET', '/v1/memories/' + encodeURIComponent(key) + '?' + new URLSearchParams(params))
test('PC flat catalogue enumerates real L0/L1/L2 files, preserves sidecar identities and deep directories', async () => {
  const result = await request('GET', '/v1/memory-entries')
  assert.equal(result.status, 200)
  assert.equal(result.body.backend, 'openviking')
  assert.equal(result.body.items.length, 5)
  assert.equal(new Set(result.body.items.map(i => i.key)).size, 5)
  assert.deepEqual([...new Set(result.body.items.map(i => i.level))].sort(), [0, 1, 2])
  assert.ok(result.body.items.every(i => i.title.startsWith(`[L${i.level}]`)))
  assert.ok(result.body.items.some(i => i.key.endsWith('/events/2026/10/10/hailar.md')))
  assert.ok(!result.body.items.some(i => i.key.includes('.internal.json')))
  assert.ok(!calls.some(c => new URL(c.route, 'http://stub').searchParams.get('uri')?.endsWith('/private')))
  assert.ok(!result.body.items.some(i => i.key.endsWith('/preferences/deep/.abstract.md')))
  const count = calls.length
  assert.equal((await request('GET', '/v1/memory-entries')).body.items.length, 5)
  assert.equal(calls.length, count) // Short-lived cache avoids duplicate PC list/stats scans.
})
test('PC entry detail reads the exact level and includes long body beyond the agent preview cap', async () => {
  const root = 'viking://user/test/memories'
  for (const [key, level, body] of [[root + '/.abstract.md', 0, '目录摘要'], [root + '/.overview.md', 1, '目录概览'], [uri, 2, fullText]]) {
    const result = await request('GET', '/v1/memory-entries/' + encodeURIComponent(key))
    assert.equal(result.status, 200)
    assert.equal(result.body.key, key)
    assert.equal(result.body.frontmatter.level, level)
    assert.equal(result.body.frontmatter.title.startsWith(`[L${level}]`), true)
    assert.equal(result.body.frontmatter.uri, level < 2 ? root : uri)
    assert.equal(result.body.content, body)
  }
  assert.equal((await request('GET', '/v1/memory-entries/' + encodeURIComponent(root))).status, 400)
  assert.equal((await request('GET', '/v1/memory-entries/' + encodeURIComponent(root + '/missing.md'))).status, 404)
  assert.equal((await request('PUT', '/v1/memories/' + encodeURIComponent(uri), { content: 'edit' })).status, 501)
})
test('PC detail explicitly marks content beyond its transport budget', async () => {
  const result = await request('GET', '/v1/memory-entries/' + encodeURIComponent('viking://user/test/memories/very-long.md'))
  assert.equal(result.status, 200)
  assert.equal(result.body.truncated, true)
  assert.equal((result.body.content.match(/长/g) || []).length, 60000)
  assert.ok(result.body.content.includes('面板预览已截断'))
})
test('L0/L1 resolve file parents, directory L2 directs listing, and list preserves pagination', async () => {
  for (const level of [0, 1]) {
    const r = await getMemory(uri, { level })
    assert.equal(r.body.uri, parent)
    assert.equal(r.body.requestedUri, uri)
    assert.equal(r.body.content, level ? '目录概览' : '目录摘要')
    assert.ok(calls.at(-1).route.includes(level ? '/overview?' : '/abstract?'))
  }
  const dir = await getMemory(parent, { level: 2 })
  assert.equal(dir.body.kind, 'directory')
  assert.ok(dir.body.hint.includes('memory.list'))
  const listing = await request('GET', '/v1/memories?' + new URLSearchParams({ prefix: parent, limit: 1 }))
  assert.equal(listing.body.items[0].uri, uri)
  assert.equal(listing.body.hasMore, true)
  assert.equal(listing.body.nextOffset, 1)
  assert.equal((await getMemory('viking://user/test/missing.md', { level: 2 })).status, 404)
  assert.equal((await getMemory(uri, { level: 3 })).status, 400)
})
test('L2 long single lines and line pages can be reconstructed with returned cursors', async () => {
  let options = { level: 2, limit: 2 }, text = '', pages = 0
  do {
    const r = await getMemory(uri, options)
    assert.equal(r.status, 200)
    text += r.body.content
    assert.ok(r.body.content.length <= 6000)
    options = r.body.next
    assert.ok(++pages < 10)
  } while (options)
  assert.equal(text, fullText)
  assert.ok(pages > 2)
})

test('skip trivial recall, validate inputs, surface native failures instead of empty success', async () => {
  const count = calls.length
  for (const q of ['继续', 'ok', 'go on!!!', '谢谢']) {
    assert.deepEqual((await request('POST', '/v2/recall', { text: q })).body.entities, [])
    assert.deepEqual((await request('POST', '/v1/search', { query: q, mode: 'recall' })).body.results, [])
  }
  assert.equal(calls.length, count)
  for (const body of [{ query: [] }, { query: '设备如何部署', limit: -1 }, { query: '设备如何部署', mode: 'wrong' }, { query: '设备如何部署', prefix: 'work.' }, { query: '设备如何部署', sessionId: 123 }, { query: '设备如何部署', minScore: 'high' }]) {
    assert.equal((await request('POST', '/v1/search', body)).status, 400)
  }
  assert.deepEqual((await request('POST', '/v1/search', { query: '设备如何部署', limit: 0 })).body.results, [])
  behavior = 'malformed'
  assert.equal((await request('POST', '/v1/search', { query: '设备如何部署和检查日志' })).status, 502)
  behavior = 'error'
  assert.equal((await request('POST', '/v1/search', { query: '设备如何部署和检查日志' })).status, 503)
  behavior = 'timeout'
  assert.equal((await request('POST', '/v1/search', { query: '设备如何部署和检查日志' })).status, 504)
  behavior = 'ok'
})

test('ingest batches long episodes, preserves sources, is idempotent, and exposes task failure', async () => {
  const body = { episode: { sessionId: 'chat:test', title: '测试对话', messages: Array.from({ length: 205 }, (_, i) => ({ id: i, role: i % 2 ? 'assistant' : 'user', content: 'message ' + i, createdAt: i % 2 ? Date.parse('2026-10-09T01:00:00Z') : '2026-10-09T01:00:00Z' })) }, entities: [], relations: [] }
  const offset = calls.length
  const [first, duplicate] = await Promise.all([request('POST', '/v2/ingest', body), request('POST', '/v2/ingest', body)])
  assert.equal(first.status, 202)
  assert.equal(first.body.status, 'accepted')
  assert.equal(first.body.taskId, 'native-task')
  assert.equal(first.body.ingestId, duplicate.body.ingestId)
  const writes = calls.slice(offset).filter(c => c.route.endsWith('/messages/batch'))
  assert.deepEqual(writes.map(c => c.body.messages.length), [100, 100, 5])
  assert.deepEqual(writes.flatMap(c => c.body.messages), body.episode.messages.map(m => ({
    role: m.role, content: m.content,
    created_at: typeof m.createdAt === 'number' ? new Date(m.createdAt).toISOString() : m.createdAt,
    source_message_ids: [String(m.id)],
  })))
  const record = JSON.parse(fs.readFileSync(path.join(temp, 'openviking-adapter/ingests', first.body.ingestId + '.json')))
  assert.equal(record.sourceSessionId, body.episode.sessionId)
  assert.equal(record.messagesWritten, body.episode.messages.length)
  assert.equal(calls.slice(offset).filter(c => c.route.endsWith('/commit')).length, 1)
  assert.equal((await request('POST', '/v2/ingest', body)).body.duplicate, true)
  const status = await request('GET', '/v2/ingests/' + first.body.ingestId)
  assert.equal(status.body.status, 'completed')
  taskStatus = 'failed'
  // Once observed, native terminal receipts remain durable across task expiry.
  assert.equal((await request('GET', '/v2/ingests/' + first.body.ingestId)).body.status, 'completed')
  const failed = await request('POST', '/v2/ingest', { episode: { sessionId: 'failed-task', messages: [{ role: 'user', content: 'separate failed task' }] } })
  assert.equal((await request('GET', '/v2/ingests/' + failed.body.ingestId)).body.status, 'failed')
  taskStatus = 'completed'
  assert.equal((await request('GET', '/v2/tasks/native-task')).body.task.status, 'completed')
})

test('raw-only device payloads preserve full conversation and tool text without graph fields', async () => {
  const text = ' 原始对话\n' + '完整正文'.repeat(5000)
  const body = { episode: { sessionId: 'chat:raw-only', title: '原始会话', messages: [
    { id: 'original-user', role: 'user', content: text, createdAt: 1800000000000 },
    { id: 'original-tool', role: 'tool', content: '{"output":"原始工具轨迹"}', createdAt: 1800000000001 },
  ] } }
  const offset = calls.length
  const response = await request('POST', '/v2/ingest', body)
  assert.equal(response.status, 202)
  assert.equal(response.body.status, 'accepted')
  const messages = calls.slice(offset).find(c => c.route.endsWith('/messages/batch')).body.messages
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[0].content, text)
  assert.equal(messages[0].created_at, '2027-01-15T08:00:00.000Z')
  assert.deepEqual(messages[0].source_message_ids, ['original-user'])
  assert.equal(messages[1].role, 'tool')
  assert.equal(messages[1].content, body.episode.messages[1].content)
  assert.equal(messages[1].created_at, '2027-01-15T08:00:00.001Z')
})

test('fact-only device evidence is passed to native extraction; ambiguous writes are not replayed', async () => {
  const evidence = { episode: { sessionId: 'screen:test', summary: '屏幕观察', messages: [] }, entities: [{ name: '测试项目', observations: ['喜欢分批发布'] }], relations: [] }
  const offset = calls.length
  assert.equal((await request('POST', '/v2/ingest', evidence)).status, 202)
  const imported = calls.slice(offset).find(c => c.route.endsWith('/messages/batch')).body.messages[0].content
  assert.ok(imported.includes('Imported device evidence'))
  assert.ok(imported.includes('喜欢分批发布'))
  assert.equal((await request('POST', '/v2/ingest', { episode: { messages: [] } })).status, 400)
  behavior = 'error'
  const failedBody = { episode: { sessionId: 'failed:test', messages: [{ role: 'user', content: 'test failed write' }] } }
  assert.equal((await request('POST', '/v2/ingest', failedBody)).status, 503)
  behavior = 'ok'
  const count = calls.length
  const retry = await request('POST', '/v2/ingest', failedBody)
  assert.equal(retry.status, 409)
  assert.equal(retry.body.error.code, 'ingest_uncertain')
  assert.equal(calls.length, count)
})

test('restart preserves ingest journal; regular files and active sockets are never replaced', async () => {
  const journals = fs.readdirSync(path.join(temp, 'openviking-adapter/ingests'))
    .map(name => JSON.parse(fs.readFileSync(path.join(temp, 'openviking-adapter/ingests', name))))
  const record = journals.find(r => r.result)
  const expectedStatus = record.terminal?.status || 'completed'
  adapter.shutdown()
  await once(adapter.socketServer, 'close')
  adapter = await start(config)
  assert.equal((await request('GET', '/v2/ingests/' + record.id)).body.status, expectedStatus)
  const before = fs.lstatSync(socket).ino
  await assert.rejects(start(config), /another listener/)
  assert.equal(fs.lstatSync(socket).ino, before)
  const file = path.join(temp, 'ordinary-file')
  fs.writeFileSync(file, 'untouched')
  await assert.rejects(start({ ...config, socket: file }), /not a socket/)
  assert.equal(fs.readFileSync(file, 'utf8'), 'untouched')
})

test('commit failure after written messages remains inspectable without replaying writes', async () => {
  behavior = 'commit_error'
  const body = { episode: { sessionId: 'commit-failed', messages: [{ role: 'source', content: '来自设备观察的待抽取材料' }] } }
  assert.equal((await request('POST', '/v2/ingest', body)).status, 503)
  behavior = 'ok'
  const records = fs.readdirSync(path.join(temp, 'openviking-adapter/ingests'))
    .map(name => JSON.parse(fs.readFileSync(path.join(temp, 'openviking-adapter/ingests', name))))
  const record = records.find(r => r.sourceSessionId === 'commit-failed')
  assert.equal(record.phase, 'commit_started')
  assert.equal(record.messagesWritten, 1)
  const count = calls.length
  assert.equal((await request('POST', '/v2/ingest', body)).status, 409)
  assert.equal(calls.length, count)
  const status = await request('GET', '/v2/ingests/' + record.id)
  assert.equal(status.body.status, 'uncertain')
  assert.equal(status.body.messagesWritten, 1)
})

test('oversized requests return a JSON 413 without closing the connection prematurely', async () => {
  const response = await request('POST', '/v1/search', { query: 'x'.repeat(10 * 1024 * 1024) })
  assert.equal(response.status, 413)
  assert.equal(response.body.error.code, 'invalid_query')
})

test('a socket left by SIGKILL can be safely reused', async () => {
  if (process.platform === 'win32') return
  const stale = path.join(temp, 'stale.sock')
  const child = spawn(process.execPath, ['-e', 'require("net").createServer().listen(process.argv[1], () => console.log("ready"))', stale], { stdio: ['ignore', 'pipe', 'inherit'] })
  await once(child.stdout, 'data')
  child.kill('SIGKILL')
  await once(child, 'exit')
  assert.ok(fs.lstatSync(stale).isSocket())
  const recovered = await start({ ...config, socket: stale })
  recovered.shutdown()
  await once(recovered.socketServer, 'close')
})

test('manual migration HTTP entry inventories legacy sources and completes without resubmission', async () => {
  const { createLegacyDatabase } = require('./fixtures/legacy')
  createLegacyDatabase(path.join(temp, 'migration-source', 'graph.db'), {
    memories: [{ id: 'old.note', key: 'old.note', content: '用户喜欢安静的工作环境。' }],
    entities: [{ id: 'old-project', name: '旧项目', type: 'project', observations: ['项目位于北京'] }],
  })
  const before = calls.filter(c => c.route.endsWith('/commit')).length
  const status = await request('GET', '/v2/migration/status')
  assert.equal(status.status, 200); assert.equal(status.body.pendingCount, 2)
  assert.equal(calls.filter(c => c.route.endsWith('/commit')).length, before)
  assert.equal((await request('POST', '/v2/migration/start', {})).status, 202)
  const deadline = Date.now() + 8000 // allow the normal 3-second task status poll
  let current
  do {
    await new Promise(resolve => setTimeout(resolve, 10))
    current = await request('GET', '/v2/migration/status')
  } while (current.body.pendingCount && Date.now() < deadline)
  assert.equal(current.body.pendingCount, 0)
  assert.equal(calls.filter(c => c.route.endsWith('/commit')).length, before + 1)
  await request('POST', '/v2/migration/start', {})
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(calls.filter(c => c.route.endsWith('/commit')).length, before + 1)
})


test('search defaults to ten candidates per branch and packs long hybrid results into 8000 characters', async () => {
  behavior = 'search_limits'
  try {
    for (const route of ['/v1/search', '/v2/search']) {
      for (const keywords of [undefined, [], ['词']]) {
        const start = calls.length
        const result = await request('POST', route, { query: '检索预算测试', ...(keywords ? { keywords } : {}) })
        assert.equal(result.status, 200)
        const hits = result.body.results
        const hybrid = keywords?.length > 0
        assert.equal(hits.length, 10)
        assert.equal(calls.slice(start).find(c => c.route === '/api/v1/search/search').body.limit, 10)
        if (hybrid) {
          assert.equal(hits.filter(h => h.group === 'semantic').length, 5)
          assert.equal(hits.filter(h => h.group === 'keyword').length, 5)
        }
        assert.ok(hits.every(h => h.content.length <= 800 && h.truncated && h.truncationNotice.includes('memory.get')))
        assert.ok(hits.reduce((n, h) => n + h.content.length, 0) <= 8000)
        if (!hybrid) assert.ok(hits.every(h => h.content.length === 800))
      }
    }
    const custom = await request('POST', '/v1/search', { query: '检索预算测试', limit: 20 })
    assert.equal(custom.body.results.length, 20)
    assert.ok(custom.body.results.every(h => h.content.length === 400))
    const start = calls.length
    const capped = await request('POST', '/v1/search', { query: '检索预算测试', keywords: ['词'], limit: 20 })
    assert.equal(calls.slice(start).find(c => c.route.endsWith('/search')).body.limit, 10)
    assert.equal(capped.body.results.length, 10)
  } finally { behavior = 'ok' }
})

test('preview budgets preserve ranking, redistribute unused space, and flag only actual truncation', () => {
  const make = (text, truncated = false) => ({ abstract: text, content: text, truncated })
  const hits = boundPreviews([make('a'.repeat(2000)), make('short'), make('b'.repeat(2000))], 1005)
  assert.deepEqual(hits.map(h => h.content.length), [500, 5, 500])
  assert.ok(hits[0].truncated && hits[2].truncationNotice)
  assert.equal(hits[1].truncated, false)
  assert.ok(!hits[1].truncationNotice)
  assert.equal(boundPreviews([make('a'.repeat(800))], 8000)[0].truncated, false)
  assert.equal(boundPreviews([make('a'.repeat(801))], 8000)[0].content.length, 800)
  assert.equal(boundPreviews([make('short', true)], 8000)[0].truncated, true)
  assert.deepEqual(boundPreviews([], 8000), [])
})

test('retrieval budgets and file-reading budgets have independent defaults', () => {
  const cfg = loadConfig([], {}).openviking
  assert.equal(cfg.recallMaxChars, 2500)
  assert.equal(cfg.searchMaxChars, 8000)
  assert.equal(cfg.abstractMaxChars, 600)
  assert.equal(cfg.readMaxChars, 6000)
})


test('short hybrid previews may retain all twenty candidates without a ten-result cap', () => {
  const semantic = Array.from({length:12},(_,i)=>({uri:`viking://user/test/memories/s${i}.md`,abstract:'short',score:0.9-i/100,level:2}))
  const matches = Array.from({length:12},(_,i)=>({uri:`viking://user/test/memories/k${i}.md`,line:1,content:'short'}))
  const hits = mergeSearch(semantic,matches,{limit:12,maxChars:8000})
  assert.equal(hits.length,20)
  assert.deepEqual(hits.filter(h=>h.group==='semantic').map(h=>h.uri),semantic.slice(0,10).map(h=>h.uri))
  assert.deepEqual(hits.filter(h=>h.group==='keyword').map(h=>h.uri),matches.slice(0,10).map(h=>h.uri))
  assert.ok(hits.every(h=>!h.truncated))
})
test('hybrid packing stops at the first non-fitting preview without shrinking or skipping it', () => {
  const semantic = [0,1].map(i=>({uri:`viking://user/test/memories/s${i}.md`,abstract:'s'.repeat(1200),score:0.9,level:2}))
  const matches = [{uri:'viking://user/test/memories/k0.md',line:1,content:'k'.repeat(1200)}, {uri:'viking://user/test/memories/k1.md',line:1,content:'tiny'}]
  for (const maxChars of [1600,2000]) {
    const hits=mergeSearch(semantic,matches,{maxChars})
    assert.deepEqual(hits.map(h=>h.uri),[semantic[0].uri,matches[0].uri])
    assert.deepEqual(hits.map(h=>h.content.length),[800,800])
  }
})
test('hybrid packing continues the remaining branch after one pool is exhausted', () => {
  const semantic=[{uri:'viking://user/test/memories/s.md',abstract:'short',score:0.9,level:2}]
  const matches=Array.from({length:10},(_,i)=>({uri:`viking://user/test/memories/k${i}.md`,line:1,content:'short'}))
  assert.equal(mergeSearch(semantic,matches).length,11)
  assert.equal(mergeSearch([],matches).length,10)
})
test('dual matches use one budget slot and keyword pool is capped before cross-branch deduplication', () => {
  const semantic=Array.from({length:10},(_,i)=>({uri:`viking://user/test/memories/s${i}.md`,abstract:'summary',score:0.9,level:2}))
  const matches=[{uri:semantic[0].uri,line:1,content:'shared evidence'},...Array.from({length:10},(_,i)=>({uri:`viking://user/test/memories/k${i}.md`,line:1,content:'short'}))]
  const hits=mergeSearch(semantic,matches)
  assert.equal(hits.length,19)
  assert.deepEqual(hits[0].retrievalSources,['semantic','keyword'])
  assert.ok(hits[0].content.includes('summary') && hits[0].content.includes('shared evidence'))
  assert.equal(hits.filter(h=>h.uri===semantic[0].uri).length,1)
  assert.ok(!hits.some(h=>h.uri===matches[10].uri))
})
