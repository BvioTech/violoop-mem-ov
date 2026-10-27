// Boot the package's actual CLI entry point, with no model download or real API.
// The native integration suite separately exercises the ready model/CRUD path.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { setTimeout: sleep } = require('node:timers/promises')
async function main() {
  const app = path.resolve(process.argv[2])
  assert.ok(fs.existsSync(path.join(app, 'server.js')))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-installed-'))
  let child, exit, tail = ''
  const probe = http.createServer()
  await new Promise(r => probe.listen(0, '127.0.0.1', r))
  const port = probe.address().port
  await new Promise(r => probe.close(r))
  const socket = path.join(dir, 'mem.sock')
  const config = path.join(dir, 'config.yaml')
  fs.writeFileSync(config, 'embedding:\n  enabled: false\n')
  function request(route) {
    return new Promise((resolve, reject) => {
      const req = http.get({ socketPath: socket, path: route, agent: false }, res => {
        let text = ''; res.on('data', b => { text += b }); res.on('error', reject)
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }) } catch (e) { reject(e) } })
      })
      req.setTimeout(2000, () => req.destroy(new Error('request timeout')))
      req.on('error', reject)
    })
  }
  try {
    child = spawn(process.execPath, [path.join(app, 'server.js'), '--data-dir', path.join(dir, 'data'),
      '--socket', socket, '--config', config, '--no-embedding'], {
      cwd: app, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_PATH: '',
        QMD_CONFIG: config, OPENVIKING_MODE: 'managed', OPENVIKING_URL: `http://127.0.0.1:${port}`,
        OPENVIKING_RUNTIME_DIR: path.join(dir, 'run'), OPENVIKING_API_KEY: '',
        OPENVIKING_PYTHON: process.env.VIOLOOP_TEST_PYTHON,
        OPENVIKING_PYTHONPATH: path.join(app, 'openviking-python'),
        OPENVIKING_DEVICE_MODEL_URL: 'http://127.0.0.1:1/internal/memory/chat/completions',
        VIOLOOP_LEGACY_MEMORY_DB: path.join(dir, 'no-legacy.db'),
      },
    })
    exit = once(child, 'exit')
    for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { tail = (tail + b).slice(-12000) })
    let ready = false
    for (let i = 0; i < 300; i++) {
      assert.equal(child.exitCode, null, 'packaged CLI exited before health check')
      try {
        const health = await request('/healthz')
        const native = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
        if (health.status === 200 && native.ok) { ready = true; break }
      } catch {}
      await sleep(100)
    }
    assert.ok(ready, 'packaged CLI/native engine health timeout')
    assert.equal((await request('/runtime/background')).body.paused, false)
    // --no-embedding intentionally does not claim full readiness.
    assert.equal((await request('/readyz')).body.ready, false)
    child.kill('SIGTERM')
    let timer
    const result = await Promise.race([exit, new Promise(resolve => { timer = setTimeout(() => resolve(null), 15000) })])
    clearTimeout(timer)
    assert.ok(result, 'packaged CLI graceful shutdown timeout')
    assert.equal(result[0], 0, 'packaged CLI nonzero exit')
    console.log('Installed CLI: native engine boot, health, background endpoint and graceful shutdown passed')
  } catch (e) { console.error(tail); throw e }
  finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit }
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
