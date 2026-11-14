import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTaskCleanupContinuationStore } from '../src/task-cleanup-continuation-store.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  t.after(() => db.close());
  const source = { sessionId: 'owner', threadId: 'main', messageId: 'human-1', excerpt: '停止这两项，然后归档' };
  const item = id => ({ id, instructionRevision: 1, resultVersion: 0, metaVersion: 2 });
  const input = { requestId: 'request', source, triggerId: 'trigger', items: [item('one'), item('two')] };
  return { db, transaction, input, item, store: installTaskCleanupContinuationStore({ db, transaction }) };
}

test('cleanup intentions persist exact targets, versions and original source on the same connection', t => {
  const f = fixture(t);
  const first = f.store.prepare(f.input);
  assert.equal(first.items.length, 2);
  assert.equal(first.items[0].taskId, 'one');
  assert.equal(first.items[0].instructionRevision, 1);
  assert.equal(first.items[0].metaVersion, 2);
  assert.deepEqual(first.items[0].source, f.input.source);
  assert.deepEqual(f.store.prepare({ ...f.input, items: [...f.input.items].reverse() }), first, 'input ordering does not change exact target binding');
  const reopened = installTaskCleanupContinuationStore({ db: f.db, transaction: f.transaction });
  assert.deepEqual(reopened.prepare(f.input), first);
  f.input.source.excerpt = 'changed outside the store';
  assert.notEqual(reopened.pending()[0].source.excerpt, f.input.source.excerpt, 'caller mutations cannot rewrite durable evidence');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='sa_tasks'").get().count, 0,
    'organization intent storage never creates or mutates execution tasks');
});

test('idempotency rejects changed scope, expected versions, trigger and original human source', t => {
  const f = fixture(t); f.store.prepare(f.input);
  for (const change of [
    { items: [f.item('one')] }, { items: [f.item('one'), f.item('three')] },
    { items: [f.item('one'), { ...f.item('two'), metaVersion: 3 }] },
    { triggerId: 'other-trigger' }, { source: { ...f.input.source, messageId: 'human-2' } },
  ]) assert.throws(() => f.store.prepare({ ...f.input, ...change }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(f.store.pending().length, 2);
});

test('execution stamps persist and participate in exact intent idempotency without breaking legacy rows', t => {
  const f = fixture(t), executionStamp = 'a'.repeat(64);
  const input = { ...f.input, items: f.input.items.map(item => ({ ...item, executionStamp })) };
  const first = f.store.prepare(input);
  const reopened = installTaskCleanupContinuationStore({ db: f.db, transaction: f.transaction });
  assert.equal(first.items[0].executionStamp, executionStamp);
  assert.equal(reopened.pending()[0].executionStamp, executionStamp);
  assert.deepEqual(reopened.byRequest(input.requestId), first);
  assert.deepEqual(reopened.prepare(input), first);
  assert.throws(() => reopened.prepare({ ...input, items: input.items.map(item => ({ ...item, executionStamp: 'b'.repeat(64) })) }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => reopened.prepare(f.input), { code: 'IDEMPOTENCY_CONFLICT' });
  const legacy = reopened.prepare({ ...f.input, requestId: 'legacy-request' });
  assert.equal(Object.hasOwn(legacy.items[0], 'executionStamp'), false);
});

test('pending intent and terminal receipts survive closing and reopening the database', t => {
  const directory = mkdtempSync(join(tmpdir(), 'benchgo-cleanup-intent-store-'));
  const filename = join(directory, 'assistant.db');
  let db = new DatabaseSync(filename);
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  let store = installTaskCleanupContinuationStore({ db, transaction });
  const input = { requestId: 'durable-request', triggerId: 'durable-trigger',
    source: { sessionId: 'owner', threadId: 'main', messageId: 'human-input', excerpt: '停止并归档' },
    items: [{ id: 'one', instructionRevision: 1, resultVersion: 0, metaVersion: 0 }, { id: 'two', instructionRevision: 1, resultVersion: 0, metaVersion: 0 }] };
  const prepared = store.prepare(input);
  const saved = store.finish(prepared.items[0].id, { status: 'completed', receiptId: 'archive-receipt' });
  db.close(); db = new DatabaseSync(filename); store = installTaskCleanupContinuationStore({ db, transaction });
  assert.deepEqual(store.pending().map(row => row.taskId), ['two']);
  assert.deepEqual(store.list({ taskId: 'one' }).items, [saved]);
  assert.equal(store.prepare(input).operationId, prepared.operationId);
  assert.equal(store.prepare(input).items.length, 2);
  const [notice] = store.pendingNoticeBatches();
  assert.deepEqual(notice.items.map(row => row.receiptId), ['archive-receipt']);
  store.markNoticeBatchNotified(notice.batchId);
  const notified = store.get(saved.id);
  db.close(); db = new DatabaseSync(filename); store = installTaskCleanupContinuationStore({ db, transaction });
  assert.deepEqual(store.get(saved.id), notified);
  assert.deepEqual(store.pendingNoticeBatches(), [], 'a successfully admitted notice remains acknowledged after restart');
});

test('finish is a terminal CAS with durable receipt replay and no overwrite', t => {
  const f = fixture(t), prepared = f.store.prepare(f.input), item = prepared.items[0];
  const patch = { status: 'completed', receiptId: 'real-archive-receipt' };
  const completed = f.store.finish(item.id, patch);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(f.store.finish(item.id, patch), completed);
  assert.throws(() => f.store.finish(item.id, { status: 'cancelled' }), { code: 'CLEANUP_CONTINUATION_CONFLICT' });
  assert.throws(() => f.store.finish(item.id, { status: 'completed', receiptId: 'different-receipt' }), { code: 'CLEANUP_CONTINUATION_CONFLICT' });
  assert.throws(() => f.store.finish(prepared.items[1].id, { status: 'completed' }), { code: 'CLEANUP_CONTINUATION_INPUT' });
  assert.throws(() => f.store.finish(prepared.items[1].id, { status: 'conflict', taskId: 'replacement' }), { code: 'CLEANUP_CONTINUATION_INPUT' });
  assert.deepEqual(f.store.pending().map(row => row.taskId), ['two']);
});

test('cancel affects only its exact pending task subset and retains settled receipts', t => {
  const f = fixture(t), plan = f.store.prepare({ ...f.input, items: [f.item('one'), f.item('two'), f.item('three')] });
  const finished = plan.items.find(row => row.taskId === 'three');
  f.store.finish(finished.id, { status: 'completed', receiptId: 'saved' });
  assert.throws(() => f.store.cancel({ operationId: plan.operationId, ids: ['one', 'missing'] }), { code: 'CLEANUP_CONTINUATION_INPUT' });
  assert.equal(f.store.pending().length, 2, 'invalid cancellation is atomic');
  const cancelled = f.store.cancel({ operationId: plan.operationId, ids: ['one', 'three'] });
  assert.equal(cancelled.cancelledCount, 1);
  assert.deepEqual(cancelled.counts, { pending: 1, completed: 1, cancelled: 1, conflict: 0 });
  assert.equal(cancelled.items.find(row => row.taskId === 'three').receiptId, 'saved');
  assert.equal(f.store.cancel({ operationId: plan.operationId, ids: ['one'] }).cancelledCount, 0);
  assert.equal(f.store.cancel({ operationId: plan.operationId }).cancelledCount, 1);
  assert.equal(f.store.pending().length, 0);
  assert.equal(f.store.list({ operationId: plan.operationId }).items.length, 3, 'cancel keeps original evidence');
});

test('list and pending reads are bounded, independently filtered and reloadable', t => {
  const f = fixture(t);
  const plan = f.store.prepare({ ...f.input, items: Array.from({ length: 65 }, (_, index) => f.item(`task-${String(index).padStart(3, '0')}`)) });
  const pages = [];
  let offset = 0;
  do { const page = f.store.list({ operationId: plan.operationId, offset, limit: 7 }); pages.push(...page.items); offset = page.nextOffset; } while (offset !== null);
  assert.equal(pages.length, 65); assert.equal(new Set(pages.map(row => row.id)).size, 65);
  assert.equal(f.store.pending({ limit: 3 }).length, 3);
  const result = f.store.cancel({ operationId: plan.operationId });
  assert.equal(result.items.length, 50); assert.equal(result.nextOffset, 50); assert.equal(result.counts.cancelled, 65);
  assert.equal(f.store.list({ taskId: 'task-003', status: 'cancelled' }).items.length, 1);
  assert.equal(f.store.list({ taskId: 'task-003', status: 'pending' }).items.length, 0);
});

test('invalid identities, versions, duplicate scopes and unknown state cannot enter the queue', t => {
  const f = fixture(t);
  for (const change of [
    { requestId: '' }, { triggerId: '' }, { source: { ...f.input.source, actor: 'forged' } },
    { items: [f.item('one'), f.item('one')] }, { items: [{ ...f.item('one'), status: 'completed' }] },
    { items: [{ ...f.item('one'), instructionRevision: 0 }] }, { items: [{ ...f.item('one'), resultVersion: -1 }] },
    ...['a'.repeat(63), 'g'.repeat(64), null, 42].map(executionStamp => ({ items: [{ ...f.item('one'), executionStamp }] })),
  ]) assert.throws(() => f.store.prepare({ ...f.input, ...change }), { code: 'CLEANUP_CONTINUATION_INPUT' });
  assert.throws(() => f.store.list({ status: 'running' }), { code: 'CLEANUP_CONTINUATION_INPUT' });
  assert.throws(() => f.store.pending({ limit: 1001 }), { code: 'CLEANUP_CONTINUATION_INPUT' });
  assert.throws(() => f.store.list({ offset: -1 }), { code: 'CLEANUP_CONTINUATION_INPUT' });
  assert.equal(f.store.list().items.length, 0);
});

test('pending uses stable keyset reads without rewriting last activity or starving later tasks', t => {
  const f = fixture(t);
  const batch = f.store.prepare({ ...f.input, items: Array.from({ length: 23 }, (_, index) => f.item(`task-${index}`)) });
  const seen = [];
  let after;
  while (true) {
    const page = f.store.pending({ limit: 4, after });
    if (!page.length) break;
    seen.push(...page); after = page.at(-1).id;
  }
  assert.equal(seen.length, 23); assert.equal(new Set(seen.map(row => row.id)).size, 23);
  assert.deepEqual(seen.map(row => row.id), [...seen.map(row => row.id)].sort());
  assert.deepEqual(new Set(seen.map(row => row.updatedAt)), new Set([batch.items[0].updatedAt]));
  assert.deepEqual(f.store.byRequest('request'), batch);
  assert.equal(f.store.byRequest('unknown'), null);
});

test('result notices retain retry state across reinstall and mark only terminal outcomes once', t => {
  const f = fixture(t), batch = f.store.prepare(f.input);
  const completed = batch.items[0], pending = batch.items[1];
  assert.deepEqual(f.store.pendingNoticeBatches(), [], 'pending items have no notice batch to acknowledge');
  f.store.finish(completed.id, { status: 'completed', receiptId: 'durable-receipt' });
  const [notice] = f.store.pendingNoticeBatches();
  assert.deepEqual(notice.items.map(row => row.id), [completed.id]);
  const reinstalled = installTaskCleanupContinuationStore({ db: f.db, transaction: f.transaction });
  assert.deepEqual(reinstalled.pendingNoticeBatches(), [notice], 'a failed enqueue remains retryable');
  reinstalled.markNoticeBatchNotified(notice.batchId);
  const marked = reinstalled.get(completed.id);
  assert.ok(marked.notifiedAt);
  assert.deepEqual(reinstalled.markNoticeBatchNotified(notice.batchId), notice);
  assert.equal(reinstalled.pendingNoticeBatches().length, 0);
  assert.deepEqual(reinstalled.get(completed.id), marked);
  assert.deepEqual(reinstalled.byRequest('request').items.find(row => row.id === completed.id), marked);
  reinstalled.cancel({ operationId: batch.operationId, ids: [pending.taskId] });
  assert.equal(reinstalled.pendingNoticeBatches().length, 0, 'explicit cancellation already returns its receipt');
  assert.ok(reinstalled.get(pending.id).notifiedAt);
});

test('notice retry freezes exact members before delivery and never absorbs a later terminal result', t => {
  const f = fixture(t), operation = f.store.prepare(f.input);
  const [first, second] = operation.items;
  f.store.finish(first.id, { status: 'completed', receiptId: 'first-receipt' });
  const original = f.store.pendingNoticeBatches();
  assert.equal(original.length, 1);
  assert.equal(original[0].operationId, operation.operationId);
  assert.deepEqual(original[0].items.map(item => item.id), [first.id]);
  f.store.finish(second.id, { status: 'conflict', code: 'LATER_CONFLICT' });
  assert.deepEqual(f.store.pendingNoticeBatches(), original, 'a lost inbox response must retry the original event members');
  assert.deepEqual(f.store.pendingNoticeBatches({ limit: 1 }), original);
  assert.deepEqual(f.store.markNoticeBatchNotified(original[0].batchId), original[0]);
  assert.deepEqual(f.store.markNoticeBatchNotified(original[0].batchId), original[0], 'whole-batch acknowledgement replays safely');
  const next = f.store.pendingNoticeBatches();
  assert.equal(next.length, 1); assert.notEqual(next[0].batchId, original[0].batchId);
  assert.deepEqual(next[0].items.map(item => item.id), [second.id]);
  assert.equal(f.store.get(second.id).notifiedAt, undefined);
});

test('notice batches cap each operation fragment at fifty and retry complete frozen batches within the read budget', t => {
  const f = fixture(t), operation = f.store.prepare({ ...f.input,
    items: Array.from({ length: 121 }, (_, index) => f.item(`task-${String(index).padStart(3, '0')}`)) });
  for (const item of operation.items) f.store.finish(item.id, { status: 'conflict', code: 'CHANGED' });
  const batches = f.store.pendingNoticeBatches({ limit: 121 });
  assert.deepEqual(batches.map(batch => batch.items.length), [50, 50, 21]);
  assert.equal(new Set(batches.flatMap(batch => batch.items.map(item => item.id))).size, 121);
  const retried = f.store.pendingNoticeBatches({ limit: 1 });
  assert.equal(retried.length, 1);
  assert(retried[0].items.length <= 50);
  assert.deepEqual(retried[0], batches.find(batch => batch.batchId === retried[0].batchId), 'a smaller retry budget cannot split frozen membership');
  const retryId = retried[0].batchId;
  assert(retried[0].items.every(item => f.store.get(item.id).notifiedAt === undefined));
  f.store.markNoticeBatchNotified(retryId);
  assert(retried[0].items.every(item => f.store.get(item.id).notifiedAt));
  assert.equal(f.store.pendingNoticeBatches({ limit: 1000 }).some(batch => batch.batchId === retryId), false);
});

test('whole-batch acknowledgement rolls back every member when any notification update fails', t => {
  const f = fixture(t), operation = f.store.prepare(f.input);
  for (const item of operation.items) f.store.finish(item.id, { status: 'completed', receiptId: `receipt:${item.taskId}` });
  const [batch] = f.store.pendingNoticeBatches();
  f.db.exec(`CREATE TRIGGER reject_notice_ack BEFORE UPDATE OF notified_at ON task_cleanup_continuations
    WHEN NEW.task_id='two' BEGIN SELECT RAISE(ABORT,'ack unavailable'); END;`);
  assert.throws(() => f.store.markNoticeBatchNotified(batch.batchId), /ack unavailable/u);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM task_cleanup_continuations WHERE notified_at IS NOT NULL').get().count, 0);
  assert.deepEqual(f.store.pendingNoticeBatches(), [batch]);
  f.db.exec('DROP TRIGGER reject_notice_ack');
  f.store.markNoticeBatchNotified(batch.batchId);
  assert.equal(f.db.prepare('SELECT COUNT(DISTINCT notified_at) AS count FROM task_cleanup_continuations').get().count, 1);
  assert.deepEqual(f.store.pendingNoticeBatches(), []);
  assert.throws(() => f.store.markNoticeBatchNotified('missing'), { code: 'CLEANUP_CONTINUATION_NOT_FOUND' });
});

test('legacy schema upgrades in place and frozen notification membership survives closing the database', t => {
  const directory = mkdtempSync(join(tmpdir(), 'benchgo-cleanup-notice-migration-'));
  const filename = join(directory, 'assistant.db');
  let db = new DatabaseSync(filename);
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE task_cleanup_continuations(id TEXT PRIMARY KEY, operation_id TEXT NOT NULL,
    request_id TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
    updated_at TEXT NOT NULL, UNIQUE(request_id,task_id));`);
  const payload = { id: 'legacy-item', operationId: 'legacy-operation', requestId: 'legacy-request', taskId: 'legacy-task',
    status: 'completed', receiptId: 'legacy-receipt', updatedAt: '2026-11-01T00:00:00Z' };
  db.prepare('INSERT INTO task_cleanup_continuations VALUES (?,?,?,?,?,?,?)')
    .run(payload.id, payload.operationId, payload.requestId, payload.taskId, payload.status, JSON.stringify(payload), payload.updatedAt);
  let store = installTaskCleanupContinuationStore({ db, transaction });
  const names = db.prepare('PRAGMA table_info(task_cleanup_continuations)').all().map(column => column.name);
  assert(names.includes('notified_at')); assert(names.includes('notice_batch_id'));
  const [batch] = store.pendingNoticeBatches();
  assert.deepEqual(batch.items, [payload]);
  db.close(); db = new DatabaseSync(filename); store = installTaskCleanupContinuationStore({ db, transaction });
  assert.deepEqual(store.pendingNoticeBatches(), [batch], 'reinstall must preserve exact membership before delivery acknowledgement');
  store.markNoticeBatchNotified(batch.batchId);
  db.close(); db = new DatabaseSync(filename); store = installTaskCleanupContinuationStore({ db, transaction });
  assert.deepEqual(store.pendingNoticeBatches(), []);
  assert.ok(store.get(payload.id).notifiedAt);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='task_cleanup_continuation_notice_batch' AND sql LIKE '%WHERE notice_batch_id IS NOT NULL%'").get().count, 1);
});
