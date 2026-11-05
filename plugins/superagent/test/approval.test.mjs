import test from 'node:test';
import assert from 'node:assert/strict';
import { requestAssistantApproval } from '../src/approval.mjs';

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
