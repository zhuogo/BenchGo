import test from 'node:test';
import assert from 'node:assert/strict';
import { canFallback, isTransientFailure, roleModels, auxiliaryModels } from '../src/routing.mjs';

test('role queues preserve explicit opaque IDs and keep Worker separate from Router and auxiliary', () => {
  const router = { providerId: 'Router/@', modelId: 'Exact: Router/01' };
  const worker = { providerId: 'Worker/@', modelId: 'Exact: Worker/02', options: { reasoningEffort: 'ultra' } };
  const backup = { providerId: 'Backup/@', modelId: 'Exact: Worker/03' };
  const auxiliary = { providerId: 'Aux/@', modelId: 'Exact: Aux/04' };
  const config = { models: [router], workerModels: [worker, backup], auxiliary: { models: [auxiliary], capabilities: ['summary'] } };
  assert.deepEqual(roleModels(undefined, config, 'router'), [router]);
  assert.deepEqual(roleModels(undefined, config, 'worker'), [worker, backup]);
  assert.deepEqual(roleModels(backup, config, 'worker'), [backup, worker]);
  assert.deepEqual(roleModels(router, config, 'worker'), [router, worker, backup]);
  assert.deepEqual(roleModels(undefined, { ...config, workerModels: [] }, 'worker'), [router]);
  assert.deepEqual(roleModels(undefined, { models: [router] }, 'worker'), [router]);
  assert.deepEqual(auxiliaryModels(router, config, 'summary'), [auxiliary, router]);
  assert.deepEqual(auxiliaryModels(router, config, 'review'), [router]);
  const detached = roleModels(undefined, config, 'worker');
  detached[0].options.reasoningEffort = 'changed';
  assert.equal(worker.options.reasoningEffort, 'ultra');
});

test('same-model auxiliary deduplication preserves explicitly selected options', () => {
  const primary = { providerId: 'Exact/@', modelId: 'Exact: Model/1', options: { reasoningEffort: 'ultra', maxTokens: 700 } };
  const configured = { ...primary, options: { reasoningEffort: 'low', maxTokens: 100 } };
  const backup = { providerId: 'Backup/@', modelId: 'Exact: Model/2' };
  const config = { models: [configured], auxiliary: { models: [configured, backup], capabilities: ['review'] } };
  assert.deepEqual(auxiliaryModels(primary, config, 'review'), [primary, backup]);
});

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
