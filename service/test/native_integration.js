// Real bundled Python/native engine; deterministic local model responses.
// All state lives in a newly-created temp directory. No Device, cloud or BGE server is contacted.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { execFile } = require('child_process')
const { promisify } = require('util')
const Database = require('better-sqlite3')
const { createHash } = require('crypto')
const serviceRoot = process.env.VIOLOOP_TEST_SERVICE_ROOT || path.join(__dirname, '..')
const { start } = require(path.join(serviceRoot, 'server'))
const { loadConfig } = require(path.join(serviceRoot, 'config'))
const { Embedder } = require(path.join(serviceRoot, 'embedder'))
const { linkedLegacyDatabase } = require('./fixtures/legacy')
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const wait = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, timeout = 90000) {
  const end = Date.now() + timeout
  let error
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value } catch (e) { error = e }
    await wait(250)
  }
  throw error || new Error('Timed out waiting for native engine')
}
async function port() {
  const p = http.createServer()
  await new Promise(r => p.listen(0, '127.0.0.1', r))
  const n = p.address().port
  await new Promise(r => p.close(r))
  return n
}
function request(socket, method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, path: route, method, agent: false,
      headers: { 'content-type': 'application/json' } }, res => {
      let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => {
        try {
          const value = JSON.parse(raw)
          if (res.statusCode >= 400) reject(new Error(`${route}: ${res.statusCode} ${raw}`))
          else resolve(value)
        } catch (e) { reject(e) }
      })
    })
    req.setTimeout(30000, () => req.destroy(new Error('HTTP timeout')))
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

// Write a legacy flat embedding message into real QueueFS without starting consumers.
async function seedEmbeddingQueue({ dataDir, openviking }, phase) {
  await promisify(execFile)(openviking.python, ['-c', `
import asyncio
import sys
from openviking.core.context import Context, ContextLevel
from openviking.storage.queuefs.named_queue import NamedQueue
from openviking.utils.agfs_utils import RagfsBindingConfig, create_agfs_client
from openviking_cli.utils.config import AGFSConfig

async def seed(workspace, phase):
    agfs = create_agfs_client(RagfsBindingConfig(agfs=AGFSConfig(path=workspace, backend="local")))
    try:
        queue = NamedQueue(agfs, "/queue", "Embedding")
        parent = "viking://user/default/memories/events"
        for kind, text in [
            ("oversized", f"historical-{phase} ChatLog: " + "original discussion " * 2400),
            ("next", f"following-{phase} event"),
        ]:
            ctx = Context(uri=f"{parent}/{phase}-{kind}.md", parent_uri=parent,
                          is_leaf=True, context_type="memory", level=ContextLevel.DETAIL,
                          abstract=text[:160], account_id="default")
            await queue.enqueue({"id": f"{phase}-{kind}", "action": "upsert",
                                 "message": text, "context_data": ctx.to_dict()})
    finally:
        agfs.close()

asyncio.run(seed(*sys.argv[1:]))
`, path.join(dataDir, 'openviking'), phase], {
    cwd: dataDir,
    env: { ...process.env, PYTHONPATH: openviking.pythonPath, PYTHONDONTWRITEBYTECODE: '1' },
  })
}

test('persisted oversized embeddings drain at startup and during a language switch so recall recovers', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-ov-language-'))
  const peers = new Set()
  let language = 'en'
  let service, hold
  const device = http.createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': ready\n\n')
      peers.add(res); res.on('close', () => peers.delete(res))
    } else {
      res.end(JSON.stringify(req.url === '/settings/language'
        ? { ui: language, resolved: language } : { ready: true }))
    }
  })
  await new Promise(resolve => device.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    hold?.resolve()
    await service?.shutdown()
    device.closeAllConnections(); await new Promise(resolve => device.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const socket = path.join(dir, 'mem.sock')
  const config = loadConfig(['--socket', socket, '--data-dir', dir], {
    OPENVIKING_URL: `http://127.0.0.1:${await port()}`,
    OPENVIKING_DEVICE_MODEL_URL: `http://127.0.0.1:${device.address().port}/internal/memory/chat/completions`,
    OPENVIKING_RUNTIME_DIR: path.join(dir, 'run'),
    ...(process.env.VIOLOOP_TEST_PYTHON ? { OPENVIKING_PYTHON: process.env.VIOLOOP_TEST_PYTHON } : {}),
    ...(process.env.VIOLOOP_TEST_PYTHONPATH ? { OPENVIKING_PYTHONPATH: process.env.VIOLOOP_TEST_PYTHONPATH } : {}),
  })
  const inputs = []
  const evaluated = []
  const embedder = new Embedder()
  embedder.state = 'ready'
  embedder.dim = 1024
  embedder.profile = { id: 'bge-m3', query: input => input }
  embedder._ctx = {
    _llamaContext: { contextSize: 8192, model: { tokenizer(input) {
      inputs.push(input)
      if (input.startsWith('historical-startup')) return Array(9000).fill(3)
      if (input.startsWith('historical-switch')) return Array(9000).fill(4)
      return [/release schedule|friday release/i.test(input) ? 6 : 5]
    } } },
    async getEmbeddingFor(tokens) {
      evaluated.push({ token: tokens[0], size: tokens.length })
      if (tokens[0] === 3 || tokens[0] === 4) await hold.promise
      if (tokens[0] === 3) throw Error('Input is longer than the context size')
      assert.ok(tokens.length + 2 <= 8191)
      const vector = new Float32Array(1024)
      vector[tokens[0]] = 1
      return { vector }
    },
    async dispose() {},
  }
  const recall = () => request(socket, 'POST', '/v2/recall', {
    text: 'Friday release schedule', targetUri: 'viking://user/default/memories/entities/projects', level: 2,
  })
  const assertPending = () => assert.rejects(recall(), /503.*language_pending/)
  const waitUntil = fn => until(fn, 15000)

  await seedEmbeddingQueue(config, 'startup')
  hold = Promise.withResolvers()
  service = await start(config, { runtimeOptions: { embedder } })
  await waitUntil(() => evaluated.some(call => call.token === 3) && peers.size)
  await assertPending()
  hold.resolve()
  await waitUntil(() => service.language.status().ready && service.language.status().language === 'en')
  const startup = (await service.client.waitProcessed()).Embedding
  assert.equal(startup.error_count, 1)
  assert.match(startup.errors[0].message, /413.*Input length exceeds model context length/)
  assert.equal(startup.requeue_count, 0)
  assert.equal(evaluated.filter(call => call.token === 3).length, 1)
  assert.ok(inputs.includes('following-startup event'))

  const memory = await request(socket, 'POST', '/v1/memory-entries', {
    memoryType: 'entities', category: 'projects', name: 'release_schedule',
    content: '# Release schedule\nThe Friday release is approved.',
  })
  await waitUntil(() => service.client.waitProcessed())
  const assertRecalled = async () => {
    const { results } = await recall()
    assert.ok(results.some(hit => hit.uri === memory.uri), JSON.stringify(results))
  }
  await assertRecalled()

  hold = Promise.withResolvers()
  await seedEmbeddingQueue(config, 'switch')
  await waitUntil(() => evaluated.some(call => call.token === 4))
  language = 'ja'
  for (const peer of peers) peer.write('data: ' + JSON.stringify({ type: 'settings:language', ui: language, resolved: language }) + '\n\n')
  await waitUntil(() => service.language.status().desired === 'ja')
  await assertPending()
  hold.resolve()
  await waitUntil(() => service.language.status().ready && service.language.status().language === 'ja')
  const switched = (await service.client.waitProcessed()).Embedding
  assert.equal(switched.error_count, startup.error_count)
  assert.equal(switched.requeue_count, 0)
  assert.deepEqual(evaluated.filter(call => call.token === 4), [{ token: 4, size: 8189 }])
  assert.ok(inputs.includes('following-switch event'))
  await assertRecalled()
})

test('managed native engine: auto migration, actual files/links, CRUD, retrieval, durable restart and source preservation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-ov-native-'))
  let service
  let extractionCalls = 0; let migrationEmbeddings = 0
  let holdExtraction = null; let releaseExtraction = () => {}
  const model = http.createServer(async (req, res) => {
    if (req.url.endsWith('/ready')) { res.end('{"ready":true}'); return }
    if (req.url === '/settings/language') { res.end('{"ui":"system","resolved":""}'); return }
    if (req.url === '/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); return }
    let raw = ''; for await (const c of req) raw += c
    const body = JSON.parse(raw)
    if (req.url === '/internal/memory/embeddings') {
      assert.equal(req.headers.authorization, 'Bearer ' + fs.readFileSync(path.join(dir, 'run/model-gateway.key'), 'utf8'))
      assert.equal(body.model, 'bge-m3')
      migrationEmbeddings++
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ index: 0, embedding: Array.from(await embedder.embedQuery(body.input)) }] }))
      return
    }
    const isExtraction = body.messages.some(m => typeof m.content === 'string' && m.content.includes('restricted Python memory SDK'))
    let content = '# Test memories\nLocal integration fixture.'
    if (isExtraction) {
      extractionCalls++
      if (holdExtraction) await holdExtraction
      const n = extractionCalls
      content = `a = sdk.create_entities(category="projects", name="alpha${n}", content="""# alpha${n}\nProject connected to beta${n}.\n## Facts\n- A local fixture.""")\nb = sdk.create_entities(category="projects", name="beta${n}", content="""# beta${n}\nA second local project.\n## Facts\n- A local fixture.""")\na.link(b, link_type="related_to", match_text="beta${n}")\nsdk.commit()`
    }
    const message = { role: 'assistant', content }
    const output = { id: 'fixture', object: 'chat.completion', model: 'local-test', choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: ' + JSON.stringify({ ...output, choices: [{ index: 0, delta: message, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ ...output, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
    } else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(output)) }
  })
  await new Promise(r => model.listen(0, '127.0.0.1', r))
  t.after(async () => {
    releaseExtraction()
    if (service) await service.shutdown()
    model.closeAllConnections(); await new Promise(r => model.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const file = linkedLegacyDatabase(path.join(dir, 'graph.db'))
  const projectId = 'prj_verify_01', projectKey = `projects.${projectId}.release-flow`
  const projectContent = '\n  # Release flow\nRun the original checks.  \n'
  const editedProjectContent = '\n  # Release flow\nRun the corrected checks.  \n\n'
  const projectCreated = '2023-05-07T01:02:03.000Z', projectUpdated = '2026-11-20T03:20:00.000Z'
  const db = new Database(file)
  try {
    const insert = db.prepare('INSERT INTO memories (id,key,content,created_at,updated_at) VALUES (?,?,?,?,?)')
    insert.run('project', projectKey, projectContent, projectCreated, projectCreated)
    insert.run('collision', projectKey + '.', 'Separate release note', projectCreated, projectCreated)
    insert.run('deleted', `projects.${projectId}.obsolete`, 'Obsolete release note', projectCreated, projectCreated)
  } finally { db.close() }
  let before = digest(file)
  const socket = path.join(dir, 'mem.sock')
  const config = loadConfig(['--socket', socket, '--data-dir', dir], {
    OPENVIKING_URL: `http://127.0.0.1:${await port()}`,
    OPENVIKING_DEVICE_MODEL_URL: `http://127.0.0.1:${model.address().port}/internal/memory/chat/completions`,
    OPENVIKING_RUNTIME_DIR: path.join(dir, 'run'),
    ...(process.env.VIOLOOP_TEST_PYTHON ? { OPENVIKING_PYTHON: process.env.VIOLOOP_TEST_PYTHON } : {}),
    ...(process.env.VIOLOOP_TEST_PYTHONPATH ? { OPENVIKING_PYTHONPATH: process.env.VIOLOOP_TEST_PYTHONPATH } : {}),
  })
  config.openviking.coexistence = true
  // Deterministic normalized embeddings exercise the real C++ vector store.
  let modelPaused = false
  const embedder = { status: () => ({ state: modelPaused ? 'idle' : 'ready', dim: 1024 }),
    async suspend() { modelPaused = true }, async resume() { modelPaused = false }, async embedQuery(text) {
    assert.equal(modelPaused, false, 'suspended model must not be used')
    const v = new Float32Array(1024)
    for (const c of String(text)) v[c.codePointAt(0) % v.length]++
    const norm = Math.sqrt(v.reduce((s, n) => s + n*n, 0)) || 1
    return v.map(n => n / norm)
  } }
  const req = (method, route, body) => request(socket, method, route, body)
  service = await start(config, { runtimeOptions: { embedder } })
  await until(async () => (await req('GET', '/readyz')).ready)
  await until(async () => {
    const state = await req('GET', '/v2/migration/status')
    if (state.failedBatches) throw new Error(JSON.stringify(state))
    return state.pendingCount === 0 && extractionCalls > 0
  })
  assert.equal(digest(file), before)
  assert.ok(migrationEmbeddings > 0, 'migration vectors must go through the Device endpoint')
  let graph = await until(async () => {
    const g = await req('GET', '/v2/graph/export?view=memory')
    return g.entities.length >= 2 && g.relations.length >= 1 && g
  })
  assert.ok(graph.entities.every(e => !/identity|soul/.test(e.id)))
  const oldUris = graph.entities.map(e => e.id)
  const projectList = (projectId, options = {}) => req('POST', '/v1/project-memories/list', { projectId, ...options })
  const projectUri = `viking://user/default/memories/entities/${projectId}/release-flow.md`
  const projectPath = '/v1/memory-entries/' + encodeURIComponent(projectUri)
  assert.equal((await req('GET', projectPath)).content, projectContent)
  assert.equal((await projectList(projectId)).items.length, 3)
  const legacy = new Database(file)
  try {
    legacy.prepare("UPDATE memories SET content='corrected during legacy operation' WHERE key='a'").run()
    legacy.prepare('UPDATE memories SET content=?, updated_at=? WHERE id=?').run(editedProjectContent, projectUpdated, 'project')
    legacy.prepare("DELETE FROM memories WHERE id='deleted'").run()
  } finally { legacy.close() }
  before = digest(file)
  assert.equal((await req('GET', '/v2/migration/status')).readyForCutover, false)
  await until(async () => {
    const state = await req('GET', '/v2/migration/status')
    if (state.lastError) throw new Error(JSON.stringify(state))
    return state.readyForCutover && extractionCalls > 1
  })
  graph = await until(async () => {
    const g = await req('GET', '/v2/graph/export?view=memory&rebuild=1')
    return g.entities.length >= 2 && !g.entities.some(e => oldUris.includes(e.id)) && g
  })
  const status = await req('GET', '/v2/migration/status')
  assert.equal((await req('POST', '/v2/migration/activate', { sourceRevision: status.sourceRevision })).activated, true)
  assert.equal(digest(file), before, 'catch-up and activation preserve the legacy source')
  const listed = (await projectList(projectId)).items
  assert.equal(listed.length, 2)
  assert.equal(new Set(listed.map(item => item.uri)).size, 2)
  assert.ok(listed.every(item => item.uri.includes(`/entities/${projectId}/`) && !Object.hasOwn(item, 'abstract')))
  const previewed = (await projectList(projectId, { includePreview: true })).items
  assert.deepEqual(previewed.map(item => item.uri).sort(), listed.map(item => item.uri).sort())
  assert.ok(previewed.every(item => item.abstract.trim().length > 0))
  assert.deepEqual((await projectList('prj_other', { includePreview: true })).items, [])
  assert.deepEqual((await projectList('prj_other')).items, [])
  const entries = (await req('GET', '/v1/memory-entries')).items
  assert.ok(entries.some(item => item.uri === projectUri))
  assert.ok(!entries.some(item => item.uri.endsWith('/obsolete.md')))
  const project = await req('GET', projectPath)
  assert.equal(project.content, editedProjectContent)
  const collision = listed.find(item => item.uri !== projectUri)
  assert.equal((await req('GET', '/v1/memory-entries/' + encodeURIComponent(collision.uri))).content, 'Separate release note')
  const readMetadata = uri => req('GET', '/v1/memories/' + encodeURIComponent(uri) + '?level=2&includeProvenance=true')
  const migrated = await readMetadata(projectUri)
  assert.equal(new Date(migrated.memory.created_at).toISOString(), projectCreated)
  assert.equal(new Date(migrated.memory.updated_at).toISOString(), projectUpdated)
  assert.ok(migrated.tags.includes('project_id=' + projectId))
  assert.ok((await readMetadata(collision.uri)).tags.includes('project_id=' + projectId))
  const patchedProjectContent = '# Release flow\nUpdated from the project page.'
  await req('PATCH', projectPath, { content: patchedProjectContent, expectedContent: project.content, tags: ['topic=release'] })
  assert.equal((await req('GET', projectPath)).content, patchedProjectContent)
  assert.ok((await readMetadata(projectUri)).tags.includes('project_id=' + projectId))
  assert.ok((await projectList(projectId)).items.some(item => item.uri === projectUri))
  const added = await req('POST', '/v1/memory-entries', { memoryType: 'entities', category: 'projects', name: 'manual', content: '# Manual\nA searchable local integration record.' })
  const uri = added.uri
  assert.ok(uri.endsWith('/entities/projects/manual.md'))
  const read = await req('GET', '/v1/memory-entries/' + encodeURIComponent(uri))
  assert.match(read.content, /searchable/)
  await req('PATCH', '/v1/memory-entries/' + encodeURIComponent(uri), { content: '# Manual\nUpdated local integration record.', expectedContent: read.content })
  await until(async () => (await req('GET', '/v2/graph/export?view=memory')).entities.some(e => e.id === uri))
  const hits = await req('POST', '/v1/grep', { pattern: 'Updated', prefix: 'viking://user/default/memories' })
  assert.ok(JSON.stringify(hits).includes('manual.md'))
  await req('POST', '/v1/search', { query: 'local integration project', mode: 'recall', limit: 5 })
  await req('POST', '/v2/recall', { text: 'local integration project memory' })
  await req('DELETE', '/v1/memories/' + encodeURIComponent(uri))
  await until(async () => !(await req('GET', '/v2/graph/export?view=memory')).entities.some(e => e.id === uri))
  const callsBefore = extractionCalls
  await service.shutdown(); service = null
  service = await start(config, { runtimeOptions: { embedder } })
  await until(async () => (await req('GET', '/readyz')).ready)
  assert.equal((await req('GET', '/v2/migration/status')).pendingCount, 0)
  assert.equal((await req('GET', '/v2/migration/status')).activated, true)
  await wait(1000)
  assert.equal(extractionCalls, callsBefore, 'completed migration must not replay on restart')
  assert.equal(digest(file), before, 'old graph.db must remain byte-identical')
  const generated = JSON.stringify(await req('GET', '/v1/memories?prefix=' + encodeURIComponent('viking://user/default/memories')))
  assert.doesNotMatch(generated, /identity.md|soul.md/)
  // Pause via the real Device contract. Native queued writes finish before
  // model disposal; browsing stays available and new model work is rejected.
  holdExtraction = new Promise(resolve => { releaseExtraction = resolve })
  const accepted = await req('POST', '/v2/ingest', { episode: { sessionId: 'standby-probe', messages: [
    { role: 'user', content: 'Remember a new project for the standby lifecycle test.' },
  ] } })
  await until(() => extractionCalls > callsBefore)
  const pause = await req('POST', '/runtime/background', { paused: true })
  assert.equal(pause.paused, true)
  assert.equal(pause.busy, true)
  await wait(1200)
  assert.equal((await req('GET', '/runtime/background')).busy, true)
  assert.equal(modelPaused, false, 'do not release BGE before native task finishes')
  releaseExtraction(); holdExtraction = null
  await until(async () => !(await req('GET', '/runtime/background')).busy)
  assert.equal(modelPaused, true)
  assert.equal((await req('GET', '/v2/ingests/' + accepted.ingestId)).status, 'completed')
  assert.equal((await req('GET', '/readyz')).ready, true)
  assert.ok((await req('GET', '/v1/memory-entries')).items.length > 0)
  await assert.rejects(req('POST', '/v1/search', { query: 'project' }), /503.*background_paused/)
  await service.shutdown(); service = null
  service = await start(config, { runtimeOptions: { embedder } })
  await until(async () => !(await req('GET', '/runtime/background')).busy)
  assert.equal((await req('GET', '/runtime/background')).paused, true)
  await req('POST', '/runtime/background', { paused: false })
  await until(async () => !(await req('GET', '/runtime/background')).busy)
  assert.equal(modelPaused, false)
  await until(async () => (await req('GET', '/readyz')).ready)
  await req('POST', '/v1/search', { query: 'local integration project', mode: 'recall', limit: 5 })
  assert.equal(extractionCalls, callsBefore + 1, 'standby and wake never replay completed migration or ingest')
  assert.equal(digest(file), before)
})
