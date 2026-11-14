import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CLEANUP_PREVIEW_TTL_MS, initializeTaskCleanup, installTaskCleanupStore } from '../src/task-cleanup-store.mjs';

const scope = { owner: 'desktop-owner', mode: 'global' };
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let time = Date.parse('2026-11-14T00:00:00.000Z');
  const now = () => time;
  const transaction = fn => { db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const create = () => installTaskCleanupStore({ db, transaction, now });
  return { db, now, create, store: create(), advance: ms => { time += ms; } };
}

test('unconsumed archive previews expire exactly after 24 hours and reject reads and confirmation', t => {
  const f = fixture(t), preview = f.store.previewCleanup({ scope });
  assert.equal(Date.parse(preview.expiresAt) - Date.parse(preview.createdAt), CLEANUP_PREVIEW_TTL_MS);
  f.advance(CLEANUP_PREVIEW_TTL_MS - 1);
  assert.equal(f.store.getCleanupPreview(preview.previewId).previewId, preview.previewId);
  f.advance(1);
  assert.throws(() => f.store.getCleanupPreview(preview.previewId), { code: 'CLEANUP_PREVIEW_EXPIRED' });
  assert.throws(() => f.store.createConfirmation({ previewId: preview.previewId, manifestHash: preview.manifestHash,
    ids: ['one'], actorId: 'desktop-owner', source: { sessionId: 'owner', messageId: 'input' } }), { code: 'CLEANUP_PREVIEW_EXPIRED' });
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM task_cleanup_previews').get().count, 1, 'reads do not turn retention into a write');
});

test('new previews and store initialization collect only expired unconsumed previews', t => {
  const f = fixture(t);
  const expired = f.store.previewCleanup({ scope });
  const consumed = f.store.previewCleanup({ scope });
  f.db.prepare('UPDATE task_cleanup_previews SET consumed_by=? WHERE id=?').run('durable-receipt', consumed.previewId);
  const receipt = { receiptId: 'durable-receipt', operation: 'archive', items: [], previewId: consumed.previewId };
  f.db.prepare('INSERT INTO task_cleanup_receipts(id,request_id,binding,payload) VALUES (?,?,?,?)')
    .run(receipt.receiptId, 'request', 'binding', JSON.stringify(receipt));
  f.advance(CLEANUP_PREVIEW_TTL_MS);
  const fresh = f.store.previewCleanup({ scope });
  assert.throws(() => f.store.getCleanupPreview(expired.previewId), { code: 'CLEANUP_PREVIEW_NOT_FOUND' });
  assert.equal(f.store.getCleanupPreview(consumed.previewId).consumedBy, receipt.receiptId);
  assert.deepEqual(f.store.cleanupHistory({ receiptId: receipt.receiptId }), [receipt]);
  f.advance(CLEANUP_PREVIEW_TTL_MS);
  f.create();
  assert.throws(() => f.store.getCleanupPreview(fresh.previewId), { code: 'CLEANUP_PREVIEW_NOT_FOUND' });
  assert.equal(f.store.getCleanupPreview(consumed.previewId).consumedBy, receipt.receiptId);
  assert.deepEqual(f.store.cleanupHistory({ receiptId: receipt.receiptId }), [receipt]);
});

test('orchestration initialization collects legacy expired previews without new expiry fields', t => {
  const f = fixture(t);
  const preview = f.store.previewCleanup({ scope });
  const legacy = { ...preview }; delete legacy.expiresAt;
  f.db.prepare('UPDATE task_cleanup_previews SET payload=? WHERE id=?').run(JSON.stringify(legacy), preview.previewId);
  f.advance(CLEANUP_PREVIEW_TTL_MS - 1);
  assert.equal(f.store.getCleanupPreview(preview.previewId).expiresAt, preview.expiresAt);
  f.advance(1);
  initializeTaskCleanup({ db: f.db, now: f.now });
  assert.throws(() => f.store.getCleanupPreview(preview.previewId), { code: 'CLEANUP_PREVIEW_NOT_FOUND' });
  assert.ok(f.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='task_cleanup_preview_expiry'").get());
});

test('invalid preview inputs do not trigger collection or remove durable evidence', t => {
  const f = fixture(t), preview = f.store.previewCleanup({ scope });
  f.advance(CLEANUP_PREVIEW_TTL_MS);
  assert.throws(() => f.store.previewCleanup({ scope, ids: [] }), { code: 'CLEANUP_INPUT_INVALID' });
  assert.throws(() => f.store.previewRestore({ scope, receiptId: 'missing' }), { code: 'CLEANUP_RECEIPT_NOT_FOUND' });
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM task_cleanup_previews').get().count, 1);
});
