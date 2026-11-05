import test from 'node:test';
import assert from 'node:assert/strict';
import { canFallback, isTransientFailure } from '../src/routing.mjs';

test('Harness transient and credential failures permit bounded model failover', () => {
  for (const code of ['TIMEOUT', 'RATE_LIMIT', 'SERVER', 'QUOTA', 'ECONNRESET']) assert.equal(canFallback({ code }), true, code);
  for (const status of [401, 402, 404, 408, 429, 500, 502, 503, 504]) assert.equal(canFallback({ status }), true, String(status));
});

test('403 fails over only for structured credential errors and policy always wins', () => {
  for (const code of ['AUTHENTICATION', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL']) assert.equal(canFallback({ status: 403, code }), true);
  for (const code of ['CONTENT_FILTER', 'CONTENT_POLICY_VIOLATION', 'POLICY_DENIED', 'REFUSAL', 'PERMISSION_DENIED']) {
    assert.equal(canFallback({ status: 503, code }), false);
    assert.equal(canFallback({ status: 401, code }), false);
  }
  assert.equal(canFallback({ status: 403, code: 'INVALID_CREDENTIAL', refusal: true }), false);
  assert.equal(canFallback({ status: 403, message: 'wrong API key' }), false);
});

test('transient classification includes wrapped transport failures but not authentication or policy', () => {
  for (const error of [{ statusCode: 429 }, { response: { status: 503 } }, { name: 'TimeoutError' }, { cause: { code: 'ECONNRESET' } }]) assert.equal(isTransientFailure(error), true);
  for (const error of [{ status: 401 }, { status: 403 }, { code: 'INVALID_CREDENTIAL' }]) assert.equal(isTransientFailure(error), false);
});

test('permission, refusal, context repair and cancellation do not permit failover', () => {
  for (const error of [{ status: 403 }, { status: 400 }, { status: 503, refusal: true }, { name: 'AbortError' }, ...['CONTEXT_LENGTH_EXCEEDED', 'CONTEXT_WINDOW_EXCEEDED', 'IMAGE_OFFLOAD_REQUIRED'].map(code => ({ code, status: 503 }))]) assert.equal(canFallback(error), false);
});
