import test from 'node:test';
import assert from 'node:assert/strict';
import { requestExternalActionApproval } from '../src/approval.mjs';

test('external approval never trusts internal authorized flag and preserves official once-only outcome', async () => {
  let asks = 0;
  const ctx = { get: () => ({ request: async request => { asks++; assert.equal(request.toolName, 'assistant_external_action'); assert.match(request.reason, /recipient/); return 'allowed-once'; } }) };
  assert.equal(await requestExternalActionApproval(ctx, { exec: { agent: {}, callId: 'send', authorized: true }, action: { category: 'external-send', target: { recipient: 'person' }, content: { text: 'final' } } }), 'allowed-once');
  assert.equal(asks, 1);
});
