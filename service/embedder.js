/**
 * embedder.js — local GGUF embedding via node-llama-cpp。多模型 profile:
 * 现役 bge-m3(violoop-mem-model deb),遗留 embeddinggemma(violoop-qmd-model
 * deb)自动兜底——提示词格式与标定常数按加载到的模型走(见 PROFILES)。
 *
 * Model resolution order (first hit wins):
 *   1. config embedding.model_path (absolute file)
 *   2. $QMD_MODELS_DIR/<candidate>(候选按 MODEL_CANDIDATES 优先级)
 *   3. /usr/local/share/violoop/mem/models/<candidate>(violoop-mem-model deb)
 *   4. /usr/local/share/violoop/qmd/models/<candidate>(遗留 qmd-model deb)
 *
 * Unlike qmd there is NO automatic HuggingFace download fallback: on the
 * GFW-side boxes that hangs boot-adjacent code paths. Missing model (or
 * missing node-llama-cpp, an optionalDependency) degrades to lexical-only
 * search — every caller must treat embeddings as an enhancement.
 *
 * 换模型的向量迁移是自动的:泵按维度识别陈旧向量重嵌(768→1024 全量换血),
 * 检索按查询向量字节长过滤,过渡期旧向量只是隐身不是出错。⚠️ 若未来换
 * 同维度模型,需要显式作废向量(kv 记录模型名比对),当前未做。
 *
 * The reranker (qwen3-reranker, 610MB) is intentionally NOT ported: qmd
 * shipped with auto_rerank disabled, and recall injects a handful of small
 * blocks the main model can judge itself.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')

// 候选模型按优先级排列:bge-m3(现役,violoop-mem-model deb 提供)优先,
// embeddinggemma(遗留 violoop-qmd-model deb)兜底——过渡期老盒子没装新
// 模型包时自动退回 gemma 继续工作。目录同理:mem/models 新家优先。
const MODEL_CANDIDATES = ['bge-m3-q8_0.gguf', 'embeddinggemma-300M-Q8_0.gguf']
const SYSTEM_MODELS_DIRS = [
  '/usr/local/share/violoop/mem/models',
  '/usr/local/share/violoop/qmd/models',
]

/**
 * 模型 profile:提示词格式 + 标定常数按模型走。嵌入余弦的绝对刻度是
 * 模型私有的(见 calibrateCosine 注释),换模型必须整套重锚,常数由
 * 真机富语料 + 小语料 fixture 双向探针实测得出(方法固化在
 * scripts/ 探针与 test/semantic.js)。
 *
 * ⚠️ 模型文件必须钉 md5:同名 GGUF 不同转换批次的余弦分布可差 0.2
 * (mac/盒子的 embeddinggemma 同名不同文件,真机踩过)。
 */
const PROFILES = [
  {
    id: 'bge-m3',
    match: /bge-m3/i,
    // bge-m3 无前缀约定,标题拼首行提供上下文即可
    doc: (title, text) => (title ? `${String(title).slice(0, 200)}\n${text}` : String(text)),
    query: (q) => String(q),
    // 2026-07-16 mac 实测临时锚(真机重测后定稿):命中层 [0.562,0.691]
    // 噪声顶 0.480;相对判据命中Δ底 0.163 / 噪声Δ顶 0.138(唯一两腿都分开的模型)
    // recallSimFloor:图召回语义腿的原始余弦硬下限。相对判据(relGate)在
    // 离题查询上会把"全场最高的噪声"抬过 0.6(bg 平坦时 Δ 容易 ≥0.15),
    // 2026-07-25 MH 档 46 查询扫描定 0.54:噪声 5→1,正常命中零损失,
    // 距最低 gold 命中(0.555)留 0.015 边距。
    // pivot 同日重锚 0.52→0.545:190 文档库实测离题查询的绝对余弦噪声顶
    // 涨到 0.533(0.52 是 07-16 小语料锚;超短退化查询另由 trivialQ 跳过
    // 不计入),命中层下沿 0.562 未变,取中点留双向边距。
    cal: { pivot: 0.545, slope: 1.8, relGate: 0.15, relSlope: 2.0, simFloor: 0.45, bgPrior: 0.25, bgPriorN: 5, recallSimFloor: 0.54 },
  },
  {
    id: 'gemma',
    match: /gemma/i,
    // embeddinggemma 的非对称前缀约定;真实 title 比 "none" 分离度更好
    doc: (title, text) => `title: ${String(title || 'none').slice(0, 200)} | text: ${text}`,
    query: (q) => `task: search result | query: ${q}`,
    // 2026-07-16 .44 真机锚:分隔带 [0.553,0.576];小语料背景 ≈0.15
    // recallSimFloor=simFloor:gemma 未做过 MH 档扫描,取原下限=行为不变
    cal: { pivot: 0.565, slope: 1.8, relGate: 0.25, relSlope: 2.0, simFloor: 0.4, bgPrior: 0.15, bgPriorN: 5, recallSimFloor: 0.4 },
  },
]
// 未知模型:裸文本 + bge 系常数(现代嵌入模型多无前缀约定;上线前仍须重锚)
const FALLBACK_PROFILE = { id: 'plain', match: /./, doc: PROFILES[0].doc, query: PROFILES[0].query, cal: PROFILES[0].cal }

function profileFor(modelPath) {
  const base = path.basename(String(modelPath || ''))
  return PROFILES.find((p) => p.match.test(base)) || FALLBACK_PROFILE
}

// 试探原生插件能不能在这台机器上加载。getLlama() 挑后端 + dlopen 预编译
// 二进制,这一步在不兼容的 CPU/系统上是**进程级崩溃**而不是 JS 异常,只能
// 隔在另一个进程里试。子进程正常退出(code 0)才认为可用。
//
// 只探 getLlama(),不探 loadModel():前者是"这个二进制能不能在本机跑"的判据,
// 也是实际观察到的崩溃点;后者是读 GGUF 文件,失败通常是正常的 JS 异常,由
// _load 的 try/catch 兜住。这样探测不需要读几百 MB 模型,启动只多一次空转的
// Node 进程(百毫秒级)。
const PROBE_TIMEOUT_MS = 60_000
const PROBE_SRC = [
  "import('node-llama-cpp')",
  '  .then(async (m) => { await m.getLlama({ logLevel: m.LlamaLogLevel.error }); process.exit(0) })',
  '  .catch((e) => { process.stderr.write(String((e && e.message) || e)); process.exit(1) })',
].join('\n')

function probeNativeLoadable() {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, ['-e', PROBE_SRC], { cwd: __dirname, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (err) {
      console.warn('[embedder] native probe could not spawn; lexical-only search:', err?.message || err)
      return resolve(false)
    }
    let stderr = ''
    let settled = false
    const done = (ok, why) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!ok) console.warn(`[embedder] native probe failed (${why}); lexical-only search${stderr ? ': ' + stderr.trim().slice(0, 300) : ''}`)
      resolve(ok)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      done(false, `no result in ${PROBE_TIMEOUT_MS}ms`)
    }, PROBE_TIMEOUT_MS)
    child.stderr.on('data', (c) => { stderr += c.toString() })
    child.on('error', (err) => done(false, `spawn error: ${err.message}`))
    child.on('exit', (code, signal) => {
      // signal !== null 就是原生崩溃(Windows 上访问违例走 code,如 3221225477)
      if (code === 0) return done(true, '')
      done(false, signal ? `killed by ${signal}` : `exit code ${code}`)
    })
  })
}

class Embedder {
  constructor({ enabled = true, modelPath = null } = {}) {
    this.enabled = enabled !== false
    this.explicitModelPath = modelPath
    this.state = this.enabled ? 'idle' : 'disabled' // idle|loading|ready|unavailable|disabled
    this.dim = 0
    this.modelPath = null
    this._ctx = null
    this._loading = null
    this._model = null
    this._suspended = false
    this._suspending = null
    this._active = 0
    this._onIdle = null
  }

  resolveModelPath() {
    const candidates = [this.explicitModelPath].filter(Boolean)
    const dirs = [process.env.QMD_MODELS_DIR, ...SYSTEM_MODELS_DIRS].filter(Boolean)
    for (const dir of dirs) for (const f of MODEL_CANDIDATES) candidates.push(path.join(dir, f))
    for (const p of candidates) {
      try { if (fs.existsSync(p) && fs.statSync(p).size > 0) return p } catch { /* unreadable */ }
    }
    return null
  }

  /** Lazy, single-flight load. Never throws — flips state instead. */
  async ensureLoaded() {
    if (this._suspended) return false
    if (!this.enabled || this.state === 'unavailable') return this.state === 'ready'
    if (this.state === 'ready') return true
    if (this._loading) { await this._loading; return this.state === 'ready' }
    this._loading = this._load()
    try { await this._loading } finally { this._loading = null }
    return this.state === 'ready'
  }

  async _load() {
    this.state = 'loading'
    const modelPath = this.resolveModelPath()
    if (!modelPath) {
      console.warn(`[embedder] no model found (${MODEL_CANDIDATES.join('/')} in QMD_MODELS_DIR / ${SYSTEM_MODELS_DIRS.join(' / ')}); lexical-only search`)
      this.state = 'unavailable'
      return
    }
    this.profile = profileFor(modelPath)
    // getLlama() 会加载预编译原生插件并做后端选择(Vulkan → CPU 回落)。在
    // 不兼容的机器上它不是抛异常而是**整个进程挂掉**(访问违例 / 缺指令集 /
    // DLL 加载失败),下面的 try/catch 拦不住 —— 服务就这么没了,连带 v1/v2
    // 全断,尽管本服务设计上完全可以 BM25-only 跑。所以先拿一次性子进程试
    // 探:子进程崩了就把 embedder 标死,主进程照常服务。
    if (!(await probeNativeLoadable())) {
      this.state = 'unavailable'
      return
    }
    try {
      // Optional dependency — absent on platforms without prebuilds.
      const { getLlama, LlamaLogLevel } = await import('node-llama-cpp')
      const llama = await getLlama({ logLevel: LlamaLogLevel.error })
      const model = await llama.loadModel({ modelPath })
      this._model = model
      this._ctx = await model.createEmbeddingContext()
      const probe = await this._ctx.getEmbeddingFor(this.profile.doc('none', 'probe'))
      this.dim = probe.vector.length
      this.modelPath = modelPath
      this.state = 'ready'
      _activeCal = this.profile.cal // 标定刻度跟随已加载的模型
      console.log(`[embedder] ready: ${path.basename(modelPath)} (dim ${this.dim}, profile ${this.profile.id})`)
    } catch (err) {
      console.warn('[embedder] load failed; lexical-only search:', err?.message || err)
      await this._dispose()
      this.state = 'unavailable'
    }
  }

  // 提示词格式跟随模型 profile(gemma 非对称前缀 / bge-m3 裸文本)。
  // 改格式=整个分数分布平移=标定作废,动之前必须重跑双探针。
  async embedQuery(text) {
    if (!(await this.ensureLoaded())) return null
    return this._embed(this.profile.query(text))
  }

  async embedDocument({ title, text } = {}) {
    if (!(await this.ensureLoaded())) return null
    return this._embed(this.profile.doc(title, text))
  }

  async _embed(formatted, retried = false) {
    if (this._suspended) return null
    this._active++
    try {
      const e = await this._ctx.getEmbeddingFor(formatted)
      return new Float32Array(e.vector)
    } catch (err) {
      // getEmbeddingFor fails intermittently under sustained sequential
      // load; one retry recovers it (observed during calibration probing).
      if (!retried && !this._suspended) return await this._embed(formatted, true)
      console.warn('[embedder] embed failed:', err?.message || err)
      return null
    } finally {
      this._active--
      if (!this._active) { this._onIdle?.(); this._onIdle = null }
    }
  }

  async _dispose() {
    const ctx = this._ctx, model = this._model
    this._ctx = null; this._model = null
    try { await ctx?.dispose() } finally { await model?.dispose() }
  }
  async resume() {
    await this._suspending
    this._suspended = false
  }
  suspend() {
    this._suspended = true
    if (!this._suspending) this._suspending = (async () => {
      await this._loading
      if (this._active) await new Promise(resolve => { this._onIdle = resolve })
      await this._dispose()
      if (this.state === 'ready') this.state = 'idle'
    })().finally(() => { this._suspending = null })
    return this._suspending
  }

  status() {
    return { state: this.state, model: this.modelPath ? path.basename(this.modelPath) : null, dim: this.dim || null }
  }

  // 图召回语义腿的原始余弦下限(跟随已加载模型的标定;server 每次召回读取)
  recallSimFloor() {
    return _activeCal.recallSimFloor ?? null
  }
}

function contentHash(text) {
  return crypto.createHash('md5').update(String(text ?? ''), 'utf8').digest('hex')
}

/**
 * Split a memory body into embedding chunks (qmd's content_vectors design:
 * one vector per chunk, search takes the best chunk per document). Splits on
 * markdown headings and paragraph/bullet boundaries, accumulates to
 * ~maxChars, and carries the nearest heading into each chunk for context.
 * Short docs come back as a single chunk — identical behavior to before.
 */
function chunkText(text, { maxChars = 450, maxChunks = 24 } = {}) {
  const body = String(text ?? '').trim()
  if (!body) return []
  // No early return for short docs: a 300-char multi-topic summary still
  // needs its headings split (measured: whole-doc embedding of a mixed
  // summary dilutes a single-topic query below the recall gate).短 +
  // unstructured text falls through to a single chunk naturally.

  const chunks = []
  let heading = ''
  let current = ''
  const flush = () => {
    const c = current.trim()
    if (c) chunks.push(heading && !c.startsWith(heading) ? `${heading}\n${c}` : c)
    current = ''
  }
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trimEnd()
    if (/^#{1,6}\s/.test(line.trim()) || /^\*\*[^*]+\*\*[::]?\s*$/.test(line.trim())) {
      flush()
      heading = line.trim()
      continue
    }
    // Top-level bullets are the atomic facts of summary-shaped memories —
    // each becomes its own chunk (heading carried as context). Grouping
    // bullets measurably dilutes single-topic queries below the recall gate.
    if (/^[-*•]\s|^\d+[.、]\s/.test(line.trim()) && current.trim()) flush()
    if (current.length + line.length + 1 > maxChars && current.trim()) flush()
    current += line + '\n'
    if (chunks.length >= maxChunks) break
  }
  flush()
  return chunks.slice(0, maxChunks)
}

/**
 * 原始余弦 → violoop-edge 历史刻度(召回门 0.60 / 详情档 0.72)。
 *
 * 2026-07-16 真机(.44,225 chunk/205 obs)+ 小语料 fixture 双向实测的
 * 结论(gemma 时代得出,对任何嵌入模型成立):
 *   ① 余弦**绝对值随语料密度整体平移**——富语料命中层与小语料命中层
 *      可差 0.15+,固定分界救一头杀一头;
 *   ② 纯相对判据(超出背景水位)在富语料失效——语义邻近的噪声
 *      (红烧肉→煎牛排)比弱命中在背景里更"突出";
 *   ③ 双判据取 max 互补:绝对腿管富语料,相对腿管小语料/新用户。
 * 公式(常数从 _activeCal 读取,跟随已加载模型的 profile):
 *   绝对腿  0.60 + slope × (sim − pivot)         pivot 锚真机分隔带中点
 *   相对腿  0.60 + relSlope × (sim − bg − relGate) 仅 sim ≥ simFloor 参与
 * bg 由 semanticBackground() 从本次查询对全量向量的余弦分布现算
 * (按 key/实体聚合的 best 集合、剔 top3 的均值 + bgPrior×bgPriorN
 * 伪计数先验,小语料收敛到先验;聚合口径=量"离其他文档/实体多近",
 * 命中文档的同篇兄弟块不抬水位)。
 * 换模型/语料形态漂移 → 重跑真机+fixture 双探针,重锚 profile 常数。
 */
let _activeCal = PROFILES.find((p) => p.id === 'gemma').cal // 模型加载前的默认刻度

/** 本次查询对全量向量的余弦 → 背景水位(剔 top3 均值 + 先验伪计数)。 */
function semanticBackground(sims) {
  let sum = 0
  let n = 0
  if (sims && sims.length > 3) {
    const sorted = [...sims].sort((a, b) => b - a)
    for (let i = 3; i < sorted.length; i++) { sum += sorted[i]; n++ }
  }
  return (sum + _activeCal.bgPrior * _activeCal.bgPriorN) / (n + _activeCal.bgPriorN)
}

function calibrateCosine(sim, bg = null) {
  if (!(sim > 0)) return 0
  const c = _activeCal
  let best = 0.6 + c.slope * (sim - c.pivot)
  if (bg !== null && sim >= c.simFloor) {
    // 相对判据封顶在注入门之下:离题查询上 bg 平坦,"全场最高的噪声"也能
    // Δ≥relGate,若放行到 0.6+ 就会被 edge 每轮自动注入。相对证据只用于
    // 排名(弱配对如 散热器↔水冷 仍靠它排到 top-1),过门必须绝对腿够分。
    const rel = Math.min(0.599, 0.6 + c.relSlope * (sim - bg - c.relGate))
    if (rel > best) best = rel
  }
  return Math.min(0.99, Math.max(0, best))
}

function cosine(a, b) {
  // Vectors from getEmbeddingFor are L2-normalized; dot product IS the
  // cosine. Guard anyway for restored data from other builds.
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom ? dot / denom : 0
}

module.exports = { Embedder, contentHash, cosine, calibrateCosine, semanticBackground, chunkText, profileFor, MODEL_CANDIDATES }
