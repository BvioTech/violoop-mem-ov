const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {loadConfig} = require('../config')
const {Embedder} = require('../embedder')

test('installed upgrades discover old memory read-only; isolated data and explicit sources stay scoped', t => {
  const exists = fs.existsSync.bind(fs)
  const old = '/var/lib/violoop-mem/graph.db'
  const local = '/var/lib/violoop-mem-ov/graph.db'
  let localExists = false
  t.mock.method(fs, 'existsSync', file => file === old || (file === local ? localExists : exists(file)))
  const args = ['--config', path.join(__dirname, '../../deploy/qmd.yaml.default'), '--data-dir', '/var/lib/violoop-mem-ov']
  assert.equal(loadConfig(args, {}).openviking.legacySourceFile, old)
  assert.equal(loadConfig(args, {VIOLOOP_LEGACY_MEMORY_DB: '/operator/source.db'}).openviking.legacySourceFile, '/operator/source.db')
  localExists = true
  assert.equal(loadConfig(args, {}).openviking.legacySourceFile, old)
  assert.equal(loadConfig(args, {}).openviking.coexistence, true)
  assert.equal(loadConfig(['--data-dir', '/isolated/test'], {}).openviking.legacySourceFile, '/isolated/test/graph.db')
})

test('device embedding controls are parsed and invalid values are rejected', () => {
  const cfg = loadConfig([], {VIOLOOP_MEM_EMBEDDING_THREADS: '4', VIOLOOP_MEM_CPU_ONLY: 'true'})
  const embedder = new Embedder(cfg.embedding)
  assert.equal(embedder.threads, 4)
  assert.equal(embedder.cpuOnly, true)
  for (const threads of [0, 4.5, 257, 'invalid']) assert.throws(() => new Embedder({threads}), RangeError)
  assert.throws(() => loadConfig([], {VIOLOOP_MEM_CPU_ONLY: 'invalid'}), TypeError)
})

test('new and legacy services have distinct debug ports, preserving socket-first operation', () => {
  const unit = fs.readFileSync(path.join(__dirname, '../../deploy/violoop-mem-ov.service'), 'utf8')
  assert.match(unit, /--socket \/run\/violoop-mem-ov\/violoop-mem-ov.sock/)
  assert.match(unit, /--http-port 7701/)
  assert.match(unit, /Environment=VIOLOOP_MEM_EMBEDDING_THREADS=4/)
})
