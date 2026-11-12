import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resultDelivery, resultOutbox, validateDelivery, deliverySuppression, systemStateDelivery } from '../src/result-delivery.mjs';
import { commitWorkerResult } from '../src/result-commit.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';

const ticket = { id: 't', title: '原任务', target: '完整要求', instructionRevision: 2, resultVersion: 0, mandate: { source: { channel: 'desktop', sessionId: 'owner' } } };
const result = { summary: '备用摘要', finalSummary: '  原正文\n\n保留段落与结尾。\n', selfCheck: { summary: '已按要求核对文本，零文件' }, outcome: 'completed', evidenceRefs: [] };

test('Worker body is retained as evidence while outbox only signals completion to Router', () => {
  const delivery = resultDelivery({ ticket, result });
  assert.equal(delivery.text, result.finalSummary);
  assert.equal(delivery.origin, 'worker');
  assert.deepEqual(resultOutbox({ ticket, result, delivery }), { type: 'ticket.result', ticketId: 't', title: '原任务', source: ticket.mandate.source,
    instructionRevision: 2, resultVersion: 1, outcome: 'completed', replyState: 'pending', evidenceRefs: [] });
  assert.equal(validateDelivery({ ...delivery, text: 'x'.repeat(20000) }).text.length, 20000);
});

test('self-check is a record from the Worker and never another model verdict', () => {
  let committed;
  const database = { commitResult: (id, input) => (committed = { id, ...input }) };
  commitWorkerResult({ database, ticket, result, uniqueKey: 'result' });
  assert.equal(committed.status, 'completed');
  assert.deepEqual(committed.result.selfCheck, result.selfCheck);
  assert.equal(committed.result.finalSummary, result.finalSummary);
  assert.equal(committed.result.delivery.text, result.finalSummary);
  assert.equal(committed.outboxPayload.text, undefined);
  assert.equal(committed.outboxPayload.publication, undefined);
  assert(!JSON.stringify(committed.outboxPayload).includes(result.finalSummary));
  assert.equal(committed.result.review, undefined);
  assert.equal(commitWorkerResult({ database, ticket, result: { ...result, selfCheck: undefined } }).result.selfCheck, undefined);
  assert.throws(() => commitWorkerResult({ database, ticket, result: { ...result, selfCheckRevision: 1 } }), { code: 'INSTRUCTION_REVISION_CONFLICT' });
});

test('structural failure needs attempts, cause and changed conditions; legacy effect metadata adds no review gate', () => {
  const database = { commitResult: (_id, input) => input };
  assert.throws(() => commitWorkerResult({ database, ticket, result: { ...result, outcome: 'failed' } }), /Structural failure/);
  const failure = { attempted: '查询两项来源', cause: '数据已永久删除', resumeConditions: '恢复原始数据后可继续' };
  const saved = commitWorkerResult({ database, ticket, result: { ...result, outcome: 'failed', failure } });
  assert.equal(saved.outboxPayload.outcome, 'failed');
  assert.equal(saved.status, 'waiting');
  const legacy = commitWorkerResult({ database, ticket, result: { ...result, executionEffects: { effectsVerified: false } } });
  assert.equal(legacy.status, 'completed');
});

test('superseded requirements and sources are suppressed rather than delivered', () => {
  const row = { ticketId: 't', payload: resultOutbox({ ticket, result, delivery: resultDelivery({ ticket, result }) }) };
  const database = { getTicket: () => ({ ...ticket, resultVersion: 1 }) };
  assert.equal(deliverySuppression(database, row), null);
  assert.equal(deliverySuppression({ getTicket: () => ({ ...ticket, resultVersion: 1, instructionRevision: 3 }) }, row), 'superseded-instruction');
  assert.equal(deliverySuppression(database, { ...row, payload: { ...row.payload, source: { channel: 'other' } } }), 'source-mismatch');
});

async function storedResult(t, { legacy = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-router-result-'));
  let database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'main', source: { type: 'desktop', id: 'owner' } });
  const current = database.createTicket({ threadId: 'main', target: 'original request', mandate: ticket.mandate });
  const draft = { ...result, instructionRevision: 1 };
  const publication = resultDelivery({ ticket: current, result: draft });
  const committed = legacy ? database.commitResult(current.id, { uniqueKey: 'worker-result', result: draft,
    outboxPayload: { type: 'ticket.result', ticketId: current.id, source: current.mandate.source,
      instructionRevision: 1, resultVersion: 1, outcome: 'completed', publication, text: publication.text } })
    : commitWorkerResult({ database, ticket: current, result: draft, uniqueKey: 'worker-result' });
  return { get database() { return database; }, ticket: current, committed, filename: database.path,
    reopen() { database.close(); database = createAssistantOrchestrationStore({ directory }); } };
}

for (const receipt of [{ status: 'suppressed', reason: 'superseded' }, { status: 'accepted' }, { status: 'accepted', messageId: 'source-receipt' }]) {
  test(`execution completion is independent from a persisted Router reply (${receipt.status}/${Boolean(receipt.messageId)})`, async t => {
    const f = await storedResult(t);
    const [pending] = f.database.claimOutbox('sender');
    f.database.finishOutbox(pending.id, { owner: 'sender', sent: true, receipt });
    assert.equal(f.database.getTicket(f.ticket.id).status, 'completed');
    assert.equal(f.database.results(f.ticket.id)[0].finalSummary, result.finalSummary);
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

for (const state of ['queued', 'sent', 'uncertain']) test(`legacy Worker outbox migration preserves identity and never replays ${state} history`, async t => {
  const f = await storedResult(t, { legacy: true });
  const raw = new DatabaseSync(f.filename);
  raw.prepare('UPDATE sa_outbox SET state=? WHERE id=?').run(state, f.committed.outbox.id);
  const original = raw.prepare('SELECT payload FROM sa_outbox WHERE id=?').get(f.committed.outbox.id).payload;
  raw.close();
  f.reopen();
  const claimed = f.database.claimOutbox('migration');
  if (state === 'queued') {
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, f.committed.outbox.id);
    assert.equal(claimed[0].uniqueKey, 'worker-result');
    assert.equal(claimed[0].payload.replyState, 'pending');
    assert.equal(claimed[0].payload.text, undefined);
    assert.equal(claimed[0].payload.publication, undefined);
  } else {
    assert.deepEqual(claimed, []);
    assert.equal(JSON.stringify(f.database.deliveries(f.ticket.id)[0].payload), original);
  }
  assert.equal(f.database.results(f.ticket.id)[0].finalSummary, result.finalSummary);
});

for (const ready of [false, true]) test(`historical review retirement preserves the current ${ready ? 'Router reply' : 'pending completion signal'}`, async t => {
  const f = await storedResult(t);
  if (ready) {
    const [pending] = f.database.claimOutbox('sender');
    f.database.saveOutboxReply(pending.id, { owner: 'sender',
      publication: { action: 'deliver', origin: 'router', text: '已经整理好结果。' } });
    f.database.finishOutbox(pending.id, { owner: 'sender', error: 'not-sent', retryMs: 0 });
  }
  const raw = new DatabaseSync(f.filename);
  raw.prepare("DELETE FROM sa_migrations WHERE id='worker-direct-delivery-v1'").run();
  raw.close();
  f.reopen();
  const [delivery] = f.database.claimOutbox('after-migration');
  assert.equal(delivery.id, f.committed.outbox.id);
  assert.equal(delivery.payload.replyState, ready ? 'ready' : 'pending');
  assert.equal(delivery.payload.text, ready ? '已经整理好结果。' : undefined);
  assert.equal(f.database.getTicket(f.ticket.id).status, 'completed');
  assert.equal(f.database.results(f.ticket.id)[0].finalSummary, result.finalSummary);
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
