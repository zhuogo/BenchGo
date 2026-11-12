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

test('new and queued Tickets are in progress without pretending to need a user decision', async t => {
  const db = await fixture(t);
  db.createThread({ id: 'queue-thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = db.createTicket({ threadId: 'queue-thread', target: 'task', mandate: {} });
  assert.equal(ticket.status, 'running');
  db.createAssignment(ticket.id, { id: 'queued-work' });
  assert.equal(db.getTicket(ticket.id).status, 'running');
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true });
  db.finishAssignment(assignment.id, { owner: assignment.owner, fence: assignment.fence, status: 'queued' });
  assert.equal(db.getTicket(ticket.id).status, 'running');
  assert.equal(db.pauseTicket(ticket.id).status, 'waiting');
  assert.equal(db.resumeTicket(ticket.id).status, 'running');
});

test('upgrading old queued Tickets preserves real blockers and explicit pause', async t => {
  const db = await fixture(t);
  db.createThread({ id: 'legacy-queue', source: { type: 'desktop', id: 'owner' } });
  for (const id of ['queued', 'paused', 'blocked']) {
    db.createTicket({ id, threadId: 'legacy-queue', target: id, mandate: {} });
    db.createAssignment(id, { id: `${id}-work` });
  }
  db.pauseTicket('paused');
  const raw = new DatabaseSync(db.path);
  raw.prepare("UPDATE sa_tickets SET status='waiting'").run();
  raw.prepare("UPDATE sa_assignments SET state='blocked' WHERE id='blocked-work'").run();
  raw.prepare("DELETE FROM sa_migrations WHERE id='queued-ticket-running-v1'").run();
  raw.close();
  const reopened = createAssistantOrchestrationStore({ filename: db.path });
  try {
    assert.equal(reopened.getTicket('queued').status, 'running');
    assert.equal(reopened.getTicket('paused').status, 'waiting');
    assert.equal(reopened.getTicket('blocked').status, 'waiting');
  } finally { reopened.close(); }
});

test('known execution failure preserves its first cause and terminates its original run', async t => {
  const db = await fixture(t);
  db.createThread({ id: 'failure-thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = db.createTicket({ threadId: 'failure-thread', target: 'task', mandate: { source: { channel: 'desktop' } } });
  db.createAssignment(ticket.id, { id: 'failure-work' });
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
  assert.equal(db.getTicket(ticket.id).continuationWait.reason, 'required model missing');
  assert.deepEqual(db.claimAssignments('again', { validateMandate: () => true }), []);
});

test('completed and stopped Tickets stay visible until an explicit manual archive choice', async t => {
  const db = await fixture(t);
  db.createThread({ id: 'archive-thread', source: { type: 'desktop', id: 'owner' } });
  for (const status of ['running', 'waiting', 'completed']) db.createTicket({ id: status, threadId: 'archive-thread', target: status, status, mandate: {} });
  const stopped = db.createTicket({ id: 'stopped', threadId: 'archive-thread', target: 'stopped', mandate: {} });
  db.cancelTicket(stopped.id);
  assert.equal(db.listTickets({ archived: false }).length, 4);
  assert.deepEqual(db.listTickets({ archived: true }), []);
  const raw = new DatabaseSync(db.path);
  raw.prepare('INSERT INTO task_meta VALUES (?,?)').run('task-presentation:ticket:completed', JSON.stringify({ archived: true, archiveRevision: 1 }));
  raw.close();
  assert.deepEqual(db.listTickets({ archived: true }).map(row => row.id), ['completed']);
  assert.equal(db.listTickets({ archived: false }).length, 3);
  assert.equal(db.getTicket('completed').archived, true);
  assert.equal(db.getTicket('stopped').archived, false);
  assert.throws(() => db.listTickets({ archived: 'false' }), /archive scope/);
});

test('explicit archive scope is applied before paging and never implicitly hides success', async t => {
  const db = await fixture(t);
  db.createThread({ id: 'archive-paging', source: { type: 'desktop', id: 'owner' } });
  for (const [id, status] of [['first', 'waiting'], ['second', 'completed'], ['third', 'completed'], ['fourth', 'completed']]) db.createTicket({ id, status, threadId: 'archive-paging', target: id, mandate: {} });
  const raw = new DatabaseSync(db.path);
  for (const id of ['second', 'fourth']) raw.prepare('INSERT INTO task_meta VALUES (?,?)').run(`task-presentation:ticket:${id}`, JSON.stringify({ archived: true, archiveRevision: 1 }));
  raw.close();
  assert.equal(db.listTickets({ archived: false, newestFirst: true, limit: 1 })[0].id, 'third');
  assert.equal(db.listTickets({ archived: false, newestFirst: true, limit: 1, offset: 1 })[0].id, 'first');
  assert.equal(db.listTickets({ archived: true, newestFirst: true, limit: 1 })[0].id, 'fourth');
  assert.equal(db.listTickets({ archived: true, newestFirst: true, limit: 1, offset: 1 })[0].id, 'second');
});

for (const code of ['WORKER_SELF_CHECK', 'WORKER_TURN_INCOMPLETE', 'WORKER_MODEL_ROUTE', 'ROLE_PRESET_UNAVAILABLE', 'ROLE_MIGRATION_UNAVAILABLE', 'ROLE_CONFIGURATION_CHANGED', 'SESSION_ROLE_OWNERSHIP', 'ROLE_PRIVATE_SECRET']) test(`${code} retains only a controlled cause in the waiting publication`, async t => {
  const db = await fixture(t);
  db.createThread({ id: 'self-check-thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = db.createTicket({ threadId: 'self-check-thread', target: 'finish existing work', mandate: { source: { channel: 'desktop', sessionId: 'owner' } } });
  db.createAssignment(ticket.id, { id: 'self-check-work' });
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
    const row = raw.prepare('SELECT payload FROM sa_outbox WHERE ticket_id=?').get(ticket.id);
    const publication = JSON.parse(row.payload).publication;
    assert.equal(publication.origin, 'system');
    assert.equal(publication.systemState.code, expectedCode);
  } finally { raw.close(); }
  assert.equal(db.getTicket(ticket.id).resultVersion, 0);
  assert.equal(db.getTicket(ticket.id).status, 'waiting');
});

test('pause blocks queued work and resumes the same execution without a file snapshot or replay', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('pause'), mode: 'direct' });
  const ticket = db.createTicket({ threadId: 'thread', target: 'task', mandate: {} });
  db.createAssignment(ticket.id, { id: 'pause-work' });
  assert.equal(db.pauseTicket(ticket.id).status, 'waiting');
  assert.equal(db.pauseTicket(ticket.id).executionControl.paused, true);
  assert.deepEqual(db.claimAssignments('worker', { validateMandate: () => true, now: 0 }), []);
  assert.equal(db.resumeTicket(ticket.id).status, 'running');
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true, now: 0 });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = db.prepareRun(assignment.id, { ...ownership, sessionId: 'pause-session', directory: 'workspace', now: 1 });
  db.updateRun(run.id, { ...ownership, state: 'submitted', now: 2 });
  assert.equal(db.pauseTicket(ticket.id).status, 'waiting');
  assert.equal(db.pauseTicket(ticket.id).executionControl.pauseRequested, true);
  assert.throws(() => db.resumeTicket(ticket.id), { code: 'PAUSE_PENDING' });
  assert.equal(db.renewAssignment(assignment.id, { ...ownership, validateMandate: () => true, now: 3 }).allowed, true);
  const result = { runId: run.id, sessionId: 'pause-session', waitingPause: true, transcript: { hash: 'saved', lastSeq: 8 }, remainingExecutionMs: 1234 };
  db.updateRun(run.id, { ...ownership, state: 'verifying', evidence: result, now: 4 });
  assert.throws(() => db.parkPause(assignment.id, { ...ownership, result: { ...result, transcript: {} }, now: 5 }), { code: 'RUN_CONFLICT' });
  assert.throws(() => db.parkPause(assignment.id, { ...ownership, result, now: 5 }), { code: 'PAUSE_PENDING' });
  db.confirmExecutionStopped(assignment.id, ownership);
  assert.equal(db.parkPause(assignment.id, { ...ownership, result, now: 5 }).state, 'paused');
  assert.equal(db.getTicket(ticket.id).status, 'waiting');
  assert.equal(db.getTicket(ticket.id).executionControl.paused, true);
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
    assert.equal(reopened.getTicket(queued.id).status, 'waiting');
  assert.equal(reopened.getTicket(queued.id).executionControl.paused, true);
    assert.deepEqual(reopened.claimAssignments('replacement', { validateMandate: () => true, now: 11 }), []);
    assert.equal(reopened.getAssignment('unknown-paused').state, 'uncertain');
    assert.equal(reopened.pauseTicket(running.id).status, 'waiting');
  assert.equal(reopened.pauseTicket(running.id).executionControl.pauseRequested, true);
    assert.throws(() => reopened.resumeTicket(running.id), { code: 'PAUSE_PENDING' });
    reopened.resumeTicket(queued.id);
    assert.equal(reopened.claimAssignments('replacement', { validateMandate: () => true, now: 12 })[0].id, 'queued-paused');
    assert.equal(reopened.cancelTicket(running.id).status, 'waiting');
  assert.equal(reopened.cancelTicket(running.id).executionControl.stopRequested, true);
    assert.throws(() => reopened.resumeTicket(running.id), { code: 'TICKET_STOPPED' });
  } finally { reopened.close(); }
});

test('requirement edits fence stale results while preserving leases and queued Assignment identities', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('revision'), mode: 'direct' });
  const ticket = db.createTicket({ threadId: 'thread', target: 'original', acceptance: 'first check', mandate: {} });
  assert.equal(ticket.instructionRevision, 1);
  db.createAssignment(ticket.id, { id: 'active' });
  db.createAssignment(ticket.id, { id: 'queued' });
  const [active] = db.claimAssignments('worker', { validateMandate: () => true, now: 0 });
  assert.equal(active.instructionRevision, 1);
  assert.equal(db.updateTicket(ticket.id, { status: 'waiting' }).instructionRevision, 1);
  assert.equal(db.updateTicket(ticket.id, { target: 'original', status: 'running' }).instructionRevision, 1);
  const changed = db.updateTicket(ticket.id, { acceptance: 'new check' }, { expectedInstructionRevision: 1 });
  assert.equal(changed.instructionRevision, 2);
  assert.throws(() => db.updateTicket(ticket.id, { target: 'lost update' }, { expectedInstructionRevision: 1 }), { code: 'INSTRUCTION_REVISION_CONFLICT' });
  assert.equal(db.commitResult(ticket.id, { assignment: { ...active, instructionRevision: 2 }, result: { summary: 'stale' }, uniqueKey: 'stale', now: 1 }).result.association.current, false);
  assert.equal(db.commitResult(ticket.id, { result: { summary: 'unversioned' }, uniqueKey: 'unversioned', now: 1 }).result.association.current, false);
  assert.equal(db.results(ticket.id).length, 2);
  assert.equal(db.deliveries(ticket.id).length, 0);
  assert.equal(db.getTicket(ticket.id).status, 'running');
  const [queued] = db.claimAssignments('next', { validateMandate: () => true, now: 2 });
  assert.equal(queued.id, 'queued'); assert.equal(queued.instructionRevision, 2);
  assert.equal(db.renewAssignment(active.id, { owner: active.owner, fence: active.fence, validateMandate: () => true, now: 3 }).allowed, true);
  assert.throws(() => db.createAssignment(ticket.id, { instructionRevision: 1 }), { code: 'INSTRUCTION_REVISION_CONFLICT' });
  db.commitResult(ticket.id, { assignment: queued, result: { summary: 'new requirement met', completion: { kind: 'completed' } }, uniqueKey: 'new', now: 5 });
  assert.equal(db.getTicket(ticket.id).status, 'completed');
  assert.equal(db.results(ticket.id).at(-1).instructionRevision, 2);
  assert.equal(db.commitResult(ticket.id, { assignment: queued, result: { summary: 'new requirement met', completion: { kind: 'completed' } }, uniqueKey: 'new', now: 6 }).duplicate, true);
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
  // This schema predates the execution-fact journal and its column-bound triggers.
  for (const { name } of old.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'sa_execution_fact_*'").all())
    old.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  old.exec('DROP TABLE sa_execution_facts; DROP TABLE sa_execution_projection');
  old.exec('ALTER TABLE sa_tickets DROP COLUMN instruction_revision; ALTER TABLE sa_tickets DROP COLUMN acceptance');
  old.prepare('UPDATE sa_assignments SET payload=? WHERE id=?').run('{}', 'legacy');
  old.close();
  const reopened = createAssistantOrchestrationStore({ filename });
  try {
    assert.equal(reopened.getTicket(ticket.id).target, 'preserved');
    assert.equal(reopened.getTicket(ticket.id).instructionRevision, 1);
    assert.equal(reopened.getTicket(ticket.id).acceptance, 'preserved acceptance');
    const migrated = new DatabaseSync(filename);
    try { assert.equal(migrated.prepare('SELECT payload FROM sa_assignments WHERE id=?').get('legacy').payload, '{}'); }
    finally { migrated.close(); }
    const [assignment] = reopened.claimAssignments('worker', { validateMandate: () => true, now: 0 });
    reopened.commitResult(ticket.id, { assignment, result: { summary: 'legacy complete', completion: { kind: 'completed' } }, uniqueKey: 'legacy-result', now: 1 });
    assert.equal(reopened.getTicket(ticket.id).status, 'completed');
  } finally { reopened.close(); }
});

async function savedUncertainResult(t, { stopped = false } = {}) {
  const db = await fixture(t);
  db.ingest({ ...input('recovery'), mode: 'direct' });
  const ticket = db.createTicket({ threadId: 'thread', target: 'work', mandate: {} });
  db.createAssignment(ticket.id, {});
  const [assignment] = db.claimAssignments('original', { validateMandate: () => true, now: 0 });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = db.prepareRun(assignment.id, { ...ownership, sessionId: 'session', directory: '/task', now: 1 });
  db.updateRun(run.id, { ...ownership, state: 'submitted', now: 2 });
  const evidence = { runId: run.id, sessionId: 'session', summary: 'result', completion: { kind: 'completed' }, transcript: { hash: 'hash', lastSeq: 3 } };
  db.updateRun(run.id, { ...ownership, state: 'verifying', evidence, now: 3 });
  if (stopped) db.confirmExecutionStopped(assignment.id, ownership);
  db.renewAssignment(assignment.id, { ...ownership, validateMandate: () => false, now: 4 });
  const request = { fence: assignment.fence, runId: run.id, observation: { sessionId: 'session', completed: true, ...evidence.transcript }, validateMandate: () => true, now: 5 };
  return { db, ticket, assignment, run, evidence, request };
}

test('normal official completion is accepted atomically on the original uncertain Run without another lease', async t => {
  const { db, ticket, assignment, run, evidence } = await savedUncertainResult(t);
  const options = { assignment: { id: assignment.id, fence: assignment.fence }, runId: run.id,
    result: evidence, uniqueKey: 'recovered', now: 8 };
  assert.equal(db.acceptRecoveredResult(ticket.id, { ...options, result: { ...evidence, sessionId: 'foreign' } }).result.association.current, false);
  assert.equal(db.results(ticket.id).length, 1);
  assert.equal(db.getAssignment(assignment.id).state, 'uncertain');
  const accepted = db.acceptRecoveredResult(ticket.id, { ...options,
    validateMandate: () => assert.fail('Saving an existing result must not re-authorize execution') });
  assert.equal(accepted.duplicate, false);
  assert.equal(db.getTicket(ticket.id).status, 'completed');
  assert.equal(db.getAssignment(assignment.id).state, 'completed');
  assert.equal(db.getAssignment(assignment.id).fence, assignment.fence);
  assert.equal(db.getAssignment(assignment.id).attempts, 1);
  assert.equal(db.runs(assignment.id).length, 1);
  assert.equal(db.runs(assignment.id)[0].state, 'completed');
  assert.equal(db.acceptRecoveredResult(ticket.id, options).duplicate, true);
  assert.equal(db.results(ticket.id).length, 2);
  assert.equal(db.deliveries(ticket.id).length, 1);
});

test('recovered drafts retain their content without crossing newer execution or stop controls', async t => {
  const { db, ticket, assignment, run, evidence } = await savedUncertainResult(t, { stopped: true });
  const options = { assignment: { id: assignment.id, fence: assignment.fence + 1 }, runId: run.id,
    result: evidence, uniqueKey: 'recovered', validateMandate: () => true, now: 8 };
  assert.equal(db.acceptRecoveredResult(ticket.id, options).result.association.current, false);
  db.cancelTicket(ticket.id);
  db.acceptRecoveredResult(ticket.id, { ...options, assignment });
  assert.equal(db.results(ticket.id).length, 1);
  assert.equal(db.getTicket(ticket.id).status, 'waiting');
});

test('legacy evidence-only queued work becomes uncertain on reopen instead of executing again', async t => {
  const { db, ticket, assignment, run, evidence } = await savedUncertainResult(t);
  const raw = new DatabaseSync(db.path);
  raw.prepare("UPDATE sa_assignments SET state='queued',payload=json_set(payload,'$.verificationOnly',json(?),'$.verificationAfter',999) WHERE id=?")
    .run(JSON.stringify({ runId: run.id }), assignment.id);
  raw.close();
  const reopened = createAssistantOrchestrationStore({ filename: db.path });
  try {
    assert.equal(reopened.getAssignment(assignment.id).state, 'uncertain');
    assert.equal(reopened.getAssignment(assignment.id).verificationOnly, undefined);
    assert.equal(reopened.claimAssignments('must-not-replay', { validateMandate: () => true }).length, 0);
    assert.equal(reopened.runs(assignment.id).length, 1);
    reopened.acceptRecoveredResult(ticket.id, { assignment, runId: run.id, result: evidence,
      uniqueKey: 'legacy-recovered', validateMandate: () => true });
    assert.equal(reopened.getTicket(ticket.id).status, 'completed');
  } finally { reopened.close(); }
});

test('execution identity persists before submission and expired runs cannot be replayed', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('run-source'), mode: 'direct' });
  const ticket = db.createTicket({ threadId: 'thread', target: 'work', mandate: { scope: ['read'] } });
  const queued = db.createAssignment(ticket.id, { executor: 'harness' });
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
  const ticket = db.createTicket({ threadId: 'thread', target: 'work', mandate: {} });
  db.subscribe(ticket.id, 'thread');
  db.createAssignment(ticket.id, {});
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true });
  db.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence, sessionId: 'session', directory: '/isolated' });
  const { trigger } = db.ingest({ ...input('followup'), gate: { allowed: false } });
  db.deliverSubscribedMessage(trigger.id, { ticketId: ticket.id });
  const receipt = { owner: assignment.owner, fence: assignment.fence, triggerId: trigger.id, sessionId: 'session', messageId: 'logged-message' };
  db.commitResult(ticket.id, { assignment, result: { summary: 'old result' }, uniqueKey: 'result' });
  assert.equal(db.results(ticket.id).length, 1);
  assert.throws(() => db.acknowledgeSubscriptionMessage(assignment.id, { ...receipt, sessionId: 'wrong-session' }), { code: 'RUN_CONFLICT' });
  db.acknowledgeSubscriptionMessage(assignment.id, receipt);
  assert.equal(db.acknowledgeSubscriptionMessage(assignment.id, receipt).applied, true);
  assert.equal(db.pendingSubscriptionMessages(ticket.id).length, 0);
  db.commitResult(ticket.id, { assignment, result: { summary: 'current result', completion: { kind: 'completed' } }, uniqueKey: 'result' });
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
  db.createAssignment(ticket.id, {});
  const [owned] = db.claimAssignments('worker', { validateMandate: () => true, now: 1 });
  const committed = db.commitResult(ticket.id, { assignment: owned, result: { completion: { kind: 'completed' }, text: '完成' }, uniqueKey: 'result1', outboxPayload: { text: '完成' }, now: 10 });
  assert.equal(db.results(ticket.id).length, 1);
  assert.equal(db.commitResult(ticket.id, { assignment: owned, result: { completion: { kind: 'completed' }, text: '完成' }, uniqueKey: 'result1', outboxPayload: { text: '完成' }, now: 10 }).duplicate, true);
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
  assert.equal(db.cancelTicket(ticket.id).status, 'waiting');
  assert.equal(db.cancelTicket(ticket.id).executionControl.stopRequested, true);
  assert.equal(db.cancelTicket(ticket.id).status, 'waiting');
  assert.equal(db.cancelTicket(ticket.id).executionControl.stopRequested, true);
  assert.deepEqual(db.claimAssignments('other', { validateMandate: () => true }), []);
  assert.throws(() => db.createAssignment(ticket.id, { id: 'late' }), { code: 'TICKET_CLOSED' });
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
  const ticket = db.createTicket({ threadId: 'thread', target: 'work', mandate: {} });
  db.createAssignment(ticket.id, { id: 'recover-pause' });
  const [assignment] = db.claimAssignments('worker', { now: 0, leaseMs: 100, validateMandate: () => true });
  const identity = { owner: assignment.owner, fence: assignment.fence };
  const run = db.prepareRun(assignment.id, { ...identity, now: 1, sessionId: 'saved-session', directory: 'workspace' });
  db.updateRun(run.id, { ...identity, now: 2, state: 'submitted' });
  const evidence = { runId: run.id, sessionId: run.sessionId, waitingPause: true, transcript: { hash: 'hash', lastSeq: 5 } };
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
  assert.equal(db.getTicket(ticket.id).status, 'waiting');
  assert.equal(db.getTicket(ticket.id).executionControl.paused, true);
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
      assert.equal(db.getTicket(ticket.id).status, 'running');
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

test('goal usage never blocks resume and budget pause reasons are rejected', async t => {
  const db = await fixture(t);
  db.ingest({ ...input('usage-pause'), mode: 'direct' });
  const ticket = db.createTicket({ threadId: 'thread', target: 'usage work', mandate: {} });
  db.createAssignment(ticket.id, { id: 'usage-work' });
  db.ensureGoalBudget({ goalId: 'parent' });
  db.ensureGoalBudget({ goalId: 'child', parentGoalId: 'parent' });
  db.bindTicketGoal({ ticketId: ticket.id, goalId: 'child' });
  for (let index = 0; index < 5; index++) assert.equal(db.reserveGoalRequest({ ticketId: ticket.id, requestId: `r-${index}` }).allowed, true);
  for (const kind of ['budget', 'execution-budget']) assert.throws(() => db.pauseTicket(ticket.id, { reason: { kind, goalId: 'parent', reason: 'requests' } }), { code: 'INVALID_PAUSE_REASON' });
  assert.deepEqual(db.pauseTicket(ticket.id).pauseReason, { kind: 'manual' });
  const reopened = createAssistantOrchestrationStore({ filename: db.path });
  try {
    assert.deepEqual(reopened.getTicket(ticket.id).pauseReason, { kind: 'manual' });
    assert.equal(reopened.goalBudget('parent').usage.requests, 5);
    assert.equal(reopened.resumeTicket(ticket.id).pauseReason, null);
    assert.equal(reopened.getTicket(ticket.id).status, 'running');
  } finally { reopened.close(); }
});

test('new pause evidence cannot carry a removed budget ending', async t => {
  const db = await fixture(t);
  db.createThread({ id: 'pause-thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = db.createTicket({ threadId: 'pause-thread', target: 'work', mandate: { source: { channel: 'desktop', sessionId: 'owner' } } });
  db.createAssignment(ticket.id, { id: 'pause-work' });
  const [assignment] = db.claimAssignments('owner', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = db.prepareRun(assignment.id, { ...ownership, sessionId: 'session', directory: 'directory' });
  db.updateRun(run.id, { ...ownership, state: 'submitted' });
  db.pauseTicket(ticket.id);
  const result = { runId: run.id, sessionId: run.sessionId, waitingPause: true, checkpoint: { manifestHash: 'saved' }, transcript: { hash: 'saved', lastSeq: 8 },
    waitingExecutionBudget: { kind: 'execution-time', effectsVerified: true, terminal: { kind: 'aborted', reason: { kind: 'hook', reason: 'benchgo-execution-budget-exhausted' } } } };
  db.updateRun(run.id, { ...ownership, state: 'verifying', evidence: result });
  db.confirmExecutionStopped(assignment.id, ownership);
  assert.throws(() => db.parkPause(assignment.id, { ...ownership, result }), { code: 'PAUSE_CONFLICT' });
});
