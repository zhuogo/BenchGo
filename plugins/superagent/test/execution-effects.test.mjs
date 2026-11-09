import test from 'node:test';
import assert from 'node:assert/strict';
import { executionEffects } from '../src/execution-effects.mjs';

const call = (id, name, args = {}) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }] } } });
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

const actionResult = (id, value) => ({ type: 'tool/result', data: { message: { toolCallId: id,
  content: [{ type: 'text', text: JSON.stringify(value) }] } } });

test('the registered external-action catalog and prepare never submit, including failed or interrupted preparation', () => {
  const events = [call('catalog', 'assistant_external_action', { operation: 'catalog' }),
    call('prepare', 'assistant_external_action', { operation: 'prepare', input: { targetTriggerId: 'exact-id', text: 'final' } }),
    result('prepare', 'ACTION_TARGET_NOT_FOUND'), call('interrupted', 'assistant_external_action', { operation: 'prepare' })];
  assert.deepEqual(executionEffects({ events }), { effectsVerified: true, unknownCallIds: [] });
  assert.equal(executionEffects({ events: [call('alias', 'vendor_external_action', { operation: 'prepare' }), result('alias', 'ACTION_TARGET_NOT_FOUND')] }).effectsVerified, false);
  assert.equal(executionEffects({ events: [call('bad-operation', 'assistant_external_action'), actionResult('bad-operation', { state: 'completed' })] }).effectsVerified, false);
});

test('successful tool transport cannot hide an uncertain external submission', () => {
  for (const value of [{ state: 'uncertain', requiresReconciliation: true }, { state: 'submitted' },
    { state: 'completed', requiresReconciliation: true }, { state: 'pending' }, { text: 'sent' }, null]) {
    assert.deepEqual(executionEffects({ events: [call('send', 'assistant_external_action', { operation: 'submit', actionId: 'action' }), actionResult('send', value)] }),
      { effectsVerified: false, unknownCallIds: ['send'] });
  }
  for (const state of ['completed', 'denied', 'handoff']) assert.equal(executionEffects({ events: [
    call('send', 'assistant_external_action', { operation: 'submit' }), actionResult('send', { state }),
  ] }).effectsVerified, true);
  for (const tail of [[], [result('send', 'TIMEOUT')]]) assert.equal(executionEffects({ events: [
    call('send', 'assistant_external_action', { operation: 'submit' }), ...tail,
  ] }).effectsVerified, false);
  assert.equal(executionEffects({ events: [call('send', 'assistant_external_action', { operation: 'submit' }), result('send', 'ABORTED_BEFORE_DISPATCH')] }).effectsVerified, true);
  assert.equal(executionEffects({ events: [call('prepare', 'assistant_external_action', { operation: 'prepare' }), actionResult('prepare', { state: 'uncertain' })] }).effectsVerified, false, 'an existing unresolved action is not cleared by preparing it again');
});

test('nested calls use their own original operation and complete structured receipt', () => {
  const nested = (id, operation, extra = {}) => ({ type: 'tool/ptc-dispatch-start', data: {
    rootCallId: 'outer', parentCallId: 'outer', subCallId: id, name: 'assistant_external_action', arguments: { operation }, ...extra } });
  const settled = (id, state, extra = {}) => ({ type: 'tool/ptc-dispatch', data: {
    rootCallId: 'outer', parentCallId: 'outer', subCallId: id, name: 'assistant_external_action', arguments: {},
    content: [{ type: 'text', text: JSON.stringify({ state }) }], ...extra } });
  const events = [call('outer', 'run_code'), nested('local', 'prepare'), settled('local', undefined, { isError: true }),
    nested('send', 'submit'), settled('send', 'uncertain'), result('outer')];
  assert.deepEqual(executionEffects({ events }), { effectsVerified: false, unknownCallIds: ['send'] });
  assert.equal(executionEffects({ events: [settled('legacy', 'denied', { arguments: { operation: 'submit' } })] }).effectsVerified, true);
  assert.equal(executionEffects({ events: [nested('spilled', 'submit'), settled('spilled', 'completed', { content: [{ type: 'text', text: 'output stored at another location' }] })] }).effectsVerified, false);
});

test('a later local call or reused call id never erases unresolved submission', () => {
  const events = [call('reused', 'assistant_external_action', { operation: 'submit' }), actionResult('reused', { state: 'uncertain' }),
    call('reused', 'assistant_external_action', { operation: 'prepare' }), actionResult('reused', { state: 'pending' })];
  assert.deepEqual(executionEffects({ events }), { effectsVerified: false, unknownCallIds: ['reused'] });
});
