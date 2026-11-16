const { test } = require('node:test')
const assert = require('node:assert/strict')
const { modelError } = require('../model_error')

test('recognizes nested SDK auth failures behind an outer 502', () => {
  const result = modelError("Error code: 502 - {'error': {'message': '401 Authentication Fails, Your api key: ****demo is invalid (request_id: upstream-demo)'}}")
  assert.equal(result.code, 'auth_error')
  assert.equal(result.retryable, false)
  assert.equal(result.requiresAction, true)
  assert.equal(result.upstream_request_id, 'upstream-demo')
  assert.ok(!JSON.stringify(result).includes('****demo'))
})

test('retains safe metadata from structured or SDK-rendered errors', () => {
  const error = { code: 'auth_error', message: 'safe', request_id: 'req-test',
    upstream_request_id: 'upstream-test', model: 'custom-model', provider: 'custom',
    credential_source: 'byok', retryable: false, action: 'check_credentials' }
  for (const value of [error, JSON.stringify({ error }), `Error code: 401 - ${JSON.stringify({ error })}`]) {
    assert.deepEqual(modelError(value), { request_id: 'req-test', upstream_request_id: 'upstream-test',
      model: 'custom-model', provider: 'custom', credential_source: 'byok', action: 'check_credentials',
      code: 'auth_error', retryable: false, requiresAction: true, ...(typeof value === 'string' && value.startsWith('Error') ? { upstream_status: 401 } : {}) })
  }
})

test('billing blocks retries, but ordinary 429 and 503 remain retryable', () => {
  for (const code of ['credit_exhausted', 'budget_exceeded', 'MODEL_ROUTE_UNAVAILABLE']) {
    assert.equal(modelError({ error: { code, retryable: true }, status: 502 }).retryable, false)
  }
  for (const status of [429, 503, 504]) assert.equal(modelError({ status }).retryable, true)
  assert.equal(modelError('Error code: 401 - credentials rejected').requiresAction, true)
  assert.equal(modelError('Error code: 402 - Payment Required').requiresAction, true)
  assert.equal(modelError('There are 401 messages in the source').retryable, true)
})
