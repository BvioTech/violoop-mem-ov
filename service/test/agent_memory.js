const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const { once } = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { OpenVikingClient } = require('../openviking_client')
const { createApp } = require('../openviking_adapter')
const { searchOptions } = require('../openviking_agent')

const key = 'viking://user/test/memories/preferences/agent.md'
const other = 'viking://user/test/memories/events/outside.md'
const records = new Map(), calls = []
let upstream, server, app, base, rejectRefresh = false, searchKey = key
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-agent-'))
const hit = (uri, level = 2) => ({ uri, level, score: 0.9, abstract: '旅行偏好', context_type: 'memory', tags: ['memory_type=preferences', 'topic=travel'] })
before(async () => {
  upstream = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const body = text ? JSON.parse(text) : undefined
    const u = new URL(req.url, 'http://native'), uri = u.searchParams.get('uri')
    calls.push({ method: req.method, path: u.pathname, params: Object.fromEntries(u.searchParams), body })
    const send = (status, result) => { res.writeHead(status, { 'content-type':'application/json' }); res.end(JSON.stringify(status < 400 ? { status:'ok', result } : { status:'error', error:{ message: result } })) }
    if (u.pathname === '/api/v1/content/write') {
      if (body.mode === 'create' && records.has(body.uri)) return send(409, 'already exists')
      records.set(body.uri, body.content)
      if (rejectRefresh) return send(500, 'index refresh failed')
      return send(200, { uri: body.uri, mode: body.mode, vector_status: 'queued', overview_status:'complete' })
    }
    if (u.pathname === '/api/v1/content/read') return records.has(uri) ? send(200, u.searchParams.get('raw') === 'true' ? records.get(uri) : records.get(uri).replace(/\n\n<!-- MEMORY_FIELDS\n[\s\S]*?\n-->$/, '')) : send(404, 'missing')
    if (['/api/v1/content/abstract', '/api/v1/content/overview'].includes(u.pathname)) {
      const sidecar = uri + (u.pathname.endsWith('/abstract') ? '/.abstract.md' : '/.overview.md')
      return records.has(sidecar) ? send(200, records.get(sidecar)) : send(404, 'missing')
    }
    if (u.pathname === '/api/v1/fs/stat') return records.has(uri) ? send(200, { isDir:false }) : send(404, 'missing')
    if (u.pathname === '/api/v1/fs/ls') {
      const directory = uri.replace('viking://~', 'viking://user/test').replace(/\/$/, '')
      const entries = new Map()
      for (const file of records.keys()) if (file.startsWith(directory + '/')) {
        const suffix = file.slice(directory.length + 1), name = suffix.split('/')[0]
        entries.set(name, { name, uri: directory + '/' + name, isDir: suffix.includes('/') })
      }
      return send(200, [...entries.values()])
    }
    if (u.pathname === '/api/v1/fs' && req.method === 'DELETE') { records.delete(uri); return send(200, { uri, estimated_deleted_count:1, semantic_status:'queued' }) }
    if (u.pathname === '/api/v1/fs/attrs') return send(200, { attrs:{ tags:['topic=travel'], memory:{ memory_type:'preferences', created_at:'2026-01-01T00:00:00Z', source_extraction_id:'source-123', content:'must not leak whole file' } } })
    if (u.pathname === '/api/v1/search/grep') return send(200, { matches:[{ uri:searchKey, line:1, content:'travel evidence' }, { uri:other, line:1, content:'out of time range' }, { uri:'viking://user/test/memories/.overview.md', line:1, content:'wrong level' }] })
    if (u.pathname.startsWith('/api/v1/search/')) {
      if (body.query === '') return send(200, { memories:body.level === 2 ? [hit(searchKey)] : [], resources:[], skills:[] })
      return send(200, { memories:[hit(searchKey)], resources:[], skills:[], provenance:[{ query:'rewritten travel', matched_contexts:[{ uri:searchKey, tier:'L2', score:0.9, match_reason:'semantic match' }] }] })
    }
    return send(404, 'unexpected route')
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  app = createApp(new OpenVikingClient({ url:'http://127.0.0.1:' + upstream.address().port, user:'test' }), { dataDir:dir })
  server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  base = 'http://127.0.0.1:' + server.address().port
})
after(async () => { app?.close(); await Promise.all([new Promise(r => server.close(r)),new Promise(r => upstream.close(r))]); fs.rmSync(dir,{recursive:true,force:true}) })
async function request(method, route, body) {
  const res = await fetch(base + route, { method, headers:{'content-type':'application/json'}, ...(body === undefined ? {} : {body:JSON.stringify(body)}) })
  return { status:res.status, body:await res.json() }
}
const file = '/v1/memories/' + encodeURIComponent(key)
test('create calls native create, returns queued status and refuses overwrite', async () => {
  records.clear()
  let r = await request('POST','/v1/memories',{key,content:'# Preferences\nLikes trains.\nKeep this fact.',tags:['Topic=Travel']})
  assert.equal(r.status,201); assert.equal(r.body.result.vector_status,'queued')
  assert.match(r.body.notice,/not completion/)
  assert.deepEqual(calls.at(-1).body,{uri:key,content:records.get(key),mode:'create',wait:false,tags:['topic=travel'],tag_mode:'replace'})
  r = await request('POST','/v1/memories',{key,content:'overwrite'})
  assert.equal(r.status,409); assert.match(records.get(key),/Likes trains/)
})
test('update changes only one exact passage and retains unrelated facts', async () => {
  const r = await request('PATCH',file,{oldText:'Likes trains.',newText:'Prefers direct trains.'})
  assert.equal(r.status,200); assert.equal(records.get(key),'# Preferences\nPrefers direct trains.\nKeep this fact.')
  assert.equal(calls.at(-1).body.mode,'replace'); assert.equal(calls.at(-1).body.tags,undefined)
})
test('missing and ambiguous update are conflicts with no write', async () => {
  for (const original of ['No match', 'twice and twice']) {
    records.set(key,original); const count = calls.filter(c=>c.path==='/api/v1/content/write').length
    const r = await request('PATCH',file,{oldText:'twice',newText:'one'})
    assert.equal(r.status,409); assert.equal(records.get(key),original)
    assert.equal(calls.filter(c=>c.path==='/api/v1/content/write').length,count)
  }
  records.delete(key)
  assert.equal((await request('PATCH',file,{oldText:'x',newText:'y'})).status,404)
})
test('delete removes one existing file and explicitly disables recursion', async () => {
  records.set(key,'x'); const r=await request('DELETE',file)
  assert.equal(r.status,200); assert.equal(r.body.deleted,true); assert.equal(records.has(key),false)
  assert.equal(calls.at(-1).params.recursive,'false'); assert.equal(calls.at(-1).params.wait,'false')
  assert.equal((await request('DELETE',file)).status,404)
})
test('disabled root singleton memories can be deleted but not created or edited', async () => {
  for (const name of ['identity', 'soul']) {
    const uri = `viking://user/test/memories/${name}.md`
    const route = '/v1/memories/' + encodeURIComponent(uri)
    records.set(uri, 'old singleton')
    const count = calls.length
    assert.equal((await request('POST', '/v1/memories', { key:uri, content:'new' })).status, 400)
    assert.equal((await request('PATCH', route, { oldText:'old', newText:'new' })).status, 400)
    assert.equal(calls.length, count)
    assert.equal((await request('DELETE', route)).status, 200)
    assert.equal(records.has(uri), false)
    assert.equal(calls.at(-1).params.recursive, 'false')
  }
  for (const uri of ['viking://user/other/memories/identity.md', 'viking://~/memories/unknown.md',
    'viking://~/memories/.identity.md', 'viking://~/memories/../soul.md']) {
    const count = calls.length
    assert.equal((await request('DELETE', '/v1/memories/' + encodeURIComponent(uri))).status, 400)
    assert.equal(calls.length, count)
  }
})
test('unsafe or cross-user mutation URIs never reach native APIs', async () => {
  for (const unsafe of ['core.identity','viking://~/memories','viking://~/memories/preferences/.overview.md','viking://~/memories/preferences/../evil.md','viking://~/memories/preferences/%2e%2e/x.md','viking://~/memories/preferences/%2ehidden.md','viking://~/memories/preferences/%2fother.md','viking://~/memories/preferences/a\\b.md','viking://~/memories/preferences/a\u0000b.md','viking://~/resources/a.md','viking://user/other/memories/events/a.md','viking://user/test/peers/other/memories/events/a.md','viking://~/memories/events/a.md?x=1']) {
    const count=calls.length
    assert.equal((await request('POST','/v1/memories',{key:unsafe,content:'x'})).status,400,unsafe)
    assert.equal(calls.length,count)
  }
  assert.equal((await request('POST','/v1/memories',{key:'viking://~/memories/events/new.md',content:'x'})).status,201)
})

test('literal #, ?, spaces, Unicode and percent filenames work across catalogue, search, reads and mutations', async () => {
  const beforeRecords = new Map(records)
  try {
    for (const name of ['PR #83.md', 'why?.md', '中文 文件.md', '50% 完成.md', 'literal%20name.md']) {
      const special = 'viking://user/test/memories/entities/' + name
      const route = '/v1/memories/' + encodeURIComponent(special)
      searchKey = special
      assert.equal((await request('POST', '/v1/memories', { key: special, content: 'travel evidence' })).status, 201)
      const list = await request('GET', '/v1/memory-entries')
      assert.equal(list.status, 200)
      assert.ok(list.body.items.some(item => item.key === special), name)
      const detail = await request('GET', '/v1/memory-entries/' + encodeURIComponent(special))
      assert.equal(detail.status, 200)
      assert.equal(detail.body.key, special)
      const read = await request('GET', route + '?level=2')
      assert.equal(read.status, 200)
      assert.equal(read.body.content, 'travel evidence')
      assert.equal(calls.at(-1).params.uri, special)
      const children = await request('GET', '/v1/memories?' + new URLSearchParams({ prefix: special.slice(0, special.lastIndexOf('/')) }))
      assert.equal(children.status, 200)
      assert.ok(children.body.items.some(item => item.uri === special))
      for (const options of [{}, { keywords: ['travel'] }]) {
        const found = await request('POST', '/v1/search', { query: 'travel', prefix: special, ...options })
        assert.equal(found.status, 200)
        assert.ok(found.body.results.some(item => item.uri === special))
      }
      assert.equal((await request('POST', '/v2/recall', { text: 'travel evidence' })).status, 200)
      const grep = await request('POST', '/v1/grep', { prefix: special, pattern: 'travel' })
      assert.equal(grep.status, 200)
      assert.equal(grep.body.uri, special)
      assert.equal(calls.at(-1).body.uri, special)
      assert.equal((await request('PATCH', route, { oldText: 'travel', newText: 'updated' })).status, 200)
      assert.equal(records.get(special), 'updated evidence')
      assert.equal((await request('DELETE', route)).status, 200)
      assert.equal(calls.at(-1).params.uri, special)
      assert.equal(records.has(special), false)
    }
  } finally {
    searchKey = key
    records.clear(); for (const [key, value] of beforeRecords) records.set(key, value)
  }
})

test('special directory names preserve separate L0/L1 sidecars and literal detail paths', async () => {
  const folder = 'viking://user/test/memories/entities/项目 #83? 50%'
  const sidecars = [['.abstract.md', 0], ['.overview.md', 1]]
  try {
    for (const [name] of sidecars) records.set(folder + '/' + name, name + ' content')
    await request('POST', '/v1/memories', { key: folder + '/note.md', content: 'content' })
    const list = await request('GET', '/v1/memory-entries')
    assert.equal(list.status, 200)
    for (const [name, level] of sidecars) {
      const path = folder + '/' + name
      assert.ok(list.body.items.some(item => item.key === path && item.level === level))
      const detail = await request('GET', '/v1/memory-entries/' + encodeURIComponent(path))
      assert.equal(detail.status, 200)
      assert.equal(detail.body.key, path)
      assert.ok(detail.body.content.endsWith(name + ' content'))
      assert.equal(calls.at(-1).params.uri, folder)
    }
  } finally {
    for (const name of ['.abstract.md', '.overview.md', 'note.md']) records.delete(folder + '/' + name)
  }
})

test('read and search scopes still reject control characters and traversal before native requests', async () => {
  for (const suffix of ['../outside.md', '%2e%2e/outside.md', 'a%2fb.md', 'a\\b.md', 'bad\u0000.md', 'bad\u007f.md']) {
    const unsafe = 'viking://user/test/memories/' + suffix
    for (const [method, route, body] of [
      ['GET', '/v1/memories/' + encodeURIComponent(unsafe)],
      ['GET', '/v1/memory-entries/' + encodeURIComponent(unsafe)],
      ['POST', '/v1/grep', { prefix: unsafe, pattern: 'travel' }],
      ['POST', '/v1/search', { targetUri: unsafe, query: 'travel' }],
    ]) {
      const count = calls.length
      assert.equal((await request(method, route, body)).status, 400, suffix)
      assert.equal(calls.length, count)
    }
  }
})
test('advanced search forwards native filters and returns source IDs without full content', async () => {
  const r=await request('POST','/v1/search',{query:'travel',tags:['topic=travel'],memoryType:'preferences',contextType:'memory',since:'2026-01-01',until:'2026-10-01',timeField:'created_at',includeProvenance:true,level:2})
  assert.equal(r.status,200)
  const native=calls.findLast(c=>c.path==='/api/v1/search/search').body
  assert.deepEqual(native.tags,['topic=travel']); assert.equal(native.time_field,'created_at'); assert.equal(native.context_type,'memory'); assert.equal(native.include_provenance,true)
  assert.equal(native.filter.op,'or'); assert.equal(native.filter.conds[0].conds[0],'memory_type=preferences')
  assert.equal(native.filter.conds[1].conds[0],'viking://user/test/memories/preferences')
  const result=r.body.results[0]
  assert.equal(result.memory.source_extraction_id,'source-123'); assert.equal(result.memory.content,undefined)
  assert.equal(result.provenance.retrieval[0].matchReason,'semantic match')
})
test('keyword supplements obey the same filters and preserve level-specific eligibility', async () => {
  const r=await request('POST','/v1/search',{query:'travel',keywords:['travel'],since:'2026-01-01',contextType:'memory',memoryType:'preferences',includeProvenance:true})
  assert.equal(r.status,200); assert.deepEqual(r.body.results.map(r=>r.uri),[key])
  const filters=calls.filter(c=>c.path==='/api/v1/search/find' && c.body.query==='')
  assert.equal(filters.length,2)
  for (const c of filters) { assert.equal(c.body.since,'2026-01-01'); assert.equal(c.body.filter.op,'and'); assert.equal(c.body.filter.conds[1].para,'-d=0'); assert.equal(c.body.context_type,'memory') }
  assert.deepEqual(r.body.results[0].retrievalSources,['semantic','keyword'])
})
test('search and get omit optional source work unless requested', async () => {
  const count=calls.filter(c=>c.path==='/api/v1/fs/attrs').length
  const r=await request('POST','/v1/search',{query:'travel'})
  assert.equal(r.body.results[0].memory,undefined); assert.equal(calls.filter(c=>c.path==='/api/v1/fs/attrs').length,count)
  records.set(key,'body')
  const read=await request('GET',file+'?level=2&includeProvenance=true')
  assert.equal(read.body.memory.source_extraction_id,'source-123')
})
test('invalid filters are rejected before any native request', async () => {
  for (const params of [{tags:['bad']},{tags:['a=1','a=2']},{memoryType:'../x'},{memoryType:'events',tags:['memory_type=profile']},{contextType:'entity'},{timeField:'event_time'},{since:'yesterday'},{since:'2026-02-30'},{since:'2026-10-02',until:'2026-10-01'},{includeProvenance:'yes'}]) {
    const count=calls.length
    assert.equal((await request('POST','/v1/search',{query:'travel',...params})).status,400,JSON.stringify(params)); assert.equal(calls.length,count)
  }
  const opts=searchOptions({since:'7d',until:'1d'})
  assert.equal(Date.parse(opts.until)-Date.parse(opts.since),6*86400000)
})
test('native refresh failure warns that the file may already have changed', async () => {
  rejectRefresh=true
  try {
    const r=await request('POST','/v1/memories',{key:'viking://~/memories/events/refresh.md',content:'saved'})
    assert.equal(r.status,503); assert.match(r.body.error.message,/may have applied/)
  } finally { rejectRefresh=false }
})
test('concurrent edits of the same passage serialize and the stale edit conflicts', async () => {
  records.set(key,'original passage\nunrelated fact')
  const results=await Promise.all(['first replacement','second replacement'].map(newText =>
    request('PATCH',file,{oldText:'original passage',newText})))
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409])
  assert.match(records.get(key),/replacement\nunrelated fact$/)
})

test('manual panel creates typed L2 files, previews collisions and refuses stale or reserved edits', async () => {
  const forms = [
    { memoryType:'entities', category:'项目', name:'Memory System' },
    { memoryType:'events', date:'2026-10-23', name:'项目评审' },
    { memoryType:'preferences', owner:'徐文彬', topic:'答复风格' },
    { memoryType:'profile' },
  ]
  const suffixes = ['entities/项目/memory_system.md','events/2026/10/23/项目评审.md','preferences/徐文彬/答复风格.md','profile.md']
  for (let i=0;i<forms.length;i++) {
    const body = { ...forms[i], content:'# Manual content\nA fact.' }
    const preview = await request('POST','/v1/memory-entries/preview',body)
    assert.equal(preview.status,200); assert.equal(preview.body.level,2); assert.equal(preview.body.exists,false)
    const uri = 'viking://user/test/memories/' + suffixes[i]
    assert.equal(preview.body.uri,uri)
    const created = await request('POST','/v1/memory-entries',body)
    assert.equal(created.status,201); assert.equal(created.body.key,uri)
    assert.match(records.get(uri), new RegExp('"memory_type": "'+body.memoryType+'"'))
    const route='/v1/memory-entries/'+encodeURIComponent(uri)
    assert.equal((await request('GET',route)).body.content,body.content)
    assert.equal((await request('POST','/v1/memory-entries/preview',body)).body.exists,true)
    assert.equal((await request('POST','/v1/memory-entries',body)).status,409)
    const raw=records.get(uri)
    assert.equal((await request('PATCH',route,{content:'new body',expectedContent:'stale'})).status,409)
    assert.equal(records.get(uri),raw)
    assert.equal((await request('PATCH',route,{content:'<!-- MEMORY_FIELDS\n{}\n-->',expectedContent:body.content})).status,400)
    assert.equal((await request('PATCH',route,{content:'Updated fact.',expectedContent:body.content})).status,200)
    records.delete(uri)
  }
  const count=calls.length
  for (const body of [
    {memoryType:'identity'}, {memoryType:'soul'},
    {memoryType:'entities',category:'../bad',name:'x'},
    {memoryType:'entities',category:'项目',name:'../escape'},
    {memoryType:'events',date:'2026-02-30',name:'x'},
  ]) assert.equal((await request('POST','/v1/memory-entries', {...body, content:'fact'})).status,400)
  assert.equal(calls.length,count)
})

test('event decay: recall always uses 30d unless overridden; search defaults to no decay', async () => {
  const bodyFor = () => calls.filter(c => c.path.startsWith('/api/v1/search/') && c.path !== '/api/v1/search/grep').at(-1).body
  assert.equal((await request('POST','/v2/recall',{text:'今天有哪些项目需要继续推进'})).status,200)
  assert.equal(bodyFor().events_time_decay_protection,'30d')
  assert.equal((await request('POST','/v2/recall',{text:'去年旅行时住在哪一家酒店'})).status,200)
  assert.equal(bodyFor().events_time_decay_protection,'30d')
  assert.equal((await request('POST','/v2/recall',{text:'今天有哪些项目需要继续推进',eventsTimeDecayProtection:null})).status,200)
  assert.equal(bodyFor().events_time_decay_protection,null)
  for(const [setting,expected] of [[undefined,undefined],['auto','30d'],['14d','14d'],[null,null]]) {
    const res=await request('POST','/v1/search',{query:'去年旅行时住在哪一家酒店',...(setting===undefined?{}:{eventsTimeDecayProtection:setting})})
    assert.equal(res.status,200);assert.equal(bodyFor().events_time_decay_protection,expected)
  }
  const count=calls.length
  assert.equal((await request('POST','/v1/search',{query:'projects',eventsTimeDecayProtection:'-1d'})).status,400)
  assert.equal(calls.length,count)
})

test('hybrid filter-only eligibility never receives a time-decay ranking argument', async () => {
  records.set(key,'travel evidence')
  const start=calls.length
  const r=await request('POST','/v1/search',{query:'travel',keywords:['travel'],since:'7d',eventsTimeDecayProtection:'30d'})
  assert.equal(r.status,200)
  const queries=calls.slice(start).filter(c=>c.path.startsWith('/api/v1/search/') && c.path!=='/api/v1/search/grep')
  assert.equal(queries.find(c=>c.body.query==='travel').body.events_time_decay_protection,'30d')
  assert.ok(queries.some(c=>c.body.query===''))
  for(const call of queries.filter(c=>c.body.query==='')) assert.equal(Object.hasOwn(call.body,'events_time_decay_protection'),false)
})
