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

test('new and queued Tasks are in progress without pretending to need a user decision', async t => {
  const db = await fixture(t);
  db.createThread({ id: 'queue-thread', source: { type: 'desktop', id: 'owner' } });
  const task = db.createTask({ threadId: 'queue-thread', target: 'task', mandate: {} });
  assert.equal(task.status, 'running');
  db.createAssignment(task.id, { id: 'queued-work' });
  assert.equal(db.getTask(task.id).status, 'running');
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true });
  db.finishAssignment(assignment.id, { owner: assignment.owner, fence: assignment.fence, status: 'queued' });
  assert.equal(db.getTask(task.id).status, 'running');
  assert.equal(db.pauseTask(task.id).status, 'waiting');
  assert.equal(db.resumeTask(task.id).status, 'running');
});

test('known execution failure preserves its first cause and terminates its original run', async t => {
  const db = await fixture(t);
  db.createThread({ id: 'failure-thread', source: { type: 'desktop', id: 'owner' } });
  const task = db.createTask({ threadId: 'failure-thread', target: 'task', mandate: { source: { channel: 'desktop' } } });
  db.createAssignment(task.id, { id: 'failure-work' });
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = db.prepareRun(assignment.id, { ...ownership, sessionId: 'session', directory: 'directory' });
  const effects = { effectsVerified: true, submitted: false };
  db.recordAssignmentFailure(assignment.id, { ...ownership, stage: 'execution', code: 'ROLE_PRESET_UNAVAILABLE', message: 'required model missing', effects });
  db.recordAssignmentFailure(assignment.id, { ...ownership, stage: 'execution', code: 'HTTP', message: 'secondary cleanup failure' });
  db.finishAssignment(assignment.id, { ...ownership, status: 'failed' });
  assert.equal(db.getAssignment(assignment.id).firstFailure.message, 'required model missing');
  assert.equal(db.runs(assignment.id).find(row => row.id === run.id).state, 'failed');
  assert.deepEqual(db.runs(assignment.id)[0].failure.effects, effects);
  assert.equal(db.getTask(task.id).continuationWait.reason, 'required model missing');
  assert.deepEqual(db.claimAssignments('again', { validateMandate: () => true }), []);
});

test('completed and stopped Tasks stay visible until an explicit manual archive choice', async t => {
  const db = await fixture(t);
  db.createThread({ id: 'archive-thread', source: { type: 'desktop', id: 'owner' } });
  for (const status of ['running', 'waiting', 'completed']) db.createTask({ id: status, threadId: 'archive-thread', target: status, status, mandate: {} });
  const stopped = db.createTask({ id: 'stopped', threadId: 'archive-thread', target: 'stopped', mandate: {} });
  db.cancelTask(stopped.id);
  assert.equal(db.listTasks({ archived: false }).length, 4);
  assert.deepEqual(db.listTasks({ archived: true }), []);
  const raw = new DatabaseSync(db.path);
  raw.prepare('INSERT INTO task_meta VALUES (?,?)').run('task-presentation:task:completed', JSON.stringify({ archived: true, archiveRevision: 1 }));
  raw.close();
  assert.deepEqual(db.listTasks({ archived: true }).map(row => row.id), ['completed']);
  assert.equal(db.listTasks({ archived: false }).length, 3);
  assert.equal(db.getTask('completed').archived, true);
  assert.equal(db.getTask('stopped').archived, false);
  assert.throws(() => db.listTasks({ archived: 'false' }), /archive scope/);
});

test('explicit archive scope is applied before paging and never implicitly hides success', async t => {
  const db = await fixture(t);
  db.createThread({ id: 'archive-paging', source: { type: 'desktop', id: 'owner' } });
  for (const [id, status] of [['first', 'waiting'], ['second', 'completed'], ['third', 'completed'], ['fourth', 'completed']]) db.createTask({ id, status, threadId: 'archive-paging', target: id, mandate: {} });
  const raw = new DatabaseSync(db.path);
  for (const id of ['second', 'fourth']) raw.prepare('INSERT INTO task_meta VALUES (?,?)').run(`task-presentation:task:${id}`, JSON.stringify({ archived: true, archiveRevision: 1 }));
  raw.close();
  assert.equal(db.listTasks({ archived: false, newestFirst: true, limit: 1 })[0].id, 'third');
  assert.equal(db.listTasks({ archived: false, newestFirst: true, limit: 1, offset: 1 })[0].id, 'first');
  assert.equal(db.listTasks({ archived: true, newestFirst: true, limit: 1 })[0].id, 'fourth');
  assert.equal(db.listTasks({ archived: true, newestFirst: true, limit: 1, offset: 1 })[0].id, 'second');
});

for (const code of ['WORKER_SELF_CHECK', 'WORKER_TURN_INCOMPLETE', 'WORKER_MODEL_ROUTE', 'ROLE_PRESET_UNAVAILABLE', 'ROLE_MIGRATION_UNAVAILABLE', 'ROLE_CONFIGURATION_CHANGED', 'SESSION_ROLE_OWNERSHIP', 'ROLE_PRIVATE_SECRET']) test(`${code} retains only a controlled cause in the waiting publication`, async t => {
  const db = await fixture(t);
  db.createThread({ id: 'self-check-thread', source: { type: 'desktop', id: 'owner' } });
  const task = db.createTask({ threadId: 'self-check-thread', target: 'finish existing work', mandate: { source: { channel: 'desktop', sessionId: 'owner' } } });
  db.createAssignment(task.id, { id: 'self-check-work' });
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = db.prepareRun(assignment.id, { ...ownership, sessionId: 'self-check-session', directory: 'directory' });
  db.updateRun(run.id, { ...ownership, state: 'submitted' });
  db.recordAssignmentFailure(assignment.id, { ...ownership, stage: 'execution', phase: 'evidence', code });
  const saved = db.getAssignment(assignment.id);
  const expectedCode = code === 'ROLE_PRIVATE_SECRET' ? 'UNAVAILABLE' : code;
  assert.equal(saved.lastFailure.code, expectedCode);
  const raw = new DatabaseSync(db.path, { readOnly: true });
  try {
    const row = raw.prepare('SELECT payload FROM sa_outbox WHERE task_id=?').get(task.id);
    const publication = JSON.parse(row.payload).publication;
    assert.equal(publication.origin, 'system');
    assert.equal(publication.systemState.code, expectedCode);
  } finally { raw.close(); }
  assert.equal(db.getTask(task.id).resultVersion, 0);
  assert.equal(db.getTask(task.id).status, 'waiting');
});

test('pause blocks queued work and resumes the same execution without a file snapshot or replay', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('pause'), mode: 'direct' });
  const task = db.createTask({ threadId: 'thread', target: 'task', mandate: {} });
  db.createAssignment(task.id, { id: 'pause-work' });
  assert.equal(db.pauseTask(task.id).status, 'waiting');
  assert.equal(db.pauseTask(task.id).executionControl.paused, true);
  assert.deepEqual(db.claimAssignments('worker', { validateMandate: () => true, now: 0 }), []);
  assert.equal(db.resumeTask(task.id).status, 'running');
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true, now: 0 });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = db.prepareRun(assignment.id, { ...ownership, sessionId: 'pause-session', directory: 'workspace', now: 1 });
  db.updateRun(run.id, { ...ownership, state: 'submitted', now: 2 });
  assert.equal(db.pauseTask(task.id).status, 'waiting');
  assert.equal(db.pauseTask(task.id).executionControl.pauseRequested, true);
  assert.throws(() => db.resumeTask(task.id), { code: 'PAUSE_PENDING' });
  assert.equal(db.renewAssignment(assignment.id, { ...ownership, validateMandate: () => true, now: 3 }).allowed, true);
  const result = { runId: run.id, sessionId: 'pause-session', waitingPause: true, transcript: { hash: 'saved', lastSeq: 8 }, remainingExecutionMs: 1234 };
  db.updateRun(run.id, { ...ownership, state: 'verifying', evidence: result, now: 4 });
  assert.throws(() => db.parkPause(assignment.id, { ...ownership, result: { ...result, transcript: {} }, now: 5 }), { code: 'RUN_CONFLICT' });
  assert.throws(() => db.parkPause(assignment.id, { ...ownership, result, now: 5 }), { code: 'PAUSE_PENDING' });
  db.confirmExecutionStopped(assignment.id, ownership);
  assert.equal(db.parkPause(assignment.id, { ...ownership, result, now: 5 }).state, 'paused');
  assert.equal(db.getTask(task.id).status, 'waiting');
  assert.equal(db.getTask(task.id).executionControl.paused, true);
  assert.equal(db.results(task.id).length, 0);
  db.resumeTask(task.id);
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
  const queued = db.createTask({ threadId: 'thread', target: 'queued', mandate: {} });
  db.createAssignment(queued.id, { id: 'queued-paused' });
  db.pauseTask(queued.id);
  const running = db.createTask({ threadId: 'thread', target: 'running', mandate: {} });
  db.createAssignment(running.id, { id: 'unknown-paused' });
  db.claimAssignments('worker', { validateMandate: () => true, now: 0, leaseMs: 10 });
  db.pauseTask(running.id);
  const reopened = createAssistantOrchestrationStore({ filename: db.path });
  try {
    assert.equal(reopened.getTask(queued.id).status, 'waiting');
  assert.equal(reopened.getTask(queued.id).executionControl.paused, true);
    assert.deepEqual(reopened.claimAssignments('replacement', { validateMandate: () => true, now: 11 }), []);
    assert.equal(reopened.getAssignment('unknown-paused').state, 'uncertain');
    assert.equal(reopened.pauseTask(running.id).status, 'waiting');
  assert.equal(reopened.pauseTask(running.id).executionControl.pauseRequested, true);
    assert.throws(() => reopened.resumeTask(running.id), { code: 'PAUSE_PENDING' });
    reopened.resumeTask(queued.id);
    assert.equal(reopened.claimAssignments('replacement', { validateMandate: () => true, now: 12 })[0].id, 'queued-paused');
    assert.equal(reopened.cancelTask(running.id).status, 'waiting');
  assert.equal(reopened.cancelTask(running.id).executionControl.stopRequested, true);
    assert.throws(() => reopened.resumeTask(running.id), { code: 'TASK_STOPPED' });
  } finally { reopened.close(); }
});

test('requirement edits fence stale results while preserving leases and queued Assignment identities', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('revision'), mode: 'direct' });
  const task = db.createTask({ threadId: 'thread', target: 'original', acceptance: 'first check', mandate: {} });
  assert.equal(task.instructionRevision, 1);
  db.createAssignment(task.id, { id: 'active' });
  db.createAssignment(task.id, { id: 'queued' });
  const [active] = db.claimAssignments('worker', { validateMandate: () => true, now: 0 });
  assert.equal(active.instructionRevision, 1);
  assert.equal(db.updateTask(task.id, { status: 'waiting' }).instructionRevision, 1);
  assert.equal(db.updateTask(task.id, { target: 'original', status: 'running' }).instructionRevision, 1);
  const changed = db.updateTask(task.id, { acceptance: 'new check' }, { expectedInstructionRevision: 1 });
  assert.equal(changed.instructionRevision, 2);
  assert.throws(() => db.updateTask(task.id, { target: 'lost update' }, { expectedInstructionRevision: 1 }), { code: 'INSTRUCTION_REVISION_CONFLICT' });
  assert.equal(db.commitResult(task.id, { assignment: { ...active, instructionRevision: 2 }, result: { summary: 'stale' }, uniqueKey: 'stale', now: 1 }).result.association.current, false);
  assert.equal(db.commitResult(task.id, { result: { summary: 'unversioned' }, uniqueKey: 'unversioned', now: 1 }).result.association.current, false);
  assert.equal(db.results(task.id).length, 2);
  assert.equal(db.deliveries(task.id).length, 0);
  assert.equal(db.getTask(task.id).status, 'running');
  const [queued] = db.claimAssignments('next', { validateMandate: () => true, now: 2 });
  assert.equal(queued.id, 'queued'); assert.equal(queued.instructionRevision, 2);
  assert.equal(db.renewAssignment(active.id, { owner: active.owner, fence: active.fence, validateMandate: () => true, now: 3 }).allowed, true);
  assert.throws(() => db.createAssignment(task.id, { instructionRevision: 1 }), { code: 'INSTRUCTION_REVISION_CONFLICT' });
  db.commitResult(task.id, { assignment: queued, result: { summary: 'new requirement met', completion: { kind: 'completed' } }, uniqueKey: 'new', now: 5 });
  assert.equal(db.getTask(task.id).status, 'completed');
  assert.equal(db.results(task.id).at(-1).instructionRevision, 2);
  assert.equal(db.commitResult(task.id, { assignment: queued, result: { summary: 'new requirement met', completion: { kind: 'completed' } }, uniqueKey: 'new', now: 6 }).duplicate, true);
});

async function savedUncertainResult(t, { stopped = false } = {}) {
  const db = await fixture(t);
  db.ingest({ ...input('recovery'), mode: 'direct' });
  const task = db.createTask({ threadId: 'thread', target: 'work', mandate: {} });
  db.createAssignment(task.id, {});
  const [assignment] = db.claimAssignments('original', { validateMandate: () => true, now: 0 });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = db.prepareRun(assignment.id, { ...ownership, sessionId: 'session', directory: '/task', now: 1 });
  db.updateRun(run.id, { ...ownership, state: 'submitted', now: 2 });
  const evidence = { runId: run.id, sessionId: 'session', summary: 'result', completion: { kind: 'completed' }, transcript: { hash: 'hash', lastSeq: 3 } };
  db.updateRun(run.id, { ...ownership, state: 'verifying', evidence, now: 3 });
  if (stopped) db.confirmExecutionStopped(assignment.id, ownership);
  db.renewAssignment(assignment.id, { ...ownership, validateMandate: () => false, now: 4 });
  const request = { fence: assignment.fence, runId: run.id, observation: { sessionId: 'session', completed: true, ...evidence.transcript }, validateMandate: () => true, now: 5 };
  return { db, task, assignment, run, evidence, request };
}

test('normal official completion is accepted atomically on the original uncertain Run without another lease', async t => {
  const { db, task, assignment, run, evidence } = await savedUncertainResult(t);
  const options = { assignment: { id: assignment.id, fence: assignment.fence }, runId: run.id,
    result: evidence, uniqueKey: 'recovered', now: 8 };
  assert.equal(db.acceptRecoveredResult(task.id, { ...options, result: { ...evidence, sessionId: 'foreign' } }).result.association.current, false);
  assert.equal(db.results(task.id).length, 1);
  assert.equal(db.getAssignment(assignment.id).state, 'uncertain');
  const accepted = db.acceptRecoveredResult(task.id, { ...options,
    validateMandate: () => assert.fail('Saving an existing result must not re-authorize execution') });
  assert.equal(accepted.duplicate, false);
  assert.equal(db.getTask(task.id).status, 'completed');
  assert.equal(db.getAssignment(assignment.id).state, 'completed');
  assert.equal(db.getAssignment(assignment.id).fence, assignment.fence);
  assert.equal(db.getAssignment(assignment.id).attempts, 1);
  assert.equal(db.runs(assignment.id).length, 1);
  assert.equal(db.runs(assignment.id)[0].state, 'completed');
  assert.equal(db.acceptRecoveredResult(task.id, options).duplicate, true);
  assert.equal(db.results(task.id).length, 2);
  assert.equal(db.deliveries(task.id).length, 0);
  assert.equal(db.pendingResultNotifications({ now: 100000 }).length, 1);
});

test('recovered drafts retain their content without crossing newer execution or stop controls', async t => {
  const { db, task, assignment, run, evidence } = await savedUncertainResult(t, { stopped: true });
  const options = { assignment: { id: assignment.id, fence: assignment.fence + 1 }, runId: run.id,
    result: evidence, uniqueKey: 'recovered', validateMandate: () => true, now: 8 };
  assert.equal(db.acceptRecoveredResult(task.id, options).result.association.current, false);
  db.cancelTask(task.id);
  db.acceptRecoveredResult(task.id, { ...options, assignment });
  assert.equal(db.results(task.id).length, 1);
  assert.equal(db.getTask(task.id).status, 'waiting');
});

test('execution identity persists before submission and expired runs cannot be replayed', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('run-source'), mode: 'direct' });
  const task = db.createTask({ threadId: 'thread', target: 'work', mandate: { scope: ['read'] } });
  const queued = db.createAssignment(task.id, { executor: 'harness' });
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true, now: 10, leaseMs: 100 });
  const identity = { owner: 'worker', fence: assignment.fence, sessionId: 'session', directory: '/artifacts', workingDirectory: '/project', now: 11 };
  const run = db.prepareRun(queued.id, identity);
  assert.equal(db.prepareRun(queued.id, identity).id, run.id);
  assert.throws(() => db.prepareRun(queued.id, { ...identity, sessionId: 'other' }), { code: 'RUN_CONFLICT' });
  assert.throws(() => db.prepareRun(queued.id, { ...identity, workingDirectory: '/other-project' }), { code: 'RUN_CONFLICT' });
  assert.throws(() => db.prepareRun(queued.id, { ...identity, workingDirectory: undefined }), { code: 'RUN_CONFLICT' });
  assert.throws(() => db.updateRun(run.id, { ...identity, state: 'completed' }), { code: 'RUN_TRANSITION' });
  db.updateRun(run.id, { ...identity, state: 'submitted' });
  const reopened = createAssistantOrchestrationStore({ filename: db.path });
  try {
    const saved = reopened.runs(queued.id)[0];
    assert.equal(saved.state, 'submitted');
    assert.equal(saved.workingDirectory, '/project');
    assert.equal(saved.directory, '/artifacts');
  } finally { reopened.close(); }
  assert.deepEqual(db.claimAssignments('replacement', { validateMandate: () => true, now: 111 }), []);
  assert.equal(db.runs(queued.id)[0].state, 'uncertain');
  assert.throws(() => db.updateRun(run.id, { ...identity, now: 112, state: 'running' }), { code: 'FENCING_CONFLICT' });
});

test('subscribed context needs a matching execution receipt before result commit', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('initial'), mode: 'direct' });
  const task = db.createTask({ threadId: 'thread', target: 'work', mandate: {} });
  db.subscribe(task.id, 'thread');
  db.createAssignment(task.id, {});
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true });
  db.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence, sessionId: 'session', directory: '/isolated' });
  const { trigger } = db.ingest({ ...input('followup'), gate: { allowed: false } });
  db.deliverSubscribedMessage(trigger.id, { taskId: task.id });
  const receipt = { owner: assignment.owner, fence: assignment.fence, triggerId: trigger.id, sessionId: 'session', messageId: 'logged-message' };
  db.commitResult(task.id, { assignment, result: { summary: 'old result' }, uniqueKey: 'result' });
  assert.equal(db.results(task.id).length, 1);
  assert.throws(() => db.acknowledgeSubscriptionMessage(assignment.id, { ...receipt, sessionId: 'wrong-session' }), { code: 'RUN_CONFLICT' });
  db.acknowledgeSubscriptionMessage(assignment.id, receipt);
  assert.equal(db.acknowledgeSubscriptionMessage(assignment.id, receipt).applied, true);
  assert.equal(db.pendingSubscriptionMessages(task.id).length, 0);
  db.commitResult(task.id, { assignment, result: { summary: 'current result', completion: { kind: 'completed' } }, uniqueKey: 'result' });
  assert.equal(db.getTask(task.id).status, 'completed');
});
test('immutable trigger, single eval, atomic decision task and subscribed handback', async t => {
  const db = await fixture(t);
  const first = db.ingest(input('e1'));
  assert.equal(db.ingest(input('e1')).duplicate, true);
  assert.throws(() => db.ingest({ ...input('e1'), content: '变更' }), { code: 'TRIGGER_CONFLICT' });
  const evaluation = db.claimEval('thread', { owner: 'router', policyVersion: 'p1' });
  assert.equal(db.claimEval('thread', { owner: 'other', policyVersion: 'p1' }), null);
  const { task, decision } = db.decide(first.candidate.id, { evalId: evaluation.id, owner: 'router', outcome: 'accept', assessment: {}, policyVersion: 'p1', task: { target: '检查', mandate: { policyVersion: 'p1', scope: ['read'] } } });
  assert.equal(decision.taskId, task.id);
  assert.equal(db.getEval(evaluation.id).status, 'completed');
  assert.throws(() => db.updateTask(task.id, { mandate: {} }), { code: 'MANDATE_IMMUTABLE' });
  const second = db.ingest({ ...input('e2'), gate: { allowed: false } });
  const delivery = db.deliverSubscribedMessage(second.trigger.id);
  assert.equal(delivery.contextOnly, true);
  assert.equal(db.deliverSubscribedMessage(second.trigger.id).duplicate, true);
  const candidate = db.handback(task.id, second.trigger.id, { policyVersion: 'p1' });
  assert.equal(db.handback(task.id, second.trigger.id, { policyVersion: 'p1' }).id, candidate.id);
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
test('mechanical assignment verifies mandate and fences reclaimed work; result creates a durable notification', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('e1'), mode: 'direct' });
  const task = db.createTask({ threadId: 'thread', target: '检查', mandate: { scope: ['read'] } });
  db.createAssignment(task.id, { executor: 'harness' });
  assert.throws(() => db.claimAssignments('w1'), /validation/);
  const [first] = db.claimAssignments('w1', { validateMandate: () => true, now: 0, leaseMs: 5 });
  assert.deepEqual(db.claimAssignments('w2', { validateMandate: () => true, now: 6, leaseMs: 5 }), []);
  assert.equal(db.assignments(task.id)[0].state, 'uncertain');
  assert.throws(() => db.reconcileAssignment(first.id, { fence: first.fence, outcome: 'notExecuted' }), /evidence/);
  db.reconcileAssignment(first.id, { fence: first.fence, outcome: 'notExecuted', evidence: 'Harness execution journal confirms no action started', now: 6 });
  const [second] = db.claimAssignments('w2', { validateMandate: () => true, now: 7, leaseMs: 5 });
  assert.throws(() => db.finishAssignment(first.id, { owner: 'w1', fence: first.fence }), { code: 'FENCING_CONFLICT' });
  db.finishAssignment(second.id, { owner: 'w2', fence: second.fence, now: 8 });
  db.createAssignment(task.id, {});
  const [owned] = db.claimAssignments('worker', { validateMandate: () => true, now: 1 });
  const committed = db.commitResult(task.id, { assignment: owned, result: { completion: { kind: 'completed' }, text: '完成' }, uniqueKey: 'result1', outboxPayload: { text: '完成' }, now: 10 });
  assert.equal(db.results(task.id).length, 1);
  assert.equal(db.commitResult(task.id, { assignment: owned, result: { completion: { kind: 'completed' }, text: '完成' }, uniqueKey: 'result1', outboxPayload: { text: '完成' }, now: 10 }).duplicate, true);
  assert.equal(committed.outbox, null);
  const [notice] = db.pendingResultNotifications({ now: 10 });
  assert.equal(notice.uniqueKey, 'result1');
  db.finishResultNotification(task.id, notice.uniqueKey, { status: 'accepted', messageId: 'inbox', now: 11 });
  assert.deepEqual(db.pendingResultNotifications({ now: 12 }), []);
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
  const task = db.createTask({ threadId: 'thread', target: '检查', mandate: { scope: ['read'] } });
  db.createAssignment(task.id, { executor: 'harness' });
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
  const task = db.createTask({ threadId: 'thread', target: 'work', mandate: {} });
  db.createAssignment(task.id, { id: 'worker-stop' });
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true });
  const run = db.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence, sessionId: 'session', directory: 'workspace' });
  db.updateRun(run.id, { owner: assignment.owner, fence: assignment.fence, state: 'submitted' });
  assert.equal(db.cancelTask(task.id).status, 'waiting');
  assert.equal(db.cancelTask(task.id).executionControl.stopRequested, true);
  assert.equal(db.cancelTask(task.id).status, 'waiting');
  assert.equal(db.cancelTask(task.id).executionControl.stopRequested, true);
  assert.deepEqual(db.claimAssignments('other', { validateMandate: () => true }), []);
  assert.throws(() => db.createAssignment(task.id, { id: 'late' }), { code: 'TASK_CLOSED' });
  assert.throws(() => db.confirmExecutionStopped(assignment.id, { owner: 'other', fence: assignment.fence }), { code: 'FENCING_CONFLICT' });
  assert.throws(() => db.confirmExecutionStopped(assignment.id, { owner: assignment.owner, fence: assignment.fence + 1 }), { code: 'FENCING_CONFLICT' });
  assert.equal(db.confirmExecutionStopped(assignment.id, assignment).status, 'waiting');
  assert.equal(db.confirmExecutionStopped(assignment.id, assignment).executionControl.stopped, true);
  assert.equal(db.getAssignment(assignment.id).state, 'cancelled');
  assert.equal(db.runs(assignment.id)[0].state, 'cancelled');
});

test('saved pause recovery waits for expired ownership and persists inspection backoff', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('recover-pause'), mode: 'direct' });
  const task = db.createTask({ threadId: 'thread', target: 'work', mandate: {} });
  db.createAssignment(task.id, { id: 'recover-pause' });
  const [assignment] = db.claimAssignments('worker', { now: 0, leaseMs: 100, validateMandate: () => true });
  const identity = { owner: assignment.owner, fence: assignment.fence };
  const run = db.prepareRun(assignment.id, { ...identity, now: 1, sessionId: 'saved-session', directory: 'workspace' });
  db.updateRun(run.id, { ...identity, now: 2, state: 'submitted' });
  const evidence = { runId: run.id, sessionId: run.sessionId, waitingPause: true, transcript: { hash: 'hash', lastSeq: 5 } };
  db.updateRun(run.id, { ...identity, now: 3, state: 'verifying', evidence });
  db.pauseTask(task.id);
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
  assert.equal(db.getTask(task.id).status, 'waiting');
  assert.equal(db.getTask(task.id).executionControl.paused, true);
  assert.equal(db.pauseRecoveryCandidates({ now: 100000 }).length, 0);
  assert.equal(db.runs(assignment.id).length, 1);
});

test('inferred rules cannot attach to or stop an existing Task', () => {
  for (const outcome of ['attach', 'stop']) {
    const db = createAssistantOrchestrationStore({ filename: ':memory:' });
    try {
      const accepted = db.ingest({ ...input('machine-control'), actor: { kind: 'machine', id: 'ci' }, gate: { allowed: true, strength: 'inferred' } });
      const task = db.createTask({ threadId: 'thread', target: 'Owner work', mandate: {} });
      const lease = db.claimEval('thread', { owner: 'router', policyVersion: 'p1' });
      assert.throws(() => db.decide(accepted.candidate.id, { evalId: lease.id, owner: 'router', policyVersion: 'p1', outcome, taskId: task.id, mode: 'auto', enabledRuleIds: ['rule'], assessment: { ruleIds: ['rule'] } }), { code: 'NOT_EXPLICIT' });
      assert.equal(db.getTask(task.id).status, 'running');
    } finally { db.close(); }
  }
});

test('subscribed handback preserves its original machine gate across reopen and replay', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('head'), mode: 'direct' });
  const task = db.createTask({ threadId: 'thread', target: 'work', mandate: {} });
  db.subscribe(task.id, 'thread');
  const event = { ...input('machine-handback'), actor: { id: 'ci', kind: 'machine' }, gate: { allowed: true, strength: 'inferred', reason: 'machine-list' } };
  const accepted = db.ingest(event);
  assert.equal(accepted.candidate, null);
  db.deliverSubscribedMessage(accepted.trigger.id, { taskId: task.id });
  const reopened = createAssistantOrchestrationStore({ filename: db.path });
  try {
    reopened.ingest({ ...event, gate: { allowed: true, strength: 'explicit' } });
    const handback = reopened.handback(task.id, accepted.trigger.id, { policyVersion: 'p2' });
    assert.equal(handback.gate.strength, 'inferred');
    assert.equal(handback.gate.originalReason, 'machine-list');
  } finally { reopened.close(); }
});
