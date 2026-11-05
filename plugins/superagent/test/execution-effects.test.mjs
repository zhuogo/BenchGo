import test from 'node:test';
import assert from 'node:assert/strict';
import { executionEffects } from '../src/execution-effects.mjs';
import { reviewInputHash } from '../src/review-input.mjs';

const call = (id, name) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id, name, arguments: '{}' }] } } });
const result = (id, code) => ({ type: 'tool/result', data: { message: { toolCallId: id, content: [], ...(code ? { isError: true } : {}) }, ...(code ? { error: { code } } : {}) } });

test('effect analysis includes missing/error outcomes across all turns without assuming later success resolved them', () => {
  const observed = executionEffects({ events: [
    { type: 'turn/start' }, call('unknown-missing', 'opaque_send'),
    call('unknown-error', 'opaque_publish'), result('unknown-error', 'TIMEOUT'),
    { type: 'turn/end' }, { type: 'turn/start' }, call('later-success', 'opaque_send'), result('later-success'), { type: 'turn/end' },
  ] });
  assert.deepEqual(observed, { effectsVerified: false, unknownCallIds: ['unknown-missing', 'unknown-error'] });
});

test('only known read-only tools and an official before-dispatch abort are safe without success', () => {
  assert.deepEqual(executionEffects({ events: [
    call('search', 'web_search'), result('search', 'NETWORK'), call('read', 'read'),
    call('not-dispatched', 'opaque_send'), result('not-dispatched', 'ABORTED_BEFORE_DISPATCH'),
    call('success', 'opaque_write'), result('success'),
  ] }), { effectsVerified: true, unknownCallIds: [] });
  assert.equal(executionEffects({ events: [call('lookalike', 'vendor_read_only'), result('lookalike', 'TIMEOUT')] }).effectsVerified, false);
});

test('reused or absent call identities never let later success erase an earlier uncertain invocation', () => {
  assert.deepEqual(executionEffects({ events: [
    call('reused-error', 'opaque_send'), result('reused-error', 'TIMEOUT'),
    call('reused-error', 'opaque_send'), result('reused-error'),
    call('reused-missing', 'opaque_publish'), call('reused-missing', 'opaque_publish'), result('reused-missing'),
    call(undefined, 'opaque_send'), result(undefined),
  ] }), { effectsVerified: false, unknownCallIds: ['reused-error', 'reused-missing', 'unidentified:tool:4'] });
});

test('nested dispatch uncertainty survives a successful composite tool result', () => {
  const observed = executionEffects({ events: [call('outer', 'run_code'),
    { type: 'tool/ptc-dispatch-start', data: { subCallId: 'sub-missing', name: 'opaque_send' } },
    { type: 'tool/ptc-dispatch', data: { subCallId: 'sub-error', name: 'opaque_publish', isError: true, error: { code: 'ABORTED' } } },
    result('outer'),
  ] });
  assert.deepEqual(observed, { effectsVerified: false, unknownCallIds: ['sub-missing', 'sub-error'] });
});

test('review fingerprint includes host-observed effect safety independently of Worker summary', () => {
  const input = { ticket: { target: 'task', acceptance: 'check', instructionRevision: 1, mandate: {} }, result: { summary: 'same summary' } };
  const legacy = reviewInputHash(input);
  const verified = reviewInputHash({ ...input, result: { ...input.result, executionEffects: { effectsVerified: true, unknownCallIds: [] } } });
  const unknown = reviewInputHash({ ...input, result: { ...input.result, executionEffects: { effectsVerified: false, unknownCallIds: ['send'] } } });
  assert.notEqual(legacy, verified);
  assert.notEqual(verified, unknown);
});
