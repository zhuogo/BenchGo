import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { commitWorkerResult } from '../src/result-commit.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-result-drafts-'));
  const db = createAssistantOrchestrationStore({ directory });
  db.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = db.createTicket({ threadId: 'thread', target: 'task', mandate: { source: { channel: 'desktop', sessionId: 'owner' } } });
  db.createAssignment(ticket.id, { id: 'work' });
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true });
  const run = db.prepareRun(assignment.id, { ...assignment, sessionId: 'session', directory: '/task' });
  db.updateRun(run.id, { ...assignment, state: 'submitted' });
  const result = { summary: 'Original draft', runId: run.id, sessionId: run.sessionId,
    instructionRevision: 1, completion: { kind: 'completed' }, executionEffects: { effectsVerified: false, unknownCallIds: ['unresolved-read'] } };
  db.saveWorkerDraft(assignment.id, { runId: run.id, ...assignment, result });
  db.updateRun(run.id, { ...assignment, state: 'verifying', evidence: result });
  const raw = new DatabaseSync(db.path);
  t.after(async () => { raw.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  const commit = (draft = result, key = 'result') => commitWorkerResult({ database: db, ticket: db.getTicket(ticket.id), assignment, result: draft, uniqueKey: key });
  return { db, raw, ticket, assignment, run, result, commit };
}

test('normal results complete without hashes or effect approval', async t => {
  const f = await fixture(t);
  f.commit();
  assert.equal(f.db.getTicket(f.ticket.id).status, 'completed');
  assert.equal(f.db.results(f.ticket.id)[0].summary, f.result.summary);
  assert.deepEqual(f.db.results(f.ticket.id)[0].executionEffects, f.result.executionEffects);
  assert.equal(f.db.deliveries(f.ticket.id).length, 1);
});

test('failure reports, partial text and unanswered questions are retained without claiming success', async t => {
  for (const patch of [{ outcome: 'failed' }, { completion: { kind: 'aborted' } }, { completion: { kind: 'error' } },
    { completion: undefined }, { waitingAttention: { attentionIds: ['question'] } }, { waitingPause: true }]) await t.test(JSON.stringify(patch), async t => {
    const f = await fixture(t);
    f.db.updateTicket(f.ticket.id, { status: 'waiting' });
    f.commit({ ...f.result, ...patch });
    assert.equal(f.db.results(f.ticket.id).length, 1);
    assert.equal(f.db.getTicket(f.ticket.id).status, 'waiting');
    if (patch.waitingAttention || patch.waitingPause) assert.equal(f.db.getTicket(f.ticket.id).continuationWait, null);
  });
});

test('conflicting retries and late drafts remain readable without replacing the completed result', async t => {
  const f = await fixture(t);
  const first = f.commit();
  assert.equal(f.commit().duplicate, true);
  const conflict = f.commit({ ...f.result, summary: 'Different original draft' });
  assert.equal(conflict.result.association.current, false);
  assert.equal(f.db.getTicket(f.ticket.id).resultVersion, first.result.version);
  assert.deepEqual(f.db.results(f.ticket.id).map(row => row.summary), ['Original draft', 'Different original draft']);
  assert.equal(f.db.deliveries(f.ticket.id).length, 1);
});

test('stale requirements and foreign run references only affect association, never raw retention', async t => {
  const f = await fixture(t);
  f.db.updateTicket(f.ticket.id, { target: 'new requirement' }, { expectedInstructionRevision: 1 });
  const stale = f.commit();
  assert.equal(stale.result.association.current, false);
  assert.equal(f.db.getTicket(f.ticket.id).status, 'running');
  assert.equal(f.db.getTicket(f.ticket.id).resultVersion, 0);
  f.commit({ ...f.result, runId: 'foreign-run' }, 'foreign');
  assert.equal(f.db.results(f.ticket.id).length, 2);
  assert.equal(f.db.deliveries(f.ticket.id).length, 0);
});

test('a later cancel request cannot erase an already finished official execution', async t => {
  const f = await fixture(t);
  f.db.cancelTicket(f.ticket.id);
  f.commit({ ...f.result, completion: { kind: 'completed', at: new Date(Date.now() - 60000).toISOString() } });
  assert.equal(f.db.getTicket(f.ticket.id).status, 'completed');
  assert.deepEqual(f.db.getTicket(f.ticket.id).executionControl, {});
});

test('physical result-write failure never reports success and the retained Run draft is recoverable', async t => {
  const f = await fixture(t);
  f.raw.exec("CREATE TRIGGER fail_result BEFORE INSERT ON sa_results BEGIN SELECT RAISE(ABORT,'storage unavailable'); END");
  assert.throws(() => f.commit(), /storage unavailable/);
  assert.equal(f.db.results(f.ticket.id).length, 0);
  assert.equal(f.db.runs(f.assignment.id)[0].evidence.summary, f.result.summary);
  f.raw.exec('DROP TRIGGER fail_result');
  f.commit();
  assert.equal(f.db.getTicket(f.ticket.id).status, 'completed');
  assert.equal(f.db.getAssignment(f.assignment.id).attempts, 1);
});

test('notification-write failure cannot roll back raw text or completion and retries the same record', async t => {
  const f = await fixture(t);
  f.raw.exec("CREATE TRIGGER fail_notification BEFORE INSERT ON sa_outbox BEGIN SELECT RAISE(ABORT,'notification unavailable'); END");
  assert.throws(() => f.commit(), { code: 'RESULT_FINALIZE_PENDING' });
  assert.equal(f.db.results(f.ticket.id).length, 1);
  assert.equal(f.db.getTicket(f.ticket.id).status, 'completed');
  assert.equal(f.db.runs(f.assignment.id)[0].resultSaved.notificationPending, true);
  f.raw.exec('DROP TRIGGER fail_notification');
  const reopened = createAssistantOrchestrationStore({ filename: f.db.path });
  try {
    commitWorkerResult({ database: reopened, ticket: reopened.getTicket(f.ticket.id), assignment: f.assignment, result: f.result, uniqueKey: 'result' });
    assert.equal(reopened.results(f.ticket.id).length, 1);
    assert.equal(reopened.deliveries(f.ticket.id).length, 1);
    assert.equal(reopened.runs(f.assignment.id)[0].resultSaved.notificationPending, false);
  } finally { reopened.close(); }
});

test('new input arriving at result commit is retained and queued on the same original session', async t => {
  const f = await fixture(t);
  f.db.ingest({ dedupeKey: 'followup', thread: { id: 'thread', source: { type: 'desktop', id: 'owner' } }, source: { channel: 'desktop', sessionId: 'owner' },
    actor: { id: 'owner' }, content: 'new input', gate: { allowed: false }, policyVersion: 'p' });
  f.db.subscribe(f.ticket.id, 'thread');
  const trigger = f.db.ingest({ dedupeKey: 'followup2', thread: { id: 'thread', source: { type: 'desktop', id: 'owner' } }, source: { channel: 'desktop', sessionId: 'owner' },
    actor: { id: 'owner' }, content: 'next input', gate: { allowed: false }, policyVersion: 'p' }).trigger;
  f.db.deliverSubscribedMessage(trigger.id, { ticketId: f.ticket.id });
  f.commit();
  assert.equal(f.db.results(f.ticket.id).length, 1);
  assert.equal(f.db.getTicket(f.ticket.id).status, 'running');
  const queued = f.db.getAssignment(f.assignment.id);
  assert.equal(queued.state, 'queued');
  assert.equal(queued.contextContinuation.runId, f.run.id);
  assert.equal(f.db.runs(f.assignment.id)[0].sessionId, f.run.sessionId);
});

test('a state change between raw retention and finalization cannot overwrite a newer request', async t => {
  const f = await fixture(t);
  f.raw.exec(`CREATE TRIGGER concurrent_revision AFTER INSERT ON sa_results BEGIN
    UPDATE sa_tickets SET instruction_revision=instruction_revision+1,status='waiting',execution_control='{"stopRequested":true}' WHERE id=NEW.ticket_id;
    END`);
  f.commit();
  assert.equal(f.db.results(f.ticket.id).length, 1);
  assert.equal(f.db.getTicket(f.ticket.id).instructionRevision, 2);
  assert.equal(f.db.getTicket(f.ticket.id).status, 'waiting');
  assert.equal(f.db.getTicket(f.ticket.id).resultVersion, 0);
  assert.equal(f.db.deliveries(f.ticket.id).length, 0);
});
