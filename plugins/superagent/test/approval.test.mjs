import test from 'node:test';
import assert from 'node:assert/strict';
import { requestAssistantApproval, requestExternalActionApproval } from '../src/approval.mjs';

test('assistant approval uses the Harness approval service with the real agent and call context', async () => {
  const agent = { session: { id: 'owner' } }, signal = new AbortController().signal;
  let request;
  const ctx = { get(name) { assert.equal(name, 'approval'); return { async request(value) { request = value; return 'allowed-once'; } }; } };
  assert.equal(await requestAssistantApproval(ctx, { agent, signal, callId: 'call' }, 'assistant_delegate', 'work'), true);
  assert.deepEqual(request, { agent, signal, callId: 'call', toolName: 'assistant_delegate', reason: 'work' });
  assert.equal(await requestAssistantApproval({ get: () => ({ request: async () => 'denied' }) }, { agent }, 'assistant_goals', 'goal'), false);
  await assert.rejects(requestAssistantApproval({ get: () => undefined }, { agent }, 'assistant_delegate', 'work'), /人工审批/);
  assert.equal(await requestAssistantApproval({}, { authorized: true }, 'assistant_delegate', 'work'), true);
});

test('external approval never trusts internal authorized flag and preserves official once-only outcome', async () => {
  let asks = 0;
  const ctx = { get: () => ({ request: async request => { asks++; assert.equal(request.toolName, 'assistant_external_action'); assert.match(request.reason, /recipient/); return 'allowed-once'; } }) };
  assert.equal(await requestExternalActionApproval(ctx, { exec: { agent: {}, callId: 'send', authorized: true }, action: { category: 'external-send', target: { recipient: 'person' }, content: { text: 'final' } } }), 'allowed-once');
  assert.equal(asks, 1);
});
