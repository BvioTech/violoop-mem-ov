const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Embedder } = require('../embedder')
const { loadConfig } = require('../config')

function fixture(options = {}, contextSize = 8192) {
  const embedder = new Embedder(options)
  const calls = [], tokenized = []
  embedder.state = 'ready'
  embedder.profile = { query: value => value, doc: (title, value) => title + '\n' + value }
  // A deterministic tokenizer with different token counts from UTF-16 length.
  embedder._model = { tokenize: value => { tokenized.push(value); return Array.from(value, char => char.codePointAt(0)) } }
  embedder._ctx = { _llamaContext: { contextSize }, getEmbeddingFor: async tokens => { calls.push(tokens); return { vector: [1, 0] } } }
  return { embedder, calls, tokenized }
}

test('long queued documents and queries are truncated before inference, without changing source text', async () => {
  const { embedder, calls } = fixture({ maxInputTokens: 16 })
  const source = { title: 'Project', text: '报告😀'.repeat(1000) }
  const original = source.text
  await embedder.embedDocument(source)
  await embedder.embedQuery(source.text)
  assert.equal(source.text, original)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].length, 16)
  assert.equal(calls[1].length, 16)
  assert.deepEqual(calls[1], Array.from(original, char => char.codePointAt(0)).slice(0, 16))
  assert.equal(embedder.truncatedInputs, 2)
})

test('short input remains intact and model context leaves space for special tokens', async () => {
  const { embedder, calls } = fixture({ maxInputTokens: 512 }, 20)
  await embedder.embedQuery('短句😀')
  await embedder.embedQuery('x'.repeat(100))
  assert.deepEqual(calls[0], [0x77ed, 0x53e5, 0x1f600])
  assert.equal(calls[1].length, 16)
  assert.equal(embedder.truncatedInputs, 1)
})

test('the default budget truncates at 4096 model tokens without a separate character cutoff', async () => {
  const { embedder, calls, tokenized } = fixture()
  const input = '报告😀'.repeat(3000)
  await embedder.embedQuery(input)
  assert.equal(tokenized[0], input)
  assert.equal(calls[0].length, 4096)
  assert.deepEqual(calls[0], Array.from(input, char => char.codePointAt(0)).slice(0, 4096))
  assert.equal(embedder.lastInput.inputChars, input.length)
  assert.equal(embedder.lastInput.tokenizedChars, input.length)
  assert.equal(embedder.lastInput.state, 'complete')
})

test('token budgets are validated and configurable, with a bounded default', () => {
  assert.equal(new Embedder().maxInputTokens, 4096)
  for (const value of [0, -1, 15, 8193, 1.5, 'invalid']) {
    assert.throws(() => new Embedder({ maxInputTokens: value }), RangeError)
  }
  assert.equal(loadConfig([], {}).embedding.maxInputTokens, 4096)
  assert.equal(loadConfig([], { VIOLOOP_MEM_EMBEDDING_MAX_INPUT_TOKENS: '256' }).embedding.maxInputTokens, '256')
})
