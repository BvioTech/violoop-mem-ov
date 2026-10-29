const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const net = require('net')
const { spawn } = require('child_process')
const { Embedder } = require('./embedder')
const { startModelGateway } = require('./model_gateway')
const { createMigrationEmbedder } = require('./migration_embedding')

function groupId(name) {
  const line = fs.readFileSync('/etc/group', 'utf8').split('\n').find(l => l.split(':')[0] === name)
  if (!line) throw new Error(`group does not exist: ${name}`)
  return Number(line.split(':')[2])
}
async function assertPortFree(port) {
  const probe = net.createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(port, '127.0.0.1', () => probe.close(resolve))
  })
}
function writeMemoryTemplateOverrides(options) {
  const directory = path.join(options.runtimeDir, 'memory-templates')
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  for (const type of ['identity', 'soul']) {
    const source = path.join(options.pythonPath, 'openviking', 'prompts', 'templates', 'memory', `${type}.yaml`)
    const template = fs.readFileSync(source, 'utf8')
    // Preserve the complete schema for template inspection and compatibility.
    // Only the deployment-owned enabled flag changes; never edit bundled files.
    if (!/^enabled:\s*(?:true|false)\s*$/m.test(template)) {
      throw new Error(`OpenViking ${type} template is missing its enabled flag`)
    }
    fs.writeFileSync(path.join(directory, `${type}.yaml`),
      template.replace(/^enabled:\s*(?:true|false)\s*$/m, 'enabled: false'), { mode: 0o600 })
  }
}
function nativeConfig(config, gatewayUrl, token, engineKey) {
  const port = Number(new URL(config.openviking.url).port)
  return {
    // api_key mode restricts ROOT to admin routes. The native gateway mode
    // validates this secret and uses our fixed account/user headers.
    server: { host: '127.0.0.1', port, workers: 1, auth_mode: 'trusted', root_api_key: engineKey },
    storage: { workspace: path.join(config.dataDir, 'openviking'), vectordb: { backend: 'local' }, agfs: { backend: 'local' } },
    embedding: { dense: { provider: 'openai', api_base: gatewayUrl, api_key: token,
      model: 'bge-m3', dimension: 1024, input: 'text', encoding_format: 'float' }, max_concurrent: 1, max_retries: 1 },
    vlm: { provider: 'openai', api_base: gatewayUrl, api_key: token, model: 'violoop-memory',
      temperature: 0, max_tokens: config.openviking.llmMaxTokens, max_concurrent: 2, max_retries: 1 },
    memory: { link_enabled: true, custom_templates_dir: path.join(config.openviking.runtimeDir, 'memory-templates') },
    queue_workers: { session_commit: { max_concurrent: 1 }, add_resource: { max_concurrent: 1 },
      external_parse: { max_concurrent: 1 }, reindex: { max_concurrent: 1 }, external_task: { max_concurrent: 1 } },
    log: { level: 'WARNING', output: 'stdout' },
  }
}
async function startRuntime(config, { spawnProcess = spawn, embedder = new Embedder(config.embedding) } = {}) {
  await embedder.resume?.()
  const options = config.openviking
  if (!Number.isInteger(options.llmMaxTokens) || options.llmMaxTokens < 1 || options.llmMaxTokens > 65536) {
    throw new Error('OPENVIKING_LLM_MAX_TOKENS must be an integer from 1 to 65536')
  }
  const nativeUrl = new URL(options.url)
  if (nativeUrl.protocol !== 'http:' || nativeUrl.hostname !== '127.0.0.1' || nativeUrl.pathname !== '/' || !nativeUrl.port) {
    throw new Error('managed OpenViking URL must be http://127.0.0.1:<port>')
  }
  if (!fs.existsSync(path.join(options.pythonPath, 'openviking', 'server', 'bootstrap.py'))) {
    throw new Error(`bundled OpenViking runtime missing: ${options.pythonPath}`)
  }
  await assertPortFree(Number(nativeUrl.port))
  fs.mkdirSync(options.runtimeDir, { recursive: true, mode: 0o750 })
  fs.mkdirSync(path.join(config.dataDir, 'openviking'), { recursive: true, mode: 0o700 })
  writeMemoryTemplateOverrides(options)
  const token = crypto.randomBytes(32).toString('hex')
  const engineKey = crypto.randomBytes(32).toString('hex')
  const keyFile = path.join(options.runtimeDir, 'model-gateway.key')
  // New random key per parent lifetime. Device reads this file per request.
  const keyTemp = `${keyFile}.${process.pid}`
  fs.writeFileSync(keyTemp, token, { mode: 0o640, flag: 'wx' })
  if (config.socketGroup) fs.chownSync(keyTemp, -1, groupId(config.socketGroup))
  fs.renameSync(keyTemp, keyFile)
  const migrationEmbedder = createMigrationEmbedder({ ...options.migrationEmbedding,
    deviceModelUrl: options.deviceModelUrl, token })
  const timingDir = path.join(config.dataDir, 'legacy-migration', 'timings')
  const gateway = await startModelGateway({ embedder, migrationEmbedder, token, deviceUrl: options.deviceModelUrl, timingDir })
  const configPath = path.join(options.runtimeDir, 'ov.conf')
  fs.writeFileSync(configPath, JSON.stringify(nativeConfig(config, gateway.url, token, engineKey)), { mode: 0o600 })
  fs.chmodSync(configPath, 0o600)
  let child = null; let timer = null; let stopping = false; let crashes = 0; let startedAt = 0
  let lastExit = null
  function restart() {
    if (stopping) return
    assertPortFree(Number(nativeUrl.port)).then(launch).catch(err => {
      if (stopping) return
      console.error(`[OpenViking] restart blocked: ${err.message}`)
      timer = setTimeout(restart, 30000)
    })
  }
  function launch() {
    if (stopping) return
    startedAt = Date.now()
    child = spawnProcess(options.python, ['-m', 'openviking.server.bootstrap', '--config', configPath], {
      cwd: config.dataDir,
      env: { ...process.env, PYTHONPATH: options.pythonPath, PYTHONUNBUFFERED: '1',
        PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '1',
        VIOLOOP_MIGRATION_TIMING_DIR: timingDir,
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    let exited = false
    const onExit = (code, signal) => {
      if (exited) return
      exited = true; child = null
      lastExit = { code, signal, at: new Date().toISOString() }
      if (stopping) return
      crashes = Date.now() - startedAt > 60000 ? 1 : crashes + 1
      const delay = Math.min(30000, 1000 * 2 ** Math.min(crashes, 5))
      console.error(`[OpenViking] exited (${code ?? signal}); restarting in ${delay}ms`)
      timer = setTimeout(restart, delay)
    }
    child.once('error', err => { console.error(`[OpenViking] spawn failed: ${err.message}`); onExit(1, null) })
    child.once('exit', onExit)
    console.log(`[OpenViking] managed pid=${child.pid}; workspace=${path.join(config.dataDir, 'openviking')}`)
  }
  launch()
  // Warm BGE without blocking the adapter socket or device startup ordering.
  if (embedder.ensureLoaded) void embedder.ensureLoaded()
  return {
    engineKey, embedder,
    async suspend() {
      gateway.setPaused(true)
      await gateway.drain()
      await embedder.suspend?.()
    },
    async resume() {
      await embedder.resume?.()
      if (embedder.ensureLoaded && !await embedder.ensureLoaded()) throw new Error('BGE embedding unavailable on resume')
      gateway.setPaused(false)
    },
    async modelReady() {
      try {
        const url = new URL(options.deviceModelUrl)
        url.pathname = url.pathname.replace(/\/chat\/completions$/, '/ready')
        const check = async endpoint => {
          const response = await fetch(endpoint, { headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(2000), redirect: 'error' })
          return response.ok && (await response.json()).ready === true
        }
        if (!await check(url)) return false
        url.pathname = url.pathname.replace(/\/ready$/, '/embeddings/ready')
        return await check(url)
      } catch { return false }
    },
    status: () => ({ mode: 'managed', pid: child?.pid || null, lastExit, embedding: embedder.status() }),
    async stop() {
      stopping = true; clearTimeout(timer)
      const running = child
      if (running) {
        await new Promise(resolve => {
          const killTimer = setTimeout(() => running.kill('SIGKILL'), 10000)
          running.once('exit', () => { clearTimeout(killTimer); resolve() })
          running.kill('SIGTERM')
        })
      }
      gateway.server.closeAllConnections()
      await new Promise(resolve => gateway.server.close(resolve))
      await embedder.suspend?.()
    },
  }
}
module.exports = { startRuntime, nativeConfig }
