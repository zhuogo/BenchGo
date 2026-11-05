import test from 'node:test';
import assert from 'node:assert/strict';
import { retainAssistantSession } from '../client/session-retain.mjs';
test('catalog lag refreshes once and retains the same session without resetting history', async () => {
  let attempts = 0, refreshes = 0;
  const reference = {};
  const sessions = { retain(id) { assert.equal(id, 'original'); if (++attempts === 1) throw Error('sessions.retain: unknown session original'); return reference; }, async refresh() { refreshes++; } };
  assert.equal(await retainAssistantSession(sessions, 'original'), reference);
  assert.equal(refreshes, 1); assert.equal(attempts, 2);
});
test('persistent absence is bounded, cancellation prevents late retain and other errors propagate', async () => {
  let attempts = 0;
  const sessions = { retain() { attempts++; throw Error('sessions.retain: unknown session missing'); }, async refresh() {} };
  await assert.rejects(retainAssistantSession(sessions, 'missing'), /unknown session/);
  assert.equal(attempts, 2);
  const controller = new AbortController(); attempts = 0;
  sessions.refresh = async () => controller.abort();
  await assert.rejects(retainAssistantSession(sessions, 'missing', controller.signal), { name: 'AbortError' });
  assert.equal(attempts, 1);
  await assert.rejects(retainAssistantSession({ retain() { throw Error('permission denied'); } }, 'id'), /permission denied/);
});
