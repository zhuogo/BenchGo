import test from 'node:test';
import assert from 'node:assert/strict';
import { executionUncertainty, executionStopConfirmation, executionRecoverySignal, currentExecutionRecoverySignal } from '../src/execution-uncertainty.mjs';
import { ticketReplyInstruction } from '../src/ticket-reply.mjs';

function fixture() {
  const ticket = { id: 't', status: 'open', title: '整理 AI 获客项目与推荐理由', target: '为用户找出可复用项目并给出推荐理由', instructionRevision: 2, resultVersion: 0,
    mandate: { source: { channel: 'desktop', sessionId: 'owner', threadId: 'main' } } };
  const assignment = { id: 'a', ticketId: 't', fence: 3, state: 'uncertain' };
  const run = { id: 'r', fence: 3, state: 'uncertain', evidence: { summary: 'saved', transcript: { hash: 'hash' } } };
  const database = { assignments: () => [assignment], runs: () => [run], getTicket: id => id === ticket.id ? ticket : null };
  return { ticket, assignment, run, database };
}

test('uncertainty distinguishes five supported reasons using only bounded ledger facts', () => {
  const f = fixture(), fact = () => executionUncertainty(f.database, f.ticket);
  assert.equal(fact().reasonCode, 'session-interrupted');
  f.assignment.lastFailure = { code: 'WORKER_TURN_INCOMPLETE' };
  assert.equal(fact().reasonCode, 'worker-incomplete');
  f.assignment.verificationError = 'EVIDENCE_MISMATCH';
  assert.equal(fact().reasonCode, 'evidence-mismatch');
  f.ticket.status = 'pausing';
  assert.equal(fact().reasonCode, 'pause-unconfirmed');
  f.run.evidence.executionEffects = { effectsVerified: false, unknownCallIds: ['private-argument'] };
  assert.equal(fact().reasonCode, 'external-effects-unknown');
  assert.doesNotMatch(JSON.stringify(fact()), /private-argument/);
});

test('uses existing inspection attempts and backoff; escalates at sixth unsuccessful check without adding a loop', () => {
  const f = fixture();
  f.assignment.verificationInspectionAttempts = 5; f.assignment.verificationAfter = 900000;
  assert.equal(executionUncertainty(f.database, f.ticket).escalated, false);
  f.assignment.verificationInspectionAttempts++;
  const fact = executionUncertainty(f.database, f.ticket);
  assert.equal(fact.attempts, 6); assert.equal(fact.nextCheckAt, new Date(900000).toISOString()); assert.equal(fact.escalated, true);
});

test('missing completion evidence is explicitly blocked rather than falsely promising automatic recovery', () => {
  const f = fixture(); f.run.evidence = undefined;
  const fact = executionUncertainty(f.database, f.ticket);
  assert.equal(fact.automatic, false); assert.equal(fact.nextCheckAt, null);
  assert.match(fact.recoveryBlocked, /完整结束证据/);
});

test('stop gate presentation reflects immediate effectiveness and overdue executor confirmation after 30 seconds', () => {
  const f = fixture(); f.ticket.status = 'cancelling';
  f.assignment.stopRequest = { fence: 3, at: new Date(1000).toISOString() };
  assert.equal(executionUncertainty(f.database, f.ticket), null);
  assert.equal(executionStopConfirmation(f.database, f.ticket, { now: 30999 }).stopConfirmationOverdue, false);
  assert.equal(executionStopConfirmation(f.database, f.ticket, { now: 31000 }).stopConfirmationOverdue, true);
  f.assignment.executionStopped = { fence: 3 };
  assert.equal(executionStopConfirmation(f.database, f.ticket, { now: 50000 }).stopConfirmationOverdue, false);
});

test('entry, escalation and verified recovery signals have separate stable identities and reject stale authority or fence', () => {
  const f = fixture(), first = executionRecoverySignal(f.database, f.ticket);
  assert.equal(first.phase, 'entered');
  f.assignment.verificationInspectionAttempts = 1;
  assert.equal(currentExecutionRecoverySignal(f.database, first).attempts, 1);
  f.assignment.verificationInspectionAttempts = 6;
  const escalated = executionRecoverySignal(f.database, f.ticket);
  assert.notEqual(escalated.eventKey, first.eventKey); assert.equal(currentExecutionRecoverySignal(f.database, first), null);
  f.assignment.state = 'queued'; f.assignment.verificationOnly = { runId: 'r' };
  const resolved = executionRecoverySignal(f.database, f.ticket, { previous: escalated });
  assert.equal(resolved.disposition, 'verified-result-finalization');
  assert.ok(currentExecutionRecoverySignal(f.database, resolved));
  f.assignment.fence++;
  assert.equal(currentExecutionRecoverySignal(f.database, resolved), null);
  f.ticket.instructionRevision++;
  assert.equal(currentExecutionRecoverySignal(f.database, first), null);
});

test('recovery instruction requires natural proactive explanation, constrained management and unknown-effect non-replay', () => {
  const f = fixture(), text = ticketReplyInstruction(executionRecoverySignal(f.database, f.ticket));
  assert.match(text, /主动用你自己的话/); assert.match(text, /不重跑或重发/);
  assert.match(text, /assistant_execution_manage/); assert.match(text, /不能扩大原有授权/);
});
