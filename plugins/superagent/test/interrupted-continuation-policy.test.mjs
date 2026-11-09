import test from 'node:test';
import assert from 'node:assert/strict';
import { interruptedContinuationPolicy } from '../src/interrupted-continuation-policy.mjs';

test('automatic retry budget survives receipt history, counts legacy attempts and excludes explicit human requests', () => {
  const run = { state: 'uncertain', fence: 2, updatedAt: new Date(2000).toISOString(), interruptedRecoveries: [
    { fromFence: 1, at: new Date(1000).toISOString() },
    { fromFence: 1, at: new Date(1500).toISOString(), automatic: false },
  ] };
  const pending = interruptedContinuationPolicy(run, { now: 31999 });
  assert.equal(pending.attempts, 1); assert.equal(pending.limit, 2); assert.equal(pending.nextAttemptAt, 32000);
  assert.equal(pending.backingOff, true);
  assert.equal(interruptedContinuationPolicy(run, { now: 32000 }).backingOff, false);
  run.interruptedRecoveries.push({ fromFence: 2, at: new Date(32000).toISOString(), automatic: true });
  const limited = interruptedContinuationPolicy(run, { now: 999999999 });
  assert.equal(limited.attempts, 2); assert.equal(limited.exhausted, true); assert.equal(limited.nextAttemptAt, null);
});
