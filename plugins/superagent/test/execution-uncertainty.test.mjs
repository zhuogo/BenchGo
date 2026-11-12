import test from 'node:test';
import assert from 'node:assert/strict';
import { executionUncertainty, executionStopConfirmation } from '../src/execution-uncertainty.mjs';
function fixture() {
  const ticket = { id: 't', status: 'waiting', instructionRevision: 1 };
  const assignment = { id: 'a', ticketId: 't', fence: 1, state: 'uncertain' };
  const run = { id: 'r', sessionId: 's', fence: 1, evidence: { summary: 'saved', transcript: { hash: 'hash' } } };
  const database = { assignments: () => [assignment], runs: () => [run] };
  return { ticket, assignment, run, database };
}
test('saved results expose automatic persistence instead of waiting for user continuation', () => {
  const f = fixture();
  f.run.evidence.executionEffects = { effectsVerified: false, unknownCallIds: ['private'] };
  const fact = executionUncertainty(f.database, f.ticket);
  assert.equal(fact.reasonCode, 'saved-result-pending');
  assert.equal(fact.hasCompletedResult, true);
  assert.equal(fact.automatic, true);
  assert.equal(fact.attempts, 0);
  assert.equal(typeof fact.nextCheckAt, 'number');
  assert.match(fact.reason, /自动.*无需授权/);
  assert.doesNotMatch(JSON.stringify(fact), /private/);
});

test('legacy blocked result recovery resumes automatic persistence without another user decision', () => {
  const f = fixture();
  f.assignment.savedResultRecovery = { fence: 1, runId: 'r', state: 'blocked', attempts: 3,
    reason: '会话存储不可用，请恢复后继续保存结果。', code: 'SESSION_UNAVAILABLE' };
  const fact = executionUncertainty(f.database, f.ticket);
  assert.equal(fact.reasonCode, 'saved-result-pending');
  assert.equal(fact.automatic, true);
  assert.equal(typeof fact.nextCheckAt, 'number');
  assert.equal(fact.recoveryBlocked, undefined);
  f.assignment.savedResultRecovery.fence = 0;
  assert.equal(executionUncertainty(f.database, f.ticket).automatic, true);
});
test('interrupted and paused work does not claim a completed result', () => {
  for (const key of ['interrupted', 'waitingPause', 'waitingAttention']) {
    const f = fixture(); f.run.evidence[key] = true;
    assert.equal(executionUncertainty(f.database, f.ticket).hasCompletedResult, false);
  }
  const f = fixture(); f.run.evidence = undefined;
  assert.equal(executionUncertainty(f.database, f.ticket).reasonCode, 'session-interrupted');
});

test('interruption exposes a specific bounded cause without raw execution errors', () => {
  const f = fixture(); f.run.evidence = undefined;
  f.assignment.lastFailure = { code: 'NETWORK', message: 'PRIVATE COMMAND TOKEN', effects: { effectsVerified: false } };
  const fact = executionUncertainty(f.database, f.ticket);
  assert.match(fact.reason, /连接中断.*工具或外部操作/);
  assert.doesNotMatch(JSON.stringify(fact), /PRIVATE COMMAND TOKEN/);
  f.assignment.instructionRevision = 0;
  assert.equal(executionUncertainty(f.database, f.ticket), null);
});
test('completed tasks never inherit old waiting projections', () => {
  const f = fixture(); f.ticket.status = 'completed';
  assert.equal(executionUncertainty(f.database, f.ticket), null);
});
test('stop confirmation still requires the current original execution identity', () => {
  const f = fixture(); f.ticket.executionControl = { stopRequested: true };
  f.assignment.stopRequest = { fence: 1, owner: 'worker', at: new Date(1000).toISOString() };
  assert.equal(executionStopConfirmation(f.database, f.ticket, { now: 32000 }).stopConfirmationOverdue, true);
  f.assignment.executionStopped = { fence: 1, owner: 'worker' };
  assert.equal(executionStopConfirmation(f.database, f.ticket, { now: 32000 }).stopConfirmationOverdue, false);
});
