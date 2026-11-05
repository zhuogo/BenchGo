import test from 'node:test';
import assert from 'node:assert/strict';
import { installGoalBudgetGate, isVerifiedPauseEnding } from '../src/goal-budget-gate.mjs';

test('retries and compaction consume shared reservations before dispatch; denial throws synchronously', async () => {
  let hook, calls = 0, reservations = 0, disposed = false;
  const seen = [], denials = [];
  const gate = installGoalBudgetGate({ on: (_name, callback) => { hook = callback; return () => { disposed = true; }; } }, {
    database: { ticketGoalBudget: () => ({}), recordGoalRequestUsage: receipt => { assert.equal(receipt.tokens, null); }, reserveGoalRequest: request => { seen.push(request); return ++reservations <= 2 ? { allowed: true } : { allowed: false, goalId: 'parent', reason: 'requests' }; } },
    ticketId: 'ticket', sessionId: 'worker', onDenied: decision => denials.push(decision),
  });
  const next = () => { calls++; return []; };
  hook({ sessionId: 'other' }, next);
  hook({ sessionId: 'worker', purpose: 'chat' }, next);
  for await (const _chunk of hook({ sessionId: 'worker', purpose: 'compaction' }, next)) {}
  let failure;
  assert.throws(() => hook({ sessionId: 'worker', purpose: 'chat' }, next), error => { failure = error; return gate.owns(error); });
  assert.equal(calls, 3);
  assert.equal(new Set(seen.map(row => row.requestId)).size, 3);
  assert.equal(denials[0].goalId, 'parent');
  assert.equal(gate.owns(Object.assign(new Error(failure.message), { code: failure.code })), false);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => hook({ sessionId: 'worker', signal: controller.signal }, next), { name: 'AbortError' });
  assert.equal(reservations, 3);
  gate.dispose(); assert.equal(disposed, true);
});

test('ordinary errors cannot become resumable pauses without a matching host-saved ending', () => {
  const reason = { kind: 'error', error: { code: 'UNKNOWN', message: 'Goal budget exhausted' } };
  assert.equal(!!isVerifiedPauseEnding(reason, {}), false);
  assert.equal(!!isVerifiedPauseEnding(reason, { waitingBudget: { goalId: 'parent' } }), false);
  assert.equal(isVerifiedPauseEnding(reason, { waitingBudget: { terminal: structuredClone(reason) } }), true);
  assert.equal(isVerifiedPauseEnding({ ...reason, error: { code: 'UNKNOWN', message: 'unrelated error' } }, { waitingBudget: { terminal: reason } }), false);
});
