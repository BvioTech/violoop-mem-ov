const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

test('the Debian payload includes the complete managed runtime and embedding API', () => {
  const root = path.resolve(__dirname, '../..')
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-ov-manifest-'))
  try {
    const manifest = fs.readFileSync(path.join(root, 'scripts/nfpm.yaml'), 'utf8')
    for (const [, source, destination] of manifest.matchAll(/- src: \.\/(service\/[^\n]+\.js)\n\s+dst: \/opt\/violoop-mem-ov\/([^\n]+)/g)) {
      fs.copyFileSync(path.join(root, source), path.join(stage, destination))
    }
    for (const file of fs.readdirSync(stage)) {
      const content = fs.readFileSync(path.join(stage, file), 'utf8')
      for (const [, dependency] of content.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)) {
        assert.ok(fs.existsSync(path.resolve(stage, dependency + '.js')), `${file} requires omitted module ${dependency}`)
      }
    }
    const modules = path.dirname(path.dirname(require.resolve('better-sqlite3/package.json')))
    execFileSync(process.execPath, ['-e', 'require("./server"); require("./openviking_runtime"); require("./embedding_api")'], {
      cwd: stage, env: { ...process.env, NODE_PATH: modules }, timeout: 10000,
    })
  } finally { fs.rmSync(stage, { recursive: true, force: true }) }
})
