const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createEmbeddingQueue } = require('../embedding_queue')

test('foreground queries run between background inputs and leave capacity for background progress', async () => {
  const queue = createEmbeddingQueue(), order = []
  let release, entered, part = 0
  const started = new Promise(resolve => { entered = resolve })
  const background = queue.run(async () => {
    order.push(`background-${++part}`)
    if (part === 1) { entered(); await new Promise(resolve => { release = resolve }) }
    return { done: part === 2 }
  })
  await started
  const queries = Array.from({ length: 4 }, (_, index) => queue.run(async () => {
    order.push(`query-${index}`)
    return { done: true }
  }, { query: true }))
  release()
  await Promise.all([background, ...queries])
  assert.deepEqual(order, ['background-1', 'query-0', 'query-1', 'query-2', 'background-2', 'query-3'])
  assert.equal(queue.pending, 0)
})

test('cancelling a queued query never runs it and drain still waits for active inference', async () => {
  const queue = createEmbeddingQueue(), controller = new AbortController()
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const active = queue.run(async () => {
    entered(); await new Promise(resolve => { release = resolve })
    return { done: true }
  })
  await started
  const cancelled = queue.run(() => assert.fail('cancelled query reached the encoder'), { query: true, signal: controller.signal })
  controller.abort()
  await assert.rejects(cancelled, /request cancelled/)
  assert.ok(queue.pending > 0)
  release(); await active
  assert.equal(queue.pending, 0)
})
