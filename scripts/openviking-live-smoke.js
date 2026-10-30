#!/usr/bin/env node
// Explicitly invoked real-backend smoke. Writes one test episode and retains
// it for inspection. Use an isolated pilot user/workspace, not production.
const http = require('http')
const assert = require('node:assert/strict')
const fs = require('fs')
const { randomUUID } = require('crypto')
const { setTimeout: delay } = require('timers/promises')

const socket = process.env.VIOLOOP_MEM_OV_SOCKET || '/run/violoop-mem-ov/violoop-mem-ov.sock'
const reportPath = process.env.VIOLOOP_MEM_OV_SMOKE_REPORT
const timeoutMs = Number(process.env.VIOLOOP_MEM_OV_SMOKE_TIMEOUT_MS || 300000)
const report = { startedAt: new Date().toISOString(), socket, steps: [] }

async function request(method, route, body) {
  const started = performance.now()
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, method, path: route, agent: false, headers: { 'content-type': 'application/json' } }, res => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', c => { raw += c })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw)
          if (res.statusCode >= 400) reject(new Error(`${route}: HTTP ${res.statusCode}: ${raw}`))
          else resolve(parsed)
        } catch (err) { reject(err) }
      })
    })
    req.setTimeout(30000, () => req.destroy(new Error(`${route}: timed out`)))
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  report.steps.push({ method, route, ms: Math.round(performance.now() - started), result })
  return result
}

async function main() {
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, 'invalid smoke timeout')
  const ready = await request('GET', '/readyz')
  assert.equal(ready.backend, 'openviking')
  assert.equal(ready.ready, true)
  const marker = 'vio-pilot-' + randomUUID()
  report.marker = marker
  const input = { episode: {
    sessionId: marker, title: marker,
    messages: [
      { role: 'user', content: `请记住：我的实验项目名称是 ${marker}。这个项目部署在杭州，发布前必须先检查服务日志。` },
      { role: 'assistant', content: `已了解 ${marker} 的部署地点和发布偏好。` },
    ],
  }, entities: [], relations: [] }
  const ingest = await request('POST', '/v2/ingest', input)
  assert.equal(ingest.status, 'accepted')
  report.ingestId = ingest.ingestId
  report.nativeSessionId = ingest.sessionId
  const deadline = Date.now() + timeoutMs
  let completed = false
  while (Date.now() < deadline) {
    const status = await request('GET', '/v2/ingests/' + ingest.ingestId)
    if (['failed', 'cancelled'].includes(status.status)) throw new Error(`extraction ${status.status}: ${JSON.stringify(status.task)}`)
    if (status.status === 'completed') { completed = true; break }
    await delay(1000)
  }
  assert.ok(completed, `extraction pending past timeout: ${ingest.taskId}`)
  const q = `${marker} 项目的部署地点和发布前检查要求是什么？`
  const search = await request('POST', '/v1/search', { query: q, mode: 'search', limit: 5 })
  let found = search.results.some(h => h.content.includes(marker))
  for (const hit of search.results) {
    if (found) break
    const read = await request('GET', '/v1/memories/' + encodeURIComponent(hit.uri) + '?level=2')
    if (read.kind === 'file') found = read.content.includes(marker)
    else {
      const listing = await request('GET', '/v1/memories?' + new URLSearchParams({ prefix: hit.uri, limit: 50 }))
      for (const entry of listing.items.filter(e => !e.isDir)) {
        const content = await request('GET', '/v1/memories/' + encodeURIComponent(entry.uri) + '?level=2')
        if (content.content.includes(marker)) { found = true; break }
      }
    }
  }
  assert.ok(found, 'progressive search/read did not return the test project; inspect extraction and indexing')
  const recall = await request('POST', '/v2/recall', { text: q, maxEntities: 2, maxRelations: 4 })
  // Report recall separately: its 0.60 gate can hide results under a different
  // embedding/rerank model. Never inflate native scores to make smoke pass.
  report.recallCount = recall.entities.length
  report.status = report.recallCount ? 'passed' : 'search_passed_recall_empty'
  console.log(JSON.stringify({ status: report.status, ingestId: ingest.ingestId, searchCount: search.results.length, recallCount: report.recallCount }))
  if (!report.recallCount) {
    console.warn('Search passed; automatic recall is empty. Calibrate the recall threshold before the pilot.')
    process.exitCode = 2
  }
}

main().catch(err => {
  report.status = 'failed'
  report.error = err.message
  console.error(err.message)
  process.exitCode = 1
}).finally(() => {
  report.finishedAt = new Date().toISOString()
  if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 })
})
