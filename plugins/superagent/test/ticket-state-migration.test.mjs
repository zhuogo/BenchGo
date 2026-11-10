import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-three-state-'));
  const db = createAssistantOrchestrationStore({ directory });
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  db.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  return db;
}

test('legacy business states migrate once without replaying execution or rewriting results', async t => {
  const db = await fixture(t);
  for (const status of ['open', 'pausing', 'paused', 'cancelling', 'cancelled', 'closed', 'failed', 'completed']) db.createTicket({ id: status, threadId: 'thread', target: status, mandate: {} });
  const raw = new DatabaseSync(db.path);
  raw.prepare("DELETE FROM sa_migrations WHERE id='ticket-three-states-v1'").run();
  for (const status of ['open', 'pausing', 'paused', 'cancelling', 'cancelled', 'closed', 'failed', 'completed']) raw.prepare('UPDATE sa_tickets SET status=? WHERE id=?').run(status, status);
  raw.prepare('INSERT INTO sa_results VALUES (?,?,?,?)').run('failed', 1, JSON.stringify({ outcome: 'failed', failure: { cause: '资源缺失', resumeConditions: '补充资源' } }), new Date().toISOString());
  raw.prepare('UPDATE sa_tickets SET result_version=1 WHERE id=?').run('failed');
  raw.close();
  const reopened = createAssistantOrchestrationStore({ filename: db.path });
  try {
    assert.equal(reopened.getTicket('completed').status, 'completed');
    for (const id of ['open', 'pausing', 'paused', 'cancelling', 'cancelled', 'closed', 'failed']) assert.equal(reopened.getTicket(id).status, 'waiting');
    for (const [id, key] of [['pausing', 'pauseRequested'], ['paused', 'paused'], ['cancelling', 'stopRequested'], ['cancelled', 'stopped'], ['closed', 'stopped']]) assert.equal(reopened.getTicket(id).executionControl[key], true);
    assert.equal(reopened.getTicket('failed').continuationWait.code, 'EXECUTION_FAILED');
    assert.equal(reopened.getTicket('failed').continuationWait.resumeConditions, '补充资源');
    assert.deepEqual(reopened.results('failed')[0].failure, { cause: '资源缺失', resumeConditions: '补充资源' });
    assert.deepEqual(reopened.claimAssignments('worker', { validateMandate: () => true }), []);
    assert.throws(() => reopened.updateTicket('failed', { status: 'failed' }), /Invalid Ticket status/);
  } finally { reopened.close(); }
});

test('a legacy failed ticket retains its explicit archive after migration to waiting', async t => {
  const db = await fixture(t);
  db.createTicket({ id: 'archived-failure', threadId: 'thread', target: '历史失败单', mandate: {} });
  db.createAssignment('archived-failure', {});
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true });
  db.commitResult('archived-failure', { result: { outcome: 'failed', summary: '历史失败' }, assignment, uniqueKey: 'historical-failure' });
  const raw = new DatabaseSync(db.path);
  raw.prepare("UPDATE sa_tickets SET status='failed' WHERE id='archived-failure'").run();
  raw.prepare("DELETE FROM sa_migrations WHERE id='ticket-three-states-v1'").run();
  const metadata = { version: 1, archived: true, archiveRevision: 1, cleanupReceiptId: 'original-archive' };
  raw.prepare('INSERT INTO task_meta(key,value) VALUES (?,?)').run('task-presentation:ticket:archived-failure', JSON.stringify(metadata));
  raw.close();
  const reopened = createAssistantOrchestrationStore({ filename: db.path });
  try {
    assert.equal(reopened.getTicket('archived-failure').status, 'waiting');
    assert.equal(reopened.getTicket('archived-failure').archived, true);
    assert.deepEqual(reopened.listTickets({ archived: false }), []);
    assert.deepEqual(reopened.listTickets({ archived: true }).map(row => row.id), ['archived-failure']);
    assert.deepEqual(reopened.claimAssignments('no-replay', { validateMandate: () => true }), []);
    const check = new DatabaseSync(db.path);
    try { assert.deepEqual(JSON.parse(check.prepare('SELECT value FROM task_meta WHERE key=?').get('task-presentation:ticket:archived-failure').value), metadata); }
    finally { check.close(); }
  } finally { reopened.close(); }
});

test('failure delivery waits without automatic rerun, a fresh authorized revision resumes the same session', async t => {
  const db = await fixture(t);
  const source = { channel: 'desktop', sessionId: 'owner' };
  const ticket = db.createTicket({ id: 'work', threadId: 'thread', target: '目标', mandate: { source } });
  db.subscribe(ticket.id, 'thread');
  db.createAssignment(ticket.id, { id: 'assignment' });
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true });
  assert.equal(db.getTicket(ticket.id).status, 'running');
  const run = db.prepareRun(assignment.id, { ...assignment, sessionId: 'same-session', directory: 'workspace' });
  db.updateRun(run.id, { ...assignment, state: 'submitted' });
  const result = { runId: run.id, sessionId: run.sessionId, summary: '没有完成', outcome: 'failed', failure: { attempted: '已有尝试', cause: '缺少资源', resumeConditions: '补充资源' }, checkpoint: { manifestHash: 'hash' }, transcript: { hash: 'transcript', lastSeq: 1 }, executionEffects: { effectsVerified: true } };
  db.updateRun(run.id, { ...assignment, state: 'verifying', evidence: result });
  db.confirmExecutionStopped(assignment.id, assignment);
  const committed = db.commitResult(ticket.id, { result, assignment, uniqueKey: 'failure' });
  const [outbox] = db.claimOutbox('delivery');
  db.saveOutboxReply(outbox.id, { owner: 'delivery', publication: { origin: 'router', action: 'deliver', text: '已核实当前结果与恢复条件' } });
  db.finishOutbox(outbox.id, { owner: 'delivery', sent: true, receipt: { status: 'accepted', messageId: 'receipt' } });
  assert.equal(db.getTicket(ticket.id).status, 'waiting');
  assert.equal(db.getTicket(ticket.id).continuationWait.code, 'EXECUTION_FAILED');
  assert.equal(db.subscriptions({ ticketId: ticket.id })[0].state, 'active');
  assert.deepEqual(db.claimAssignments('no-retry', { validateMandate: () => true }), []);
  assert.equal(db.resumeTicket(ticket.id).status, 'waiting');
  assert.deepEqual(db.claimAssignments('still-no-retry', { validateMandate: () => true }), []);
  assert.throws(() => db.queueFailureContinuationInTransaction(ticket.id, { expectedResultVersion: committed.result.version, expectedInstructionRevision: 1, triggerId: 'forged', validateMandate: () => true }), { code: 'MANDATE_REVOKED' });
  const { trigger } = db.ingest({ dedupeKey: 'revision', thread: { id: 'thread', source: { type: 'desktop', id: 'owner' } }, source, actor: { kind: 'human', id: 'owner' }, content: '资源已补充，继续', mode: 'direct' });
  db.updateTicket(ticket.id, { target: '资源补齐后继续目标' });
  const raw = new DatabaseSync(db.path);
  raw.prepare('INSERT INTO sa_ticket_triggers VALUES (?,?)').run(ticket.id, trigger.id);
  raw.close();
  db.recordTicketInput({ ticketId: ticket.id, triggerId: trigger.id, kind: 'revision', idempotencyKey: 'revision', instructionRevision: 2 });
  assert.throws(() => db.queueFailureContinuationInTransaction(ticket.id, { expectedResultVersion: 1, expectedInstructionRevision: 2, triggerId: trigger.id, validateMandate: () => false }), { code: 'MANDATE_REVOKED' });
  const continued = db.queueFailureContinuationInTransaction(ticket.id, { expectedResultVersion: 1, expectedInstructionRevision: 2, triggerId: trigger.id, validateMandate: () => true });
  assert.equal(continued.queued, true);
  const [next] = db.claimAssignments('continued', { validateMandate: () => true });
  assert.equal(next.id, assignment.id);
  assert.equal(next.contextContinuation.runId, run.id);
  assert.equal(db.runs(next.id).length, 1);
  assert.equal(db.runs(next.id)[0].sessionId, 'same-session');
  assert.equal(db.results(ticket.id).length, 1);
});

for (const outcome of ['completed', 'failed']) test(`late ${outcome} delivery preserves the current execution control`, async t => {
  const db = await fixture(t);
  const ticket = db.createTicket({ id: 'late', threadId: 'thread', target: '目标', mandate: { source: { channel: 'desktop', sessionId: 'owner' } } });
  db.commitResult(ticket.id, { result: { summary: '结果', outcome, ...(outcome === 'failed' ? { failure: { cause: '受阻', resumeConditions: '条件变化后继续' } } : {}) }, uniqueKey: 'late-result' });
  const [outbox] = db.claimOutbox('delivery');
  if (outcome === 'completed') db.pauseTicket(ticket.id);
  else db.cancelTicket(ticket.id);
  const before = db.getTicket(ticket.id).executionControl;
  db.saveOutboxReply(outbox.id, { owner: 'delivery', publication: { origin: 'router', action: 'deliver', text: '已核实当前结果与恢复条件' } });
  db.finishOutbox(outbox.id, { owner: 'delivery', sent: true, receipt: { status: 'accepted', messageId: 'received' } });
  assert.equal(db.getTicket(ticket.id).status, 'waiting');
  assert.deepEqual(db.getTicket(ticket.id).executionControl, before);
  if (outcome === 'completed') assert.equal(db.resumeTicket(ticket.id).status, 'completed');
  else assert.throws(() => db.resumeTicket(ticket.id), { code: 'TICKET_STOPPED' });
});
