import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';

async function fixture(t, receipt) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-outbox-reconcile-'));
  let db = createAssistantOrchestrationStore({ directory });
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  db.createThread({ id: 'main', source: { type: 'desktop', id: 'main' } });
  const ticket = db.createTicket({ threadId: 'main', target: 'saved task', mandate: { source: { channel: 'desktop', sessionId: 'main' } } });
  const commit = now => db.commitResult(ticket.id, { result: { summary: 'done', outcome: 'completed', selfCheck: { summary: 'checked current requirements' } }, uniqueKey: 'result', now });
  commit(10);
  const [delivery] = db.claimOutbox('sender', { now: 11 });
  db.finishOutbox(delivery.id, { owner: 'sender', uncertain: true, receipt, now: 12 });
  return { get db() { return db; }, delivery, ticket, commit,
    reopen() { db.close(); db = createAssistantOrchestrationStore({ directory }); } };
}

test('unknown delivery remains parked across restart; verified sent never repeats execution', async t => {
  const f = await fixture(t);
  assert.equal(f.db.getTicket(f.ticket.id).status, 'waiting', 'a saved result and unknown send cannot close its Ticket');
  assert.deepEqual(f.db.claimOutbox('retry', { now: 100000 }), []);
  const request = { attempts: 1, outcome: 'unknown', evidence: '平台尚未返回查询结果', now: 20 };
  assert.equal(f.db.reconcileOutbox(f.delivery.id, request).state, 'uncertain');
  f.reopen();
  assert.equal(f.db.deliveries(f.ticket.id)[0].reconciliations[0].outcome, 'unknown');
  assert.equal(f.commit(25).duplicate, true);
  assert.equal(f.db.getTicket(f.ticket.id).status, 'waiting', 'an idempotent commit does not replace the delivery receipt');
  const completed = f.db.reconcileOutbox(f.delivery.id, { ...request, outcome: 'sent',
    evidence: '平台消息查询已找到原请求', receipt: { status: 'accepted', messageId: 'opaque/platform:1' }, now: 30 });
  assert.equal(completed.state, 'sent');
  assert.equal(completed.receipt.messageId, 'opaque/platform:1');
  assert.equal(f.db.getTicket(f.ticket.id).status, 'completed');
  assert.equal(f.db.results(f.ticket.id).length, 1);
  assert.deepEqual(f.db.claimOutbox('retry', { now: 100000 }), []);
  assert.throws(() => f.db.reconcileOutbox(f.delivery.id, request), { code: 'OUTBOX_RECONCILIATION_CONFLICT' });
});

test('only verified not_sent requeues the same delivery; stale attempt cannot overwrite it', async t => {
  const f = await fixture(t);
  assert.throws(() => f.db.reconcileOutbox(f.delivery.id, { attempts: 2, outcome: 'not_sent', evidence: 'checked' }), { code: 'OUTBOX_RECONCILIATION_CONFLICT' });
  assert.throws(() => f.db.reconcileOutbox(f.delivery.id, { attempts: 1, outcome: 'sent', evidence: 'checked' }), { code: 'INVALID_RECONCILIATION' });
  assert.throws(() => f.db.reconcileOutbox(f.delivery.id, { attempts: 1, outcome: 'not_sent', evidence: '' }), { code: 'INVALID_RECONCILIATION' });
  f.db.reconcileOutbox(f.delivery.id, { attempts: 1, outcome: 'not_sent', evidence: '供应商查询确认请求未发送', now: 20 });
  const [again] = f.db.claimOutbox('sender2', { now: 21 });
  assert.equal(again.id, f.delivery.id);
  assert.equal(again.attempts, 2);
  f.db.finishOutbox(again.id, { owner: 'sender2', uncertain: true, now: 22 });
  assert.throws(() => f.db.reconcileOutbox(again.id, { attempts: 1, outcome: 'not_sent', evidence: 'stale' }), { code: 'OUTBOX_RECONCILIATION_CONFLICT' });
  assert.equal(f.db.results(f.ticket.id).length, 1);
});

test('known delivered parts prohibit replay of the whole message and survive verification', async t => {
  const part = { status: 'accepted', messageId: 'part-1' };
  const f = await fixture(t, { status: 'unknown', parts: [part] });
  assert.throws(() => f.db.reconcileOutbox(f.delivery.id, { attempts: 1, outcome: 'not_sent', evidence: 'second part missing' }), { code: 'OUTBOX_RECONCILIATION_CONFLICT' });
  const saved = f.db.reconcileOutbox(f.delivery.id, { attempts: 1, outcome: 'sent', evidence: 'all parts found', receipt: { status: 'accepted', messageId: 'final' } });
  assert.deepEqual(saved.receipt.parts, [part]);
});
