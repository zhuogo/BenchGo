import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resultDelivery, resultOutbox, validateDelivery, deliverySuppression, systemStateDelivery } from '../src/result-delivery.mjs';
import { commitWorkerResult } from '../src/result-commit.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';

const ticket = { id: 't', title: '原任务', target: '完整要求', instructionRevision: 2, resultVersion: 0, mandate: { source: { channel: 'desktop', sessionId: 'owner' } } };
const result = { summary: '  原正文\n\n保留段落与结尾。\n', outcome: 'completed', evidenceRefs: [] };

test('Worker body is retained as evidence while outbox only signals completion to Router', () => {
  const delivery = resultDelivery({ ticket, result });
  assert.equal(delivery.text, result.summary);
  assert.equal(delivery.origin, 'worker');
  assert.deepEqual(resultOutbox({ ticket, result, delivery }), { type: 'ticket.result', ticketId: 't', title: '原任务', source: ticket.mandate.source,
    instructionRevision: 2, resultVersion: 1, outcome: 'completed', replyState: 'pending', evidenceRefs: [] });
  assert.equal(validateDelivery({ ...delivery, text: 'x'.repeat(20000) }).text.length, 20000);
});

test('superseded requirements and sources are suppressed rather than delivered', () => {
  const row = { ticketId: 't', payload: resultOutbox({ ticket, result, delivery: resultDelivery({ ticket, result }) }) };
  const database = { getTicket: () => ({ ...ticket, resultVersion: 1 }) };
  assert.equal(deliverySuppression(database, row), null);
  assert.equal(deliverySuppression({ getTicket: () => ({ ...ticket, resultVersion: 1, instructionRevision: 3 }) }, row), 'superseded-instruction');
  assert.equal(deliverySuppression(database, { ...row, payload: { ...row.payload, source: { channel: 'other' } } }), 'source-mismatch');
});

async function storedResult(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-router-result-'));
  let database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'main', source: { type: 'desktop', id: 'owner' } });
  const current = database.createTicket({ threadId: 'main', target: 'original request', mandate: ticket.mandate });
  // Only the bound, normally completed execution is the current result.
  database.createAssignment(current.id, { id: 'work' });
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  const run = database.prepareRun(assignment.id, { ...assignment, sessionId: 'session', directory: '/task' });
  database.updateRun(run.id, { ...assignment, state: 'submitted' });
  const draft = { ...result, instructionRevision: 1, runId: run.id, sessionId: run.sessionId, completion: { kind: 'completed' } };
  const committed = commitWorkerResult({ database, ticket: current, assignment, result: draft, uniqueKey: 'worker-result' });
  return { get database() { return database; }, ticket: current, committed,
    reopen() { database.close(); database = createAssistantOrchestrationStore({ directory }); } };
}

for (const receipt of [{ status: 'suppressed', reason: 'superseded' }, { status: 'accepted' }, { status: 'accepted', messageId: 'source-receipt' }]) {
  test(`execution completion is independent from a persisted Router reply (${receipt.status}/${Boolean(receipt.messageId)})`, async t => {
    const f = await storedResult(t);
    const [pending] = f.database.claimOutbox('sender');
    f.database.finishOutbox(pending.id, { owner: 'sender', sent: true, receipt });
    assert.equal(f.database.getTicket(f.ticket.id).status, 'completed');
    assert.equal(f.database.results(f.ticket.id)[0].summary, result.summary);
  });
}

test('Router reply is immutable through retry and its confirmed source receipt only records delivery', async t => {
  const f = await storedResult(t);
  const [pending] = f.database.claimOutbox('sender', { now: Date.now() + 1 });
  const reply = { action: 'deliver', origin: 'router', text: '已整理完成，重点结论在这里。' };
  f.database.saveOutboxReply(pending.id, { owner: 'sender', publication: reply });
  assert.throws(() => f.database.saveOutboxReply(pending.id, { owner: 'sender', publication: { ...reply, text: '另一个版本' } }), { code: 'OUTBOX_CONFLICT' });
  f.database.finishOutbox(pending.id, { owner: 'sender', error: 'confirmed-not-sent', retryMs: 0 });
  f.reopen();
  const [retry] = f.database.claimOutbox('retry');
  assert.equal(retry.id, pending.id);
  assert.equal(retry.payload.publication.text, reply.text);
  assert.equal(f.database.getTicket(f.ticket.id).status, 'completed');
  f.database.finishOutbox(retry.id, { owner: 'retry', sent: true, receipt: { status: 'accepted', messageId: 'source-receipt' } });
  assert.equal(f.database.getTicket(f.ticket.id).status, 'completed');
  f.reopen();
  assert.deepEqual(f.database.claimOutbox('after-restart'), []);
  assert.equal(f.database.results(f.ticket.id).length, 1);
});

test('suppressed Router reply is retired without reverting execution completion', async t => {
  const f = await storedResult(t);
  const [pending] = f.database.claimOutbox('sender');
  f.database.saveOutboxReply(pending.id, { owner: 'sender',
    publication: { action: 'deliver', origin: 'router', text: '已完成。' } });
  f.database.finishOutbox(pending.id, { owner: 'sender', sent: true,
    receipt: { status: 'suppressed', reason: 'authorization-changed', messageId: 'not-a-source-receipt' } });
  assert.equal(f.database.getTicket(f.ticket.id).status, 'completed');
  assert.deepEqual(f.database.claimOutbox('retry'), []);
});


test('duplicate receipts remain idempotent and a restart never resends an unknown transport outcome', async t => {
  const f = await storedResult(t);
  const [pending] = f.database.claimOutbox('sender');
  f.database.saveOutboxReply(pending.id, { owner: 'sender', publication: { action: 'deliver', origin: 'router', text: '???' } });
  f.reopen();
  assert.deepEqual(f.database.claimOutbox('restart', { now: Date.now() + 61000 }), []);
  const unknown = f.database.deliveries(f.ticket.id)[0];
  assert.equal(unknown.state, 'uncertain');
  assert.equal(f.database.getTicket(f.ticket.id).status, 'completed');
  const receipt = { status: 'accepted', messageId: 'confirmed-source-message' };
  f.database.reconcileOutbox(unknown.id, { attempts: unknown.attempts, outcome: 'sent', evidence: 'source message lookup', receipt });
  assert.equal(f.database.finishOutbox(unknown.id, { owner: 'sender', sent: true, receipt }).state, 'sent');
  f.reopen();
  assert.deepEqual(f.database.claimOutbox('again'), []);
  assert.equal(f.database.results(f.ticket.id).length, 1);
});

test('restart during expression retries only the same pending expression record', async t => {
  const f = await storedResult(t);
  const [pending] = f.database.claimOutbox('expression');
  f.reopen();
  const [retry] = f.database.claimOutbox('restart', { now: Date.now() + 61000 });
  assert.equal(retry.id, pending.id);
  assert.equal(retry.payload.replyState, 'pending');
  assert.equal(f.database.results(f.ticket.id).length, 1);
  assert.equal(f.database.getTicket(f.ticket.id).status, 'completed');
});

test('interrupted execution asks for user continuation without promising effect verification', () => {
  for (const code of ['EXECUTION_UNAVAILABLE', 'EXECUTION_EFFECTS_UNKNOWN']) {
    const delivery = systemStateDelivery({ state: 'continuation_wait', code });
    assert.match(delivery.text, /执行已中断，尚未完成/);
    assert.match(delivery.text, /等待用户续接/);
    assert.doesNotMatch(delivery.text, /效果待核实|自动恢复|自动核查/);
    assert.equal(validateDelivery(delivery).systemState.code, code);
  }
});
