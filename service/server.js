#!/usr/bin/env node
// The device's socket stays here; storage/extraction/retrieval run in OpenViking.
const http = require('http')
const fs = require('fs')
const path = require('path')
const net = require('net')
const { loadConfig } = require('./config')

async function prepareSocket(socketPath) {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true })
  let original
  try { original = fs.lstatSync(socketPath) } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  if (!original.isSocket()) throw new Error('socket path is not a socket')
  const stale = await new Promise((resolve, reject) => {
    const probe = net.createConnection(socketPath)
    probe.setTimeout(1000, () => probe.destroy(new Error('socket ownership probe timed out')))
    probe.once('connect', () => { probe.destroy(); resolve(false) })
    probe.once('error', err => {
      if (err.code === 'ECONNREFUSED') resolve(true)
      else if (err.code === 'ENOENT') resolve(false)
      else reject(err)
    })
  })
  if (!fs.existsSync(socketPath)) return
  const current = fs.lstatSync(socketPath)
  if (!stale || current.ino !== original.ino || current.dev !== original.dev) {
    throw new Error(`socket already owned by another listener: ${socketPath}`)
  }
  fs.unlinkSync(socketPath)
}

async function start(config, { runtimeOptions } = {}) {
  if (config.backend !== 'openviking') throw new Error('this service supports only the openviking backend')
  const { OpenVikingClient } = require('./openviking_client')
  const { createApp } = require('./openviking_adapter')
  const mode = config.openviking.mode || 'external'
  if (!['managed', 'external'].includes(mode)) throw new Error('OpenViking mode must be managed or external')
  if (process.platform !== 'win32') await prepareSocket(config.socket)
  const runtime = mode === 'managed' ? await require('./openviking_runtime').startRuntime(config, runtimeOptions) : null
  const client = new OpenVikingClient({ ...config.openviking, ...(runtime ? { apiKey: runtime.engineKey } : {}) })
  const nativeReady = client.ready.bind(client)
  let background
  if (runtime) client.ready = async () => !!runtime.status().pid
    && (background?.paused || (runtime.embedder.status().state === 'ready' && runtime.embedder.status().dim === 1024)) && await nativeReady()
  if (runtime) {
    const nativeMigrationReady = client.migrationReady.bind(client)
    client.migrationReady = async () => await nativeMigrationReady() && await runtime.modelReady()
  }
  const app = createApp(client, { dataDir: config.dataDir, ...config.openviking })
  if (runtime) {
    try { background = new (require('./background').BackgroundControl)({ dataDir: config.dataDir, app, client, runtime }) }
    catch (err) { await app.close(); await runtime.stop(); throw err }
  }
  const handler = async (req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '')
    if (route === '/runtime/background') {
      try {
        if (!background) throw Object.assign(new Error('Background control requires managed OpenViking'), { status: 503 })
        let state
        if (req.method === 'GET') state = background.status()
        else if (req.method === 'POST') state = background.setPaused((await require('./model_gateway').readBody(req, 4096))?.paused)
        else throw Object.assign(new Error('Method not allowed'), { status: 405 })
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(state))
      } catch (err) {
        res.writeHead(err.status || 500, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { code: err.code || 'background_unavailable', message: err.message } }))
      }
    }
    if (runtime && req.method === 'GET' && req.url === '/runtimez') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(runtime.status()))
    }
    // Read-only browsing, graph display and task receipts remain available.
    // Search uses a model, and writes may schedule native work: gate these
    // before acceptance so standby never cancels a partially written request.
    if (background && ['POST', 'PATCH', 'DELETE'].includes(req.method)
        && !['/v2/ingests/lookup', '/v1/grep'].includes(route)) {
      try { return await background.run(() => app(req, res)) }
      catch (err) {
        res.writeHead(err.status || 503, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { code: err.code || 'background_unavailable', message: err.message } }))
      }
    }
    return app(req, res)
  }
  const socketServer = http.createServer(handler)
  let httpServer = null
  const listen = (server, ...args) => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(...args, () => { server.removeListener('error', reject); resolve() })
  })
  try {
    await listen(socketServer, config.socket)
    if (process.platform !== 'win32') {
      if (config.socketMode) fs.chmodSync(config.socket, parseInt(String(config.socketMode), 8))
      if (config.socketGroup) {
        const line = fs.readFileSync('/etc/group', 'utf8').split('\n').find(l => l.split(':')[0] === config.socketGroup)
        if (!line) throw new Error(`socket group does not exist: ${config.socketGroup}`)
        fs.chownSync(config.socket, -1, Number(line.split(':')[2]))
      }
    }
    if (config.httpPort) {
      httpServer = http.createServer(handler)
      await listen(httpServer, config.httpPort, config.httpHost)
    }
  } catch (err) {
    await background?.stop()
    await app.close?.()
    socketServer.close()
    if (httpServer) httpServer.close()
    if (runtime) await runtime.stop()
    throw err
  }
  app.resume?.() // Resume receipt monitoring only after this process owns its sockets.
  if (background?.paused) background.reconcile()
  console.log(`[violoop-mem] OpenViking adapter listening: ${config.socket}`)
  console.log(`[violoop-mem] backend=openviking; adapter state=${config.dataDir}`)
  let shutdownPromise
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise
    process.removeListener('SIGTERM', shutdown)
    process.removeListener('SIGINT', shutdown)
    const closingApp = (async () => { await background?.stop(); await app.close?.() })()
    socketServer.close()
    if (httpServer) httpServer.close()
    // Keep-alive clients must not keep a systemd stop pending indefinitely.
    const timer = setTimeout(() => {
      socketServer.closeAllConnections()
      if (httpServer) httpServer.closeAllConnections()
    }, 2000)
    timer.unref()
    shutdownPromise = closingApp.then(() => runtime?.stop())
    return shutdownPromise
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  return { client, socketServer, httpServer, runtime, background, shutdown }
}

if (require.main === module) start(loadConfig()).catch(err => {
  console.error('[violoop-mem] startup failed:', err.message)
  process.exitCode = 1
})
module.exports = { start, createApp: (...args) => require('./openviking_adapter').createApp(...args) }
