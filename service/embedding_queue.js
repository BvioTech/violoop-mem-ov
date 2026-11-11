// One inference at a time, but a background batch yields after each input.
// Reserve admission for interactive queries and bound priority so ingestion
// still progresses while the user repeatedly searches.
function createEmbeddingQueue() {
  const queries = [], background = [], jobs = new Set()
  let running = false, queryBurst = 0
  async function pump() {
    if (running) return
    running = true
    try {
      while (queries.length || background.length) {
        const lane = queries.length && (!background.length || queryBurst < 3) ? queries : background
        const job = lane.shift()
        if (job.cancelled) continue
        queryBurst = lane === queries ? queryBurst + 1 : 0
        job.timing.queueMs += Date.now() - job.queuedAt
        const started = Date.now()
        try {
          const value = await job.step()
          if (job.cancelled) continue
          if (value.done) job.finish(null, value.result)
          else { job.queuedAt = Date.now(); lane.push(job) }
        } catch (error) { job.finish(error) }
        finally { job.timing.computeMs += Date.now() - started }
      }
    } finally { running = false }
  }
  return {
    get pending() { return jobs.size + (running ? 1 : 0) },
    run(step, { query = false, signal, timing = { queueMs: 0, computeMs: 0 } } = {}) {
      if (jobs.size >= (query ? 8 : 6)) return Promise.reject(Object.assign(Error('embedding queue full'), { status: 429 }))
      return new Promise((resolve, reject) => {
        const lane = query ? queries : background
        const job = { step, timing, queuedAt: Date.now(), cancelled: false, finish(error, value) {
          if (!jobs.delete(job)) return
          signal?.removeEventListener('abort', cancel)
          const index = lane.indexOf(job)
          if (index >= 0) lane.splice(index, 1)
          error ? reject(error) : resolve(value)
        } }
        const cancel = () => {
          job.cancelled = true
          job.finish(Object.assign(Error('request cancelled'), { status: 499 }))
        }
        jobs.add(job)
        if (signal?.aborted) return cancel()
        signal?.addEventListener('abort', cancel, { once: true })
        lane.push(job)
        void pump()
      })
    },
  }
}
module.exports = { createEmbeddingQueue }
