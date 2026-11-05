import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-orchestration-'));
  const db = createAssistantOrchestrationStore({ directory });
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  return db;
}
const input = key => ({ dedupeKey: key, thread: { id: 'thread', source: { type: 'feishu', id: 'chat' } }, source: { eventId: key }, actor: { id: 'owner' }, content: '原始指令', gate: { allowed: true, strength: 'explicit' }, policyVersion: 'p1' });

test('pause blocks queued work and resumes the exact checkpoint without replay', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('pause'), mode: 'direct' });
  const ticket = db.createTicket({ threadId: 'thread', target: 'task', mandate: {} });
  db.createAssignment(ticket.id, { id: 'pause-work' });
  assert.equal(db.pauseTicket(ticket.id).status, 'paused');
  assert.deepEqual(db.claimAssignments('worker', { validateMandate: () => true, now: 0 }), []);
  assert.equal(db.resumeTicket(ticket.id).status, 'open');
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true, now: 0 });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = db.prepareRun(assignment.id, { ...ownership, sessionId: 'pause-session', directory: 'workspace', now: 1 });
  db.updateRun(run.id, { ...ownership, state: 'submitted', now: 2 });
  assert.equal(db.pauseTicket(ticket.id).status, 'pausing');
  assert.throws(() => db.resumeTicket(ticket.id), { code: 'PAUSE_PENDING' });
  assert.equal(db.renewAssignment(assignment.id, { ...ownership, validateMandate: () => true, now: 3 }).allowed, true);
  const result = { runId: run.id, sessionId: 'pause-session', waitingPause: true, checkpoint: { manifestHash: 'saved' }, transcript: { hash: 'saved', lastSeq: 8 }, remainingExecutionMs: 1234 };
  db.updateRun(run.id, { ...ownership, state: 'verifying', evidence: result, now: 4 });
  assert.throws(() => db.parkPause(assignment.id, { ...ownership, result: { ...result, checkpoint: {} }, now: 5 }), { code: 'RUN_CONFLICT' });
  assert.throws(() => db.parkPause(assignment.id, { ...ownership, result, now: 5 }), { code: 'PAUSE_PENDING' });
  db.confirmExecutionStopped(assignment.id, ownership);
  assert.equal(db.parkPause(assignment.id, { ...ownership, result, now: 5 }).state, 'paused');
  assert.equal(db.getTicket(ticket.id).status, 'paused');
  assert.equal(db.results(ticket.id).length, 0);
  db.resumeTicket(ticket.id);
  const [resumed] = db.claimAssignments('next-worker', { validateMandate: () => true, now: 6 });
  assert.equal(resumed.pauseContinuation.runId, run.id);
  assert.equal(resumed.fence, assignment.fence + 1);
  assert.equal(db.runs(assignment.id).length, 1);
  assert.equal(db.runs(assignment.id)[0].evidence.remainingExecutionMs, 1234);
  assert.equal(db.runs(assignment.id)[0].sessionId, 'pause-session');
});

test('pause survives reopening and never replays an expired execution', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('pause-restart'), mode: 'direct' });
  const queued = db.createTicket({ threadId: 'thread', target: 'queued', mandate: {} });
  db.createAssignment(queued.id, { id: 'queued-paused' });
  db.pauseTicket(queued.id);
  const running = db.createTicket({ threadId: 'thread', target: 'running', mandate: {} });
  db.createAssignment(running.id, { id: 'unknown-paused' });
  db.claimAssignments('worker', { validateMandate: () => true, now: 0, leaseMs: 10 });
  db.pauseTicket(running.id);
  const reopened = createAssistantOrchestrationStore({ filename: db.path });
  try {
    assert.equal(reopened.getTicket(queued.id).status, 'paused');
    assert.deepEqual(reopened.claimAssignments('replacement', { validateMandate: () => true, now: 11 }), []);
    assert.equal(reopened.getAssignment('unknown-paused').state, 'uncertain');
    assert.equal(reopened.pauseTicket(running.id).status, 'pausing');
    assert.throws(() => reopened.resumeTicket(running.id), { code: 'PAUSE_PENDING' });
    reopened.resumeTicket(queued.id);
    assert.equal(reopened.claimAssignments('replacement', { validateMandate: () => true, now: 12 })[0].id, 'queued-paused');
    assert.equal(reopened.cancelTicket(running.id).status, 'cancelling');
    assert.equal(reopened.resumeTicket(running.id).status, 'cancelling');
  } finally { reopened.close(); }
});

test('requirement edits fence stale results and leases without status updates changing requirements', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('revision'), mode: 'direct' });
  const ticket = db.createTicket({ threadId: 'thread', target: 'original', acceptance: 'first check', mandate: {} });
  assert.equal(ticket.instructionRevision, 1);
  db.createAssignment(ticket.id, { id: 'active' });
  db.createAssignment(ticket.id, { id: 'queued' });
  const [active] = db.claimAssignments('worker', { validateMandate: () => true, now: 0 });
  assert.equal(active.instructionRevision, 1);
  assert.equal(db.updateTicket(ticket.id, { status: 'waiting' }).instructionRevision, 1);
  assert.equal(db.updateTicket(ticket.id, { target: 'original', status: 'open' }).instructionRevision, 1);
  const changed = db.updateTicket(ticket.id, { acceptance: 'new check' }, { expectedInstructionRevision: 1 });
  assert.equal(changed.instructionRevision, 2);
  assert.throws(() => db.updateTicket(ticket.id, { target: 'lost update' }, { expectedInstructionRevision: 1 }), { code: 'INSTRUCTION_REVISION_CONFLICT' });
  assert.throws(() => db.commitResult(ticket.id, { assignment: { ...active, instructionRevision: 2 }, result: { summary: 'stale' }, uniqueKey: 'stale', now: 1 }), { code: 'INSTRUCTION_REVISION_CONFLICT' });
  assert.throws(() => db.commitResult(ticket.id, { result: { summary: 'unversioned' }, uniqueKey: 'unversioned', now: 1 }), { code: 'INSTRUCTION_REVISION_CONFLICT' });
  assert.equal(db.results(ticket.id).length, 0);
  assert.equal(db.deliveries(ticket.id).length, 0);
  assert.equal(db.getTicket(ticket.id).status, 'open');
  assert.deepEqual(db.claimAssignments('next', { validateMandate: () => true, now: 2 }), []);
  assert.equal(db.getAssignment('queued').state, 'blocked');
  assert.equal(db.renewAssignment(active.id, { owner: active.owner, fence: active.fence, validateMandate: () => true, now: 3 }).allowed, false);
  assert.throws(() => db.createAssignment(ticket.id, { instructionRevision: 1 }), { code: 'INSTRUCTION_REVISION_CONFLICT' });
  const next = db.createAssignment(ticket.id, { id: 'new' });
  assert.equal(next.instructionRevision, 2);
  const [claimed] = db.claimAssignments('new-worker', { validateMandate: () => true, now: 4 });
  db.commitResult(ticket.id, { assignment: claimed, result: { summary: 'new requirement met' }, uniqueKey: 'new', now: 5 });
  assert.equal(db.getTicket(ticket.id).status, 'completed');
  assert.equal(db.results(ticket.id)[0].instructionRevision, 2);
  assert.equal(db.commitResult(ticket.id, { assignment: claimed, result: { summary: 'new requirement met' }, uniqueKey: 'new', now: 6 }).duplicate, true);
});

test('existing database migrates Ticket requirements without rewriting legacy Assignments', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('migration'), mode: 'direct' });
  const ticket = db.createTicket({ threadId: 'thread', target: 'preserved', mandate: { acceptance: 'preserved acceptance' } });
  assert.equal(ticket.acceptance, 'preserved acceptance');
  db.createAssignment(ticket.id, { id: 'legacy' });
  const filename = db.path;
  db.close();
  const old = new DatabaseSync(filename);
  old.exec('ALTER TABLE sa_tickets DROP COLUMN instruction_revision; ALTER TABLE sa_tickets DROP COLUMN acceptance');
  old.prepare('UPDATE sa_assignments SET payload=? WHERE id=?').run('{}', 'legacy');
  old.close();
  const reopened = createAssistantOrchestrationStore({ filename });
  try {
    assert.equal(reopened.getTicket(ticket.id).target, 'preserved');
    assert.equal(reopened.getTicket(ticket.id).instructionRevision, 1);
    assert.equal(reopened.getTicket(ticket.id).acceptance, 'preserved acceptance');
    const [assignment] = reopened.claimAssignments('worker', { validateMandate: () => true, now: 0 });
    reopened.commitResult(ticket.id, { assignment, result: { summary: 'legacy complete' }, uniqueKey: 'legacy-result', now: 1 });
    assert.equal(reopened.getTicket(ticket.id).status, 'completed');
  } finally { reopened.close(); }
});

async function savedVerification(t, { stopped = false } = {}) {
  const db = await fixture(t);
  db.ingest({ ...input('recovery'), mode: 'direct' });
  const ticket = db.createTicket({ threadId: 'thread', target: 'work', mandate: {} });
  db.createAssignment(ticket.id, {});
  const [assignment] = db.claimAssignments('original', { validateMandate: () => true, now: 0 });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = db.prepareRun(assignment.id, { ...ownership, sessionId: 'session', directory: '/task', now: 1 });
  db.updateRun(run.id, { ...ownership, state: 'submitted', now: 2 });
  const evidence = { runId: run.id, sessionId: 'session', summary: 'result', transcript: { hash: 'hash', lastSeq: 3 } };
  db.updateRun(run.id, { ...ownership, state: 'verifying', evidence, now: 3 });
  if (stopped) db.confirmExecutionStopped(assignment.id, ownership);
  db.renewAssignment(assignment.id, { ...ownership, validateMandate: () => false, now: 4 });
  const request = { fence: assignment.fence, runId: run.id, observation: { sessionId: 'session', completed: true, ...evidence.transcript }, validateMandate: () => true, now: 5 };
  return { db, ticket, assignment, run, evidence, request };
}

test('cancelling verification uses the original executor release and fences the verifier', async t => {
  const { db, ticket, assignment, run, evidence, request } = await savedVerification(t, { stopped: true });
  db.queueVerification(assignment.id, request);
  const [verifier] = db.claimAssignments('verifier', { validateMandate: () => true, now: 6 });
  db.renewAssignment(verifier.id, { owner: verifier.owner, fence: verifier.fence, validateMandate: () => false, now: 7 });
  db.queueVerification(verifier.id, { ...request, fence: verifier.fence, now: 30005 });
  const [next] = db.claimAssignments('verifier-2', { validateMandate: () => true, now: 30006 });
  db.renewAssignment(next.id, { owner: next.owner, fence: next.fence, validateMandate: () => false, now: 30007 });
  assert.equal(db.cancelTicket(ticket.id).status, 'cancelled');
  assert.equal(db.getAssignment(assignment.id).state, 'cancelled');
  assert.equal(db.runs(assignment.id)[0].state, 'cancelled');
  assert.throws(() => db.commitResult(ticket.id, { assignment: next, result: evidence, uniqueKey: 'late', now: 30008 }), { code: 'FENCING_CONFLICT' });
  assert.equal(db.results(ticket.id).length, 0);
});

test('verification without confirmed original release remains uncertain on cancellation', async t => {
  const { db, ticket, assignment, request } = await savedVerification(t);
  db.queueVerification(assignment.id, request);
  const [verifier] = db.claimAssignments('verifier', { validateMandate: () => true, now: 6 });
  db.renewAssignment(verifier.id, { owner: verifier.owner, fence: verifier.fence, validateMandate: () => false, now: 7 });
  assert.equal(db.cancelTicket(ticket.id).status, 'cancelling');
  assert.equal(db.getAssignment(assignment.id).state, 'uncertain');
});

test('verification-only recovery transfers a fenced lease without creating a second execution', async t => {
  const { db, ticket, assignment, run, evidence, request } = await savedVerification(t);
  assert.throws(() => db.queueVerification(assignment.id, { ...request, validateMandate: () => false }), { code: 'MANDATE_REVOKED' });
  assert.throws(() => db.queueVerification(assignment.id, { ...request, observation: { ...request.observation, hash: 'changed' } }), { code: 'RUN_CONFLICT' });
  db.queueVerification(assignment.id, request);
  const [recovered] = db.claimAssignments('verifier', { validateMandate: () => true, now: 6 });
  assert.equal(recovered.fence, assignment.fence + 1);
  assert.equal(recovered.verificationOnly.runId, run.id);
  const [transferred] = db.runs(assignment.id);
  assert.equal(transferred.executionFence, assignment.fence);
  assert.equal(transferred.executionOwner, 'original');
  assert.equal(transferred.owner, 'verifier');
  assert.throws(() => db.updateRun(run.id, { owner: assignment.owner, fence: assignment.fence, state: 'uncertain', now: 7 }), { code: 'FENCING_CONFLICT' });
  db.commitResult(ticket.id, { assignment: recovered, result: evidence, status: 'waiting', uniqueKey: 'recovered', now: 8 });
  assert.equal(db.runs(assignment.id).length, 1);
  assert.equal(db.runs(assignment.id)[0].state, 'waiting');
  assert.equal(db.getAssignment(assignment.id).state, 'completed');
  assert.equal(db.getTicket(ticket.id).status, 'waiting');
  assert.deepEqual(db.verificationCandidates({ now: 100000 }), []);
});

test('automatic verification backs off across ownership changes without a terminal retry limit', async t => {
  const { db, assignment, request } = await savedVerification(t);
  db.queueVerification(assignment.id, request);
  const [first] = db.claimAssignments('review-1', { validateMandate: () => true, now: 6 });
  db.renewAssignment(first.id, { owner: first.owner, fence: first.fence, validateMandate: () => false, now: 7 });
  assert.equal(db.verificationCandidates({ now: 30004 }).length, 0);
  assert.equal(db.verificationCandidates({ now: 30005 }).length, 1);
  db.queueVerification(first.id, { ...request, fence: first.fence, now: 30005 });
  const [second] = db.claimAssignments('review-2', { validateMandate: () => true, now: 30006 });
  db.renewAssignment(second.id, { owner: second.owner, fence: second.fence, validateMandate: () => false, now: 30007 });
  assert.equal(db.verificationCandidates({ now: 90004 }).length, 0);
  assert.equal(db.verificationCandidates({ now: 90005 }).length, 1);
  assert.throws(() => db.queueVerification(second.id, { ...request, fence: second.fence, now: 90004 }), { code: 'RECOVERY_LIMIT' });
  assert.throws(() => db.queueVerification(second.id, { ...request, fence: second.fence, now: 100000, ownerRetry: true, validateMandate: () => false }), { code: 'MANDATE_REVOKED' });
  assert.throws(() => db.queueVerification(second.id, { ...request, fence: second.fence, now: 100000, ownerRetry: true, observation: { ...request.observation, hash: 'forged' } }), { code: 'RUN_CONFLICT' });
  const queued = db.queueVerification(second.id, { ...request, fence: second.fence, now: 100000, ownerRetry: true });
  assert.equal(queued.state, 'queued');
  assert.equal(queued.verificationOnly.runId, request.runId);
  assert.equal(db.runs(assignment.id).length, 1);
});
test('execution identity persists before submission and expired runs cannot be replayed', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('run-source'), mode: 'direct' });
  const ticket = db.createTicket({ threadId: 'thread', target: 'work', mandate: { scope: ['read'] } });
  const queued = db.createAssignment(ticket.id, { executor: 'harness' });
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true, now: 10, leaseMs: 100 });
  const identity = { owner: 'worker', fence: assignment.fence, sessionId: 'session', directory: '/isolated', now: 11 };
  const run = db.prepareRun(queued.id, identity);
  assert.equal(db.prepareRun(queued.id, identity).id, run.id);
  assert.throws(() => db.prepareRun(queued.id, { ...identity, sessionId: 'other' }), { code: 'RUN_CONFLICT' });
  assert.throws(() => db.updateRun(run.id, { ...identity, state: 'completed' }), { code: 'RUN_TRANSITION' });
  db.updateRun(run.id, { ...identity, state: 'submitted' });
  const reopened = createAssistantOrchestrationStore({ filename: db.path });
  try { assert.equal(reopened.runs(queued.id)[0].state, 'submitted'); } finally { reopened.close(); }
  assert.deepEqual(db.claimAssignments('replacement', { validateMandate: () => true, now: 111 }), []);
  assert.equal(db.runs(queued.id)[0].state, 'uncertain');
  assert.throws(() => db.updateRun(run.id, { ...identity, now: 112, state: 'running' }), { code: 'FENCING_CONFLICT' });
});

test('subscribed context needs a matching execution receipt before result commit', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('initial'), mode: 'direct' });
  const ticket = db.createTicket({ threadId: 'thread', target: 'work', mandate: {} });
  db.subscribe(ticket.id, 'thread');
  db.createAssignment(ticket.id, {});
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true });
  db.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence, sessionId: 'session', directory: '/isolated' });
  const { trigger } = db.ingest({ ...input('followup'), gate: { allowed: false } });
  db.deliverSubscribedMessage(trigger.id, { ticketId: ticket.id });
  const receipt = { owner: assignment.owner, fence: assignment.fence, triggerId: trigger.id, sessionId: 'session', messageId: 'logged-message' };
  assert.throws(() => db.commitResult(ticket.id, { assignment, result: { summary: 'old result' }, uniqueKey: 'result' }), { code: 'UNAPPLIED_CONTEXT' });
  assert.equal(db.results(ticket.id).length, 0);
  assert.throws(() => db.acknowledgeSubscriptionMessage(assignment.id, { ...receipt, sessionId: 'wrong-session' }), { code: 'RUN_CONFLICT' });
  db.acknowledgeSubscriptionMessage(assignment.id, receipt);
  assert.equal(db.acknowledgeSubscriptionMessage(assignment.id, receipt).applied, true);
  assert.equal(db.pendingSubscriptionMessages(ticket.id).length, 0);
  db.commitResult(ticket.id, { assignment, result: { summary: 'current result' }, uniqueKey: 'result' });
  assert.equal(db.getTicket(ticket.id).status, 'completed');
});
test('immutable trigger, single eval, atomic decision ticket and subscribed handback', async t => {
  const db = await fixture(t);
  const first = db.ingest(input('e1'));
  assert.equal(db.ingest(input('e1')).duplicate, true);
  assert.throws(() => db.ingest({ ...input('e1'), content: '变更' }), { code: 'TRIGGER_CONFLICT' });
  const evaluation = db.claimEval('thread', { owner: 'router', policyVersion: 'p1' });
  assert.equal(db.claimEval('thread', { owner: 'other', policyVersion: 'p1' }), null);
  const { ticket, decision } = db.decide(first.candidate.id, { evalId: evaluation.id, owner: 'router', outcome: 'accept', assessment: {}, policyVersion: 'p1', ticket: { target: '检查', mandate: { policyVersion: 'p1', scope: ['read'] } } });
  assert.equal(decision.ticketId, ticket.id);
  assert.equal(db.getEval(evaluation.id).status, 'completed');
  assert.throws(() => db.updateTicket(ticket.id, { mandate: {} }), { code: 'MANDATE_IMMUTABLE' });
  const second = db.ingest({ ...input('e2'), gate: { allowed: false } });
  const delivery = db.deliverSubscribedMessage(second.trigger.id);
  assert.equal(delivery.contextOnly, true);
  assert.equal(db.deliverSubscribedMessage(second.trigger.id).duplicate, true);
  const candidate = db.handback(ticket.id, second.trigger.id, { policyVersion: 'p1' });
  assert.equal(db.handback(ticket.id, second.trigger.id, { policyVersion: 'p1' }).id, candidate.id);
  assert.equal(candidate.gate.strength, 'ignore');
  assert.equal(candidate.gate.allowed, false);
});
test('evaluation timeout retries twice then unavailable and policy invalidates in-flight', async t => {
  const db = await fixture(t);
  const first = db.ingest(input('e1'));
  for (let n = 0; n < 3; n++) {
    db.claimEval('thread', { owner: 'router', policyVersion: 'p1', now: n * 10, timeoutMs: 5 });
    db.requeueExpiredEvals(n * 10 + 5);
  }
  assert.equal(db.candidates().find(c => c.id === first.candidate.id).status, 'unavailable');
  db.ingest(input('e2'));
  const active = db.claimEval('thread', { owner: 'router', policyVersion: 'p1', now: 100, timeoutMs: 10 });
  assert.equal(db.invalidatePolicy('p2'), 1);
  assert.equal(db.getEval(active.id).status, 'invalidated');
  assert.equal(db.claimEval('thread', { owner: 'router', policyVersion: 'p2' }).policyVersion, 'p2');
});
test('mechanical assignment verifies mandate and fences reclaimed work; result creates outbox', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('e1'), mode: 'direct' });
  const ticket = db.createTicket({ threadId: 'thread', target: '检查', mandate: { scope: ['read'] } });
  db.createAssignment(ticket.id, { executor: 'harness' });
  assert.throws(() => db.claimAssignments('w1'), /validation/);
  const [first] = db.claimAssignments('w1', { validateMandate: () => true, now: 0, leaseMs: 5 });
  assert.deepEqual(db.claimAssignments('w2', { validateMandate: () => true, now: 6, leaseMs: 5 }), []);
  assert.equal(db.assignments(ticket.id)[0].state, 'uncertain');
  assert.throws(() => db.reconcileAssignment(first.id, { fence: first.fence, outcome: 'notExecuted' }), /evidence/);
  db.reconcileAssignment(first.id, { fence: first.fence, outcome: 'notExecuted', evidence: 'Harness execution journal confirms no action started', now: 6 });
  const [second] = db.claimAssignments('w2', { validateMandate: () => true, now: 7, leaseMs: 5 });
  assert.throws(() => db.finishAssignment(first.id, { owner: 'w1', fence: first.fence }), { code: 'FENCING_CONFLICT' });
  db.finishAssignment(second.id, { owner: 'w2', fence: second.fence, now: 8 });
  const committed = db.commitResult(ticket.id, { result: { text: '完成' }, uniqueKey: 'result1', outboxPayload: { text: '完成' }, now: 10 });
  assert.equal(db.results(ticket.id).length, 1);
  assert.equal(db.commitResult(ticket.id, { result: { text: '完成' }, uniqueKey: 'result1', outboxPayload: { text: '完成' }, now: 10 }).duplicate, true);
  const [delivery] = db.claimOutbox('sender', { now: 10 });
  assert.equal(delivery.id, committed.outbox.id);
  assert.equal(db.finishOutbox(delivery.id, { owner: 'sender', sent: true, now: 11 }).state, 'sent');
});

test('late assessment cannot commit after timeout and re-claim under the same policy', async t => {
  const db = await fixture(t);
  const { candidate } = db.ingest(input('late'));
  const first = db.claimEval('thread', { owner: 'router', policyVersion: 'p1', now: 0, timeoutMs: 5 });
  const next = db.claimEval('thread', { owner: 'router', policyVersion: 'p1', now: 6, timeoutMs: 20 });
  const decision = { evalId: first.id, owner: 'router', outcome: 'ignore', assessment: {}, policyVersion: 'p1', now: 7 };
  assert.throws(() => db.decide(candidate.id, decision), { code: 'EVAL_FENCING_CONFLICT' });
  assert.equal(db.getDecision(candidate.id), undefined);
  db.decide(candidate.id, { ...decision, evalId: next.id });
  assert.equal(db.getEval(next.id).status, 'completed');
});

test('action boundary renewal rechecks permission and never revives an expired worker', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('renew'), mode: 'direct' });
  const ticket = db.createTicket({ threadId: 'thread', target: '检查', mandate: { scope: ['read'] } });
  db.createAssignment(ticket.id, { executor: 'harness' });
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true, now: 0, leaseMs: 10 });
  const identity = { owner: 'worker', fence: assignment.fence };
  assert.equal(db.renewAssignment(assignment.id, { ...identity, validateMandate: () => true, now: 5, leaseMs: 10 }).assignment.leaseUntil, 15);
  assert.throws(() => db.renewAssignment(assignment.id, { ...identity, validateMandate: () => true, now: 15 }), { code: 'FENCING_CONFLICT' });
  assert.throws(() => db.finishAssignment(assignment.id, { ...identity, now: 15 }), { code: 'FENCING_CONFLICT' });
  const revoked = db.renewAssignment(assignment.id, { ...identity, validateMandate: () => false, now: 6 });
  assert.equal(revoked.allowed, false);
  assert.equal(revoked.assignment.state, 'uncertain');
  assert.deepEqual(db.claimAssignments('replacement', { validateMandate: () => true, now: 20 }), []);
  db.reconcileAssignment(assignment.id, { fence: assignment.fence, outcome: 'completed', evidence: 'Execution receipt confirms completion', now: 21 });
  assert.deepEqual(db.claimAssignments('replacement', { validateMandate: () => true, now: 22 }), []);
});

test('cancellation fences execution and waits for the matching disposal receipt', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('cancel-confirm'), mode: 'direct' });
  const ticket = db.createTicket({ threadId: 'thread', target: 'work', mandate: {} });
  db.createAssignment(ticket.id, { id: 'worker-stop' });
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true });
  const run = db.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence, sessionId: 'session', directory: 'workspace' });
  db.updateRun(run.id, { owner: assignment.owner, fence: assignment.fence, state: 'submitted' });
  assert.equal(db.cancelTicket(ticket.id).status, 'cancelling');
  assert.equal(db.cancelTicket(ticket.id).status, 'cancelling');
  assert.deepEqual(db.claimAssignments('other', { validateMandate: () => true }), []);
  assert.throws(() => db.createAssignment(ticket.id, { id: 'late' }), { code: 'TICKET_CLOSED' });
  assert.throws(() => db.confirmExecutionStopped(assignment.id, { owner: 'other', fence: assignment.fence }), { code: 'FENCING_CONFLICT' });
  assert.throws(() => db.confirmExecutionStopped(assignment.id, { owner: assignment.owner, fence: assignment.fence + 1 }), { code: 'FENCING_CONFLICT' });
  assert.equal(db.confirmExecutionStopped(assignment.id, assignment).status, 'cancelled');
  assert.equal(db.getAssignment(assignment.id).state, 'cancelled');
  assert.equal(db.runs(assignment.id)[0].state, 'cancelled');
});

test('saved pause recovery waits for expired ownership and persists inspection backoff', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('recover-pause'), mode: 'direct' });
  const ticket = db.createTicket({ threadId: 'thread', target: 'work', mandate: {} });
  db.createAssignment(ticket.id, { id: 'recover-pause' });
  const [assignment] = db.claimAssignments('worker', { now: 0, leaseMs: 100, validateMandate: () => true });
  const identity = { owner: assignment.owner, fence: assignment.fence };
  const run = db.prepareRun(assignment.id, { ...identity, now: 1, sessionId: 'saved-session', directory: 'workspace' });
  db.updateRun(run.id, { ...identity, now: 2, state: 'submitted' });
  const evidence = { runId: run.id, sessionId: run.sessionId, waitingPause: true, transcript: { hash: 'hash', lastSeq: 5 }, checkpoint: {} };
  db.updateRun(run.id, { ...identity, now: 3, state: 'verifying', evidence });
  db.pauseTicket(ticket.id);
  assert.equal(db.pauseRecoveryCandidates({ now: 99 }).length, 0);
  const recovery = { fence: assignment.fence, runId: run.id, observation: { paused: true, sessionId: run.sessionId, hash: 'hash', lastSeq: 5 }, now: 99 };
  assert.throws(() => db.recoverParkPause(assignment.id, recovery), { code: 'FENCING_CONFLICT' });
  assert.equal(db.pauseRecoveryCandidates({ now: 100 }).length, 1);
  db.deferPauseRecovery(assignment.id, { fence: assignment.fence, now: 100 });
  assert.equal(db.pauseRecoveryCandidates({ now: 101 }).length, 0);
  const reopened = createAssistantOrchestrationStore({ filename: db.path });
  try { assert.equal(reopened.pauseRecoveryCandidates({ now: 101 }).length, 0); assert.equal(reopened.pauseRecoveryCandidates({ now: 100000 }).length, 1); } finally { reopened.close(); }
  assert.throws(() => db.recoverParkPause(assignment.id, { ...recovery, now: 101, observation: { ...recovery.observation, hash: 'changed' } }), { code: 'PAUSE_CONFLICT' });
  assert.equal(db.recoverParkPause(assignment.id, { ...recovery, now: 101 }).state, 'paused');
  assert.equal(db.getTicket(ticket.id).status, 'paused');
  assert.equal(db.pauseRecoveryCandidates({ now: 100000 }).length, 0);
  assert.equal(db.runs(assignment.id).length, 1);
});

test('inferred rules cannot attach to or stop an existing Ticket', () => {
  for (const outcome of ['attach', 'stop']) {
    const db = createAssistantOrchestrationStore({ filename: ':memory:' });
    try {
      const accepted = db.ingest({ ...input('machine-control'), actor: { kind: 'machine', id: 'ci' }, gate: { allowed: true, strength: 'inferred' } });
      const ticket = db.createTicket({ threadId: 'thread', target: 'Owner work', mandate: {} });
      const lease = db.claimEval('thread', { owner: 'router', policyVersion: 'p1' });
      assert.throws(() => db.decide(accepted.candidate.id, { evalId: lease.id, owner: 'router', policyVersion: 'p1', outcome, ticketId: ticket.id, mode: 'auto', enabledRuleIds: ['rule'], assessment: { ruleIds: ['rule'] } }), { code: 'NOT_EXPLICIT' });
      assert.equal(db.getTicket(ticket.id).status, 'open');
    } finally { db.close(); }
  }
});

test('subscribed handback preserves its original machine gate across reopen and replay', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('head'), mode: 'direct' });
  const ticket = db.createTicket({ threadId: 'thread', target: 'work', mandate: {} });
  db.subscribe(ticket.id, 'thread');
  const event = { ...input('machine-handback'), actor: { id: 'ci', kind: 'machine' }, gate: { allowed: true, strength: 'inferred', reason: 'machine-list' } };
  const accepted = db.ingest(event);
  assert.equal(accepted.candidate, null);
  db.deliverSubscribedMessage(accepted.trigger.id, { ticketId: ticket.id });
  const reopened = createAssistantOrchestrationStore({ filename: db.path });
  try {
    reopened.ingest({ ...event, gate: { allowed: true, strength: 'explicit' } });
    const handback = reopened.handback(ticket.id, accepted.trigger.id, { policyVersion: 'p2' });
    assert.equal(handback.gate.strength, 'inferred');
    assert.equal(handback.gate.originalReason, 'machine-list');
  } finally { reopened.close(); }
});

test('budget pause persists and shared ancestor limits prevent resume until adjusted', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('budget-pause'), mode: 'direct' });
  const ticket = db.createTicket({ threadId: 'thread', target: 'budget work', mandate: {} });
  db.createAssignment(ticket.id, { id: 'budget-work' });
  db.ensureGoalBudget({ goalId: 'parent', budget: { requests: 0 } });
  db.ensureGoalBudget({ goalId: 'child', parentGoalId: 'parent', budget: { requests: 10 } });
  db.bindTicketGoal({ ticketId: ticket.id, goalId: 'child' });
  const reason = { kind: 'budget', goalId: 'parent', reason: 'requests' };
  assert.deepEqual(db.pauseTicket(ticket.id, { reason }).pauseReason, reason);
  const reopened = createAssistantOrchestrationStore({ filename: db.path });
  try {
    assert.deepEqual(reopened.getTicket(ticket.id).pauseReason, reason);
    assert.throws(() => reopened.resumeTicket(ticket.id), error => error.code === 'GOAL_BUDGET_EXHAUSTED' && error.budget.goalId === 'parent');
    assert.equal(reopened.getTicket(ticket.id).status, 'paused');
    assert.equal(reopened.getAssignment('budget-work').state, 'queued');
    reopened.updateGoalBudget({ goalId: 'parent', budget: { requests: 1 }, expectedVersion: 1 });
    assert.equal(reopened.resumeTicket(ticket.id).pauseReason, null);
    assert.equal(reopened.getTicket(ticket.id).status, 'open');
  } finally { reopened.close(); }
});

test('manual pause cannot bypass exhausted budget and rejects malformed reasons', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('manual-budget-pause'), mode: 'direct' });
  const ticket = db.createTicket({ threadId: 'thread', target: 'work', mandate: {} });
  db.ensureGoalBudget({ goalId: 'expired', budget: { deadline: 1 } });
  db.bindTicketGoal({ ticketId: ticket.id, goalId: 'expired' });
  assert.throws(() => db.pauseTicket(ticket.id, { reason: { kind: 'budget' } }), { code: 'INVALID_PAUSE_REASON' });
  assert.deepEqual(db.pauseTicket(ticket.id).pauseReason, { kind: 'manual' });
  assert.throws(() => db.resumeTicket(ticket.id), { code: 'GOAL_BUDGET_EXHAUSTED' });
});

test('execution budget pause recovery retains its original wait after ownership expires', async t => {
  const db = await fixture(t);
  db.createThread({ id: 'budget-recovery-thread', source: { type: 'desktop', id: 'budget-owner' } });
  const ticket = db.createTicket({ threadId: 'budget-recovery-thread', target: 'retain research', mandate: { source: { channel: 'desktop', sessionId: 'budget-owner' } } });
  db.createAssignment(ticket.id, { id: 'budget-recovery-work' });
  const [assignment] = db.claimAssignments('budget-owner', { validateMandate: () => true, now: 0, leaseMs: 10 });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = db.prepareRun(assignment.id, { ...ownership, sessionId: 'budget-original-session', directory: 'budget-original-directory', now: 1 });
  db.updateRun(run.id, { ...ownership, state: 'submitted', now: 2 });
  db.pauseTicket(ticket.id, { reason: { kind: 'execution-budget' } });
  const result = { runId: run.id, sessionId: run.sessionId, waitingPause: true, remainingExecutionMs: 0,
    checkpoint: { manifestHash: 'saved' }, transcript: { hash: 'saved', lastSeq: 8 },
    waitingExecutionBudget: { kind: 'execution-time', effectsVerified: true, unknownCallIds: [],
      terminal: { kind: 'aborted', reason: { kind: 'hook', reason: 'benchgo-execution-budget-exhausted' } } } };
  db.updateRun(run.id, { ...ownership, state: 'verifying', evidence: result, now: 4 });
  db.claimAssignments('replacement', { validateMandate: () => true, now: 11 });
  const recovered = db.recoverParkPause(assignment.id, { fence: assignment.fence, runId: run.id, now: 12,
    observation: { paused: true, sessionId: run.sessionId, hash: 'saved', lastSeq: 8 } });
  assert.equal(recovered.state, 'waiting');
  assert.equal(db.getTicket(ticket.id).status, 'waiting');
  assert.equal(db.getTicket(ticket.id).continuationWait.code, 'EXECUTION_BUDGET_EXHAUSTED');
  assert.equal(db.getTicket(ticket.id).continuationWait.runId, run.id);
  assert.equal(db.getTicket(ticket.id).resultVersion, 0);
  assert.equal(db.deliveries(ticket.id)[0].payload.publication.origin, 'system');
  const resumed = db.queueBudgetContinuation(ticket.id, { expectedResultVersion: 0, additionalExecutionMs: 600000, validateMandate: () => true, now: 13 });
  assert.equal(resumed.queued, true);
  const [continued] = db.claimAssignments('continued-owner', { validateMandate: () => true, now: 14 });
  assert.equal(continued.id, assignment.id);
  assert.equal(continued.pauseContinuation.runId, run.id);
  assert.equal(db.runs(assignment.id).length, 1);
});
