import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { commitWorkerResult } from '../src/result-commit.mjs';

async function fixture(t, resultOverrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-receipt-'));
  const db = createAssistantOrchestrationStore({ directory });
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  db.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = db.createTicket({ threadId: 'thread', target: 'task', mandate: { source: { channel: 'desktop', sessionId: 'owner' } } });
  // Only the bound execution's official ending decides the Ticket state.
  db.createAssignment(ticket.id, { id: 'work' });
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true });
  const run = db.prepareRun(assignment.id, { ...assignment, sessionId: 'session', directory: '/task' });
  db.updateRun(run.id, { ...assignment, state: 'submitted' });
  const result = { summary: 'original body', evidenceRefs: [], runId: run.id, sessionId: run.sessionId, instructionRevision: 1,
    completion: { kind: 'completed' }, ...resultOverrides };
  const commit = () => commitWorkerResult({ database: db, ticket, assignment, result, uniqueKey: 'stable-result' });
  return { db, ticket, assignment, commit };
}

test('unknown sends remain unclaimed until receipt reconciliation, which records exactly that delivery', async t => {
  const { db, ticket, commit } = await fixture(t);
  commit();
  const [delivery] = db.claimOutbox('transport', { now: 10 ** 13 });
  assert.equal(delivery.payload.text, undefined);
  assert.equal(delivery.payload.publication, undefined);
  db.saveOutboxReply(delivery.id, { owner: 'transport', now: 10 ** 13,
    publication: { action: 'deliver', origin: 'router', text: '任务已经处理完成。' } });
  db.finishOutbox(delivery.id, { owner: 'transport', uncertain: true, error: 'response lost', now: 10 ** 13 + 1 });
  assert.deepEqual(db.claimOutbox('blind-retry', { now: 10 ** 13 + 100000 }), []);
  assert.equal(db.getTicket(ticket.id).status, 'completed', 'execution completion never waits for delivery');
  assert.equal(db.deliveries(ticket.id)[0].state, 'uncertain');
  db.reconcileOutbox(delivery.id, { attempts: 1, outcome: 'sent', evidence: 'provider message receipt', receipt: { status: 'accepted', messageId: 'actual-message' } });
  assert.equal(db.deliveries(ticket.id)[0].state, 'sent');
  assert.equal(db.getTicket(ticket.id).status, 'completed');
  assert.equal(commit().duplicate, true);
  assert.equal(db.results(ticket.id).length, 1);
  assert.equal(db.deliveries(ticket.id).length, 1);
  assert.throws(() => db.reconcileOutbox(delivery.id, { attempts: 1, outcome: 'sent', evidence: 'duplicate', receipt: { status: 'accepted', messageId: 'actual-message' } }), { code: 'OUTBOX_RECONCILIATION_CONFLICT' });
});

test('confirmed not-sent retry preserves Router wording, result version and idempotency key without creating execution', async t => {
  const { db, ticket, assignment, commit } = await fixture(t);
  commit();
  const [first] = db.claimOutbox('first', { now: 10 ** 13 });
  const ready = db.saveOutboxReply(first.id, { owner: 'first', now: 10 ** 13,
    publication: { action: 'deliver', origin: 'router', text: '已完成，下面是整理后的结论。' } });
  db.finishOutbox(first.id, { owner: 'first', error: 'known not sent', retryMs: 100, now: 10 ** 13 + 1 });
  const [second] = db.claimOutbox('second', { now: 10 ** 13 + 101 });
  assert.equal(second.id, first.id); assert.equal(second.uniqueKey, first.uniqueKey); assert.deepEqual(second.payload, ready.payload);
  assert.notEqual(second.payload.text, db.results(ticket.id)[0].summary);
  db.finishOutbox(second.id, { owner: 'second', sent: true, receipt: { status: 'accepted', messageId: 'delivery' }, now: 10 ** 13 + 102 });
  assert.equal(db.getTicket(ticket.id).status, 'completed');
  assert.deepEqual(db.assignments(ticket.id).map(row => [row.id, row.state]), [[assignment.id, 'completed']]);
});

test('suppressed or unconfirmed receipt never feeds learning closure', async t => {
  const { db, ticket, commit } = await fixture(t); commit();
  const [delivery] = db.claimOutbox('source', { now: 10 ** 13 });
  db.saveOutboxReply(delivery.id, { owner: 'source', now: 10 ** 13,
    publication: { action: 'deliver', origin: 'router', text: '工作结果已整理好。' } });
  db.finishOutbox(delivery.id, { owner: 'source', sent: true, receipt: { status: 'suppressed', reason: 'source revoked' }, now: 10 ** 13 + 1 });
  assert.equal(db.getTicket(ticket.id).status, 'completed');
  assert.equal(db.recordClosedTicket(ticket.id), null);
  assert.equal(db.learningSources({ limit: 10 }).items.length, 0);
});

test('delivered execution failure stays waiting without learning closure or automatic rerun', async t => {
  const { db, ticket, commit } = await fixture(t, { completion: { kind: 'error' }, summary: 'Unable to finish without service access' });
  commit();
  const [delivery] = db.claimOutbox('source', { now: 10 ** 13 });
  db.saveOutboxReply(delivery.id, { owner: 'source', now: 10 ** 13, publication: { action: 'deliver', origin: 'router', text: '未完成，等待补充目标服务权限后继续。' } });
  db.finishOutbox(delivery.id, { owner: 'source', sent: true, receipt: { status: 'accepted', messageId: 'failure-delivered' }, now: 10 ** 13 + 1 });
  const waiting = db.getTicket(ticket.id);
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.continuationWait.code, 'EXECUTION_FAILED');
  assert.equal(waiting.continuationWait.sourceResultVersion, waiting.resultVersion);
  assert.equal(waiting.continuationWait.reason, 'error');
  assert.equal(db.results(ticket.id)[0].outcome, 'failed');
  assert.equal(db.recordClosedTicket(ticket.id), null);
  assert.equal(db.learningSources({ limit: 10 }).items.length, 0);
  assert.deepEqual(db.claimAssignments('no-blind-retry', { validateMandate: () => true }), []);
  assert.deepEqual(db.claimOutbox('no-duplicate-delivery', { now: 10 ** 13 + 100000 }), []);
});
