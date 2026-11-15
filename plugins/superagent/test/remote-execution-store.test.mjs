import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';

const execution = { deviceId: 'device-b', hostId: 'host-b', authorizationId: 'grant-b',
  config: { harness: 'official', models: [{ providerId: 'provider:opaque', modelId: 'model:opaque' }] } };
const model = execution.config.models[0];
function human(database, text, key) {
  const source = { channel: 'desktop', sessionId: 'owner-session', threadId: 'owner-thread', messageId: key };
  const { trigger } = database.ingest({ dedupeKey: key, thread: { id: 'thread', source: { type: 'desktop', id: 'thread' } },
    source, actor: { kind: 'human', id: 'owner' }, content: text, mode: 'direct' });
  return { trigger, mandate: { source, actorId: 'owner', instruction: text, policyVersion: 'current',
    admission: 'desktop-approved-delegation', execution: structuredClone(execution) } };
}
function fixture(t, { filename = ':memory:' } = {}) {
  const database = createAssistantOrchestrationStore({ filename, ownerHostId: 'host-a' });
  t.after(() => database.close());
  const input = human(database, 'work', 'initial');
  const task = database.acceptDesktop({ triggerId: input.trigger.id, requestKey: 'initial', fingerprint: 'initial',
    target: 'work', acceptance: 'verified', mandate: input.mandate, model });
  const now = Date.now();
  const [assignment] = database.claimAssignments('worker', { now, leaseMs: 1000, validateMandate: () => true });
  const claim = { owner: 'worker', fence: assignment.fence, now };
  const run = database.prepareRun(assignment.id, { ...claim, sessionId: 'b-session', directory: 'b-project' });
  const remote = database.recordRemoteExecution(assignment.id, { ...claim,
    patch: { runId: run.id, executionId: 'b-execution', sessionId: run.sessionId,
      deviceId: execution.deviceId, hostId: execution.hostId, authorizationId: execution.authorizationId } });
  return { database, task, assignment, run, remote, now, claim };
}

test('business storage has one durable owner host and rejects rebinding', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-owner-host-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = createAssistantOrchestrationStore({ directory });
  const owner = first.ownerHostId();
  assert.ok(owner);
  first.close();
  const second = createAssistantOrchestrationStore({ directory, ownerHostId: owner });
  assert.equal(second.ownerHostId(), owner);
  second.close();
  assert.throws(() => createAssistantOrchestrationStore({ directory, ownerHostId: 'another-host' }), { code: 'OWNER_HOST_CONFLICT' });
});

test('remote execution remains one ordinary host Task and frozen Assignment', t => {
  const { database, task, assignment, remote } = fixture(t);
  assert.equal(task.ownerHostId, 'host-a');
  assert.equal(database.listTasks().length, 1);
  assert.equal(database.assignments(task.id).length, 1);
  assert.equal(assignment.executor, 'remote');
  assert.deepEqual(assignment.execution, execution);
  assert.equal(database.getAssignment(assignment.id).remoteExecution.executionId, remote.executionId);
  assert.equal(database.remoteExecutionBySession('b-session').assignmentId, assignment.id);
  assert.equal(database.remoteExecutionBySession('unknown'), undefined);
});

test('remote identity, session binding, fence and observation cursor cannot change', t => {
  const { database, assignment, claim } = fixture(t);
  database.recordRemoteExecution(assignment.id, { ...claim, patch: { cursor: 3, phase: 'running' } });
  assert.throws(() => database.recordRemoteExecution(assignment.id, { ...claim, patch: { cursor: 2 } }), { code: 'REMOTE_OBSERVATION_CONFLICT' });
  assert.throws(() => database.recordRemoteExecution(assignment.id, { ...claim, patch: { hostId: 'other' } }), { code: 'REMOTE_EXECUTION_CONFLICT' });
  assert.throws(() => database.recordRemoteExecution(assignment.id, { ...claim, patch: { sessionId: 'new-session' } }), { code: 'REMOTE_EXECUTION_CONFLICT' });
  assert.throws(() => database.recordRemoteExecution(assignment.id, { ...claim, fence: claim.fence + 1, patch: { phase: 'running' } }), { code: 'FENCING_CONFLICT' });
  assert.equal(database.remoteExecution(assignment.id).cursor, 3);
});

test('parking frees the worker lease and a new observer keeps the exact execution', t => {
  const { database, task, assignment, run, now, claim } = fixture(t);
  database.updateRun(run.id, { ...claim, state: 'submitted' });
  const parked = database.parkRemoteAssignment(assignment.id, { ...claim, phase: 'submitted', nextAt: now + 200 });
  assert.equal(parked.state, 'uncertain');
  assert.equal(parked.owner, null);
  assert.equal(database.remoteExecutionCandidates({ now: now + 199 }).length, 0);
  assert.equal(database.remoteExecutionCandidates({ now: now + 200, limit: 1 })[0].run.id, run.id);
  assert.equal(database.claimAssignments('ordinary-worker', { now: now + 200, validateMandate: () => true }).length, 0);
  const resumed = database.claimRemoteAssignment(assignment.id, { owner: 'observer', fence: assignment.fence, now: now + 200 });
  assert.equal(resumed.fence, assignment.fence);
  assert.equal(resumed.attempts, 1);
  assert.equal(database.runs(assignment.id)[0].owner, 'observer');
  assert.equal(database.runs(assignment.id)[0].id, run.id);
  assert.equal(database.runs(assignment.id)[0].sessionId, run.sessionId);
  assert.equal(database.listTasks().filter(row => row.id === task.id).length, 1);
  assert.equal(database.remoteExecutionCandidates({ now: now + 200 }).length, 0);
  assert.throws(() => database.claimRemoteAssignment(assignment.id, { owner: 'rival', fence: assignment.fence, now: now + 200 }), { code: 'FENCING_CONFLICT' });
});

test('expired observation leases recover from authenticated facts without resubmission', t => {
  const { database, assignment, run, now, claim } = fixture(t);
  database.updateRun(run.id, { ...claim, state: 'submitted' });
  database.claimAssignments('ordinary-worker', { now: now + 1001, validateMandate: () => true });
  assert.equal(database.runs(assignment.id)[0].state, 'uncertain');
  database.claimRemoteAssignment(assignment.id, { owner: 'observer', fence: assignment.fence, now: now + 1001 });
  const observed = database.observeRemoteRun(assignment.id, { owner: 'observer', fence: assignment.fence,
    executionId: 'b-execution', sessionId: run.sessionId, cursor: 4, state: 'running', evidence: { status: 'running' }, now: now + 1002 });
  assert.equal(observed.state, 'running');
  assert.equal(database.getAssignment(assignment.id).attempts, 1);
  assert.throws(() => database.observeRemoteRun(assignment.id, { owner: 'observer', fence: assignment.fence,
    executionId: 'other', sessionId: run.sessionId, cursor: 5, state: 'running', evidence: {}, now: now + 1003 }), { code: 'REMOTE_OBSERVATION_CONFLICT' });
});

test('revocation and cancel preserve observation until B confirms execution stopped', t => {
  const { database, task, assignment, run, now, claim } = fixture(t);
  assert.throws(() => database.confirmExecutionStopped(assignment.id, claim), { code: 'REMOTE_STOP_UNCONFIRMED' });
  const renewal = database.renewAssignment(assignment.id, { ...claim, validateMandate: () => false });
  assert.equal(renewal.allowed, true);
  assert.equal(renewal.controlRequired, true);
  assert.equal(renewal.assignment.authorizationRevoked, true);
  const cancelling = database.cancelTask(task.id);
  assert.equal(cancelling.executionControl.stopRequested, true);
  assert.equal(cancelling.executionControl.stopped, false);
  assert.equal(database.getAssignment(assignment.id).owner, 'worker');
  database.observeRemoteRun(assignment.id, { ...claim, executionId: 'b-execution', sessionId: run.sessionId,
    cursor: 1, state: 'cancelled', evidence: { cancelled: true }, now: now + 1 });
  database.confirmExecutionStopped(assignment.id, claim);
  assert.equal(database.getTask(task.id).executionControl.stopped, true);
  assert.equal(database.getAssignment(assignment.id).state, 'cancelled');
});

test('remote command requests and receipts are immutable, durable and bounded', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-remote-command-'));
  const { database, assignment, claim } = fixture(t, { filename: join(directory, 'assistant.db') });
  const request = { ...claim, requestId: 'stable-input', operation: 'input', payload: { text: 'one', instructionRevision: 2 } };
  assert.equal(database.recordRemoteCommand(assignment.id, request).state, 'pending');
  assert.equal(database.recordRemoteCommand(assignment.id, { ...request, payload: { instructionRevision: 2, text: 'one' } }).requestId, request.requestId);
  assert.throws(() => database.recordRemoteCommand(assignment.id, { ...request, payload: { text: 'two' } }), { code: 'IDEMPOTENCY_CONFLICT' });
  database.finishRemoteCommand(assignment.id, { ...claim, requestId: request.requestId, receipt: { instructionRevision: 2, accepted: true } });
  assert.throws(() => database.finishRemoteCommand(assignment.id, { ...claim, requestId: request.requestId, receipt: { accepted: false } }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(database.remoteCommands(assignment.id, { state: 'pending' }).length, 0);
  database.close();
  const reopened = createAssistantOrchestrationStore({ directory, ownerHostId: 'host-a' });
  t.after(() => reopened.close());
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(reopened.remoteCommands(assignment.id, { limit: 1 })[0].receipt.instructionRevision, 2);
});

test('a terminal remote fact remains recoverable until A settles the Assignment', t => {
  const { database, assignment, run, claim, now } = fixture(t);
  database.observeRemoteRun(assignment.id, { ...claim, executionId: 'b-execution', sessionId: run.sessionId,
    cursor: 1, state: 'completed', evidence: { summary: 'done' } });
  database.parkRemoteAssignment(assignment.id, { ...claim, nextAt: now + 1 });
  assert.equal(database.remoteExecutionCandidates({ now: now + 1 })[0].remote.phase, 'completed');
  database.claimRemoteAssignment(assignment.id, { owner: 'observer', fence: assignment.fence, now: now + 1 });
  database.finishAssignment(assignment.id, { owner: 'observer', fence: assignment.fence, now: now + 2 });
  assert.equal(database.remoteExecutionCandidates({ now: now + 100000 }).length, 0);
});

test('exact command reads are independent of bounded history pages', t => {
  const { database, assignment, claim } = fixture(t);
  database.recordRemoteCommand(assignment.id, { ...claim, requestId: 'submit', operation: 'submit', payload: { text: 'work' } });
  database.recordRemoteCommand(assignment.id, { ...claim, requestId: 'pause', operation: 'pause' });
  for (let index = 0; index < 105; index++) database.recordRemoteCommand(assignment.id,
    { ...claim, requestId: `input-${index}`, operation: 'input', payload: { text: `context-${index}` } });
  database.recordRemoteCommand(assignment.id, { ...claim, requestId: 'resume', operation: 'resume' });
  assert.equal(database.remoteCommands(assignment.id).length, 100);
  assert.equal(database.remoteCommand(assignment.id, 'input-104').payload.text, 'context-104');
  assert.equal(database.remoteSubmitCommand(assignment.id).requestId, 'submit');
  assert.equal(database.remoteControlCommand(assignment.id).requestId, 'resume');
  assert.equal(database.remoteCommands(assignment.id, { operation: 'input', newestFirst: true, limit: 1 })[0].requestId, 'input-104');
  assert.throws(() => database.recordRemoteCommand(assignment.id,
    { ...claim, requestId: 'another-submit', operation: 'submit', payload: { text: 'work' } }), { code: 'REMOTE_SUBMIT_CONFLICT' });
});

test('authenticated pause and resume keep the original Run and fence', t => {
  const { database, task, assignment, run, claim, now } = fixture(t);
  database.pauseTask(task.id);
  const evidence = { waitingPause: true, runId: run.id, transcript: { hash: 'hash', lastSeq: 1 } };
  database.observeRemoteRun(assignment.id, { ...claim, executionId: 'b-execution', sessionId: run.sessionId,
    cursor: 1, state: 'paused', evidence });
  database.confirmExecutionStopped(assignment.id, claim);
  database.parkPause(assignment.id, { ...claim, result: evidence });
  assert.equal(database.getTask(task.id).executionControl.paused, true);
  database.resumeTask(task.id);
  assert.equal(database.getAssignment(assignment.id).state, 'uncertain');
  database.claimRemoteAssignment(assignment.id, { owner: 'observer', fence: assignment.fence, now: now + 1 });
  // Event ingestion may persist the new cursor before its response snapshot.
  database.recordRemoteExecution(assignment.id, { owner: 'observer', fence: assignment.fence, patch: { cursor: 2 }, now: now + 2 });
  database.observeRemoteRun(assignment.id, { owner: 'observer', fence: assignment.fence, executionId: 'b-execution',
    sessionId: run.sessionId, cursor: 2, state: 'running', evidence: { running: true }, now: now + 2 });
  assert.equal(database.runs(assignment.id)[0].id, run.id);
  assert.equal(database.runs(assignment.id)[0].state, 'running');
  assert.equal(database.getAssignment(assignment.id).fence, assignment.fence);
});

test('a remote question is still active and cannot confirm executor stop', t => {
  const { database, assignment, run, claim } = fixture(t);
  database.observeRemoteRun(assignment.id, { ...claim, executionId: 'b-execution', sessionId: run.sessionId,
    cursor: 1, state: 'waiting', evidence: { questionId: 'question' } });
  assert.throws(() => database.confirmExecutionStopped(assignment.id, claim), { code: 'REMOTE_STOP_UNCONFIRMED' });
});

test('revision acknowledgements apply only B confirmed version while A has newer input', t => {
  const { database, task, assignment, run, claim } = fixture(t);
  for (const revision of [2, 3]) {
    const input = human(database, `instruction-${revision}`, `revision-${revision}`);
    database.changeTask(task.id, { operation: 'revise', expectedInstructionRevision: revision - 1,
      target: `work-${revision}`, acceptance: `verified-${revision}`, reason: 'owner revision',
      requestKey: `revision-${revision}`, triggerId: input.trigger.id, mandate: input.mandate, model, validateMandate: () => true });
  }
  const request = { ...claim, requestId: 'version-2', operation: 'input', payload: { instructionRevision: 2, text: 'work-2' } };
  database.recordRemoteCommand(assignment.id, request);
  database.finishRemoteCommand(assignment.id, { ...claim, requestId: request.requestId, receipt: { instructionRevision: 2 } });
  const snapshot = database.acknowledgeRemoteRevision(assignment.id, { ...claim, runId: run.id,
    executionId: 'b-execution', requestId: request.requestId, instructionRevision: 2, boundaryId: 'version-2' });
  assert.equal(snapshot.instructionRevision, 2);
  assert.equal(snapshot.target, 'work-2');
  assert.equal(database.getTask(task.id).instructionRevision, 3);
  assert.equal(database.getAssignment(assignment.id).instructionRevision, 2);
  assert.equal(database.pendingTaskInputs(task.id).find(input => input.instructionRevision === 3).state, 'pending');
  assert.equal(database.taskInputs(task.id).find(input => input.instructionRevision === 2).state, 'applied');
  assert.throws(() => database.acknowledgeRemoteRevision(assignment.id, { ...claim, runId: run.id,
    executionId: 'b-execution', requestId: request.requestId, instructionRevision: 3, boundaryId: 'wrong' }), { code: 'REMOTE_REVISION_CONFLICT' });
});

test('saving an old remote result retains a blocker and never queues a local continuation', t => {
  const { database, task, assignment, run, claim } = fixture(t);
  const input = human(database, 'new owner instruction', 'new-revision');
  database.changeTask(task.id, { operation: 'revise', expectedInstructionRevision: 1,
    target: 'new work', acceptance: 'new verification', reason: 'owner revision', requestKey: 'new-revision',
    triggerId: input.trigger.id, mandate: input.mandate, model, validateMandate: () => true });
  const result = { runId: run.id, sessionId: run.sessionId, instructionRevision: 1, summary: 'old work complete',
    transcript: { hash: 'old-transcript', lastSeq: 2 }, completion: { kind: 'completed', at: new Date().toISOString() } };
  database.observeRemoteRun(assignment.id, { ...claim, executionId: 'b-execution', sessionId: run.sessionId,
    cursor: 1, state: 'completed', evidence: result });
  const saved = database.commitResult(task.id, { assignment, result, uniqueKey: 'old-remote-result' });
  assert.equal(saved.result.association.current, false);
  assert.equal(database.results(task.id)[0].summary, 'old work complete');
  assert.equal(database.getTask(task.id).status, 'waiting');
  assert.equal(database.getTask(task.id).continuationWait.code, 'REMOTE_INPUT_NOT_APPLIED');
  assert.notEqual(database.getAssignment(assignment.id).state, 'queued');
  assert.equal(database.getAssignment(assignment.id).contextContinuation, undefined);
  assert.equal(database.claimAssignments('local', { validateMandate: () => true }).length, 0);
});

test('unapplied remote context and answers prevent silent completion at the closing boundary', t => {
  for (const kind of ['context', 'answer']) {
    const { database, task, assignment, run, claim } = fixture(t);
    const input = human(database, `${kind} arrived during completion`, `late-${kind}`);
    database.recordTaskInput({ taskId: task.id, triggerId: input.trigger.id, kind, idempotencyKey: `late-${kind}` });
    const result = { runId: run.id, sessionId: run.sessionId, instructionRevision: 1, summary: 'original execution complete',
      transcript: { hash: 'transcript', lastSeq: 2 }, completion: { kind: 'completed', at: new Date().toISOString() } };
    database.observeRemoteRun(assignment.id, { ...claim, executionId: 'b-execution', sessionId: run.sessionId,
      cursor: 1, state: 'completed', evidence: result });
    const saved = database.commitResult(task.id, { assignment, result, uniqueKey: `pending-${kind}` });
    assert.equal(saved.result.association.current, false, kind);
    assert.ok(saved.result.association.diagnostics.includes('PENDING_INPUT'), kind);
    assert.equal(database.getTask(task.id).status, 'waiting', kind);
    assert.equal(database.getTask(task.id).continuationWait.code, 'REMOTE_INPUT_NOT_APPLIED', kind);
    assert.notEqual(database.getAssignment(assignment.id).state, 'queued', kind);
    assert.equal(database.pendingTaskInputs(task.id)[0].kind, kind);
    assert.equal(database.results(task.id)[0].summary, result.summary);
  }
});

test('a paginated remote question opens against its authenticated waiting snapshot', t => {
  const { database, task, assignment, run, claim } = fixture(t);
  database.observeRemoteRun(assignment.id, { ...claim, executionId: 'b-execution', sessionId: run.sessionId,
    cursor: 1, state: 'waiting', evidence: { sessionId: run.sessionId, questionId: 'question' } });
  assert.equal(database.runs(assignment.id)[0].state, 'verifying');
  const questions = [{ id: 'q1', question: 'Choose a deployment region' }];
  const opened = database.openAttention(assignment.id, { ...claim, sessionId: run.sessionId, callId: 'ask-1', questions });
  assert.equal(opened.length, 1);
  assert.equal(database.attentions(task.id)[0].sessionId, run.sessionId);
  assert.equal(database.runs(assignment.id)[0].state, 'verifying');
  assert.equal(database.remoteExecution(assignment.id).phase, 'waiting');
  assert.throws(() => database.openAttention(assignment.id,
    { ...claim, sessionId: 'another-session', callId: 'ask-2', questions }), /executing session/);
  database.observeRemoteRun(assignment.id, { ...claim, executionId: 'b-execution', sessionId: run.sessionId,
    cursor: 2, state: 'paused', evidence: { waitingPause: true } });
  assert.throws(() => database.openAttention(assignment.id,
    { ...claim, sessionId: run.sessionId, callId: 'ask-2', questions }), /executing session/);
});

test('a local verifying Run cannot use the remote waiting Attention exception', t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  const input = human(database, 'local work', 'local');
  delete input.mandate.execution;
  const task = database.acceptDesktop({ triggerId: input.trigger.id, requestKey: 'local', fingerprint: 'local',
    target: 'local work', mandate: input.mandate, model });
  const now = Date.now();
  const [assignment] = database.claimAssignments('local-worker', { now, validateMandate: () => true });
  const claim = { owner: assignment.owner, fence: assignment.fence, now };
  const run = database.prepareRun(assignment.id, { ...claim, sessionId: 'local-session', directory: 'local-dir' });
  database.updateRun(run.id, { ...claim, state: 'submitted' });
  database.updateRun(run.id, { ...claim, state: 'verifying', evidence: {} });
  assert.throws(() => database.openAttention(assignment.id, { ...claim, sessionId: run.sessionId, callId: 'ask',
    questions: [{ id: 'q', question: 'Proceed?' }] }), /executing session/);
  assert.equal(database.attentions(task.id).length, 0);
});

test('remote fact persistence wakes the existing execution journal with no private body', async t => {
  const { database, assignment, claim } = fixture(t);
  const before = database.executionFactCursor();
  const observed = [];
  database.onExecutionFacts(cursor => observed.push(cursor));
  database.recordRemoteExecution(assignment.id, { ...claim, patch: { phase: 'running', cursor: 1 } });
  await new Promise(resolve => queueMicrotask(resolve));
  assert.ok(database.executionFactCursor() > before);
  assert.equal(observed.length, 1);
  const events = database.executionEvidence({ taskId: assignment.taskId, after: before }).entries;
  assert.ok(events.some(row => row.kind === 'remote-execution'));
  assert.ok(events.every(row => !JSON.stringify(row.data).includes('provider:opaque')));
});
