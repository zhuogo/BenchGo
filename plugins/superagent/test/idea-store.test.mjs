import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdeaStore } from '../src/idea-store.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'benchgo-ideas-'));
  let clock = Date.parse('2026-11-13T00:00:00Z');
  const stores = [], open = () => { const result = createIdeaStore({ directory, now: () => clock }); stores.push(result); return result; };
  t.after(() => { for (const store of stores) store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store: open(), open, advance(days) { clock += days * 86400000; } };
}
const input = { title: '整理设计交接', content: '根据明确资料，建议可选地准备交接清单。', memoryIds: ['memory:1'],
  source: { role: 'assistant', references: [{ role: 'user', sessionId: 's', messageId: 'm' }] }, expiresAt: '2026-11-20T00:00:00Z', idempotencyKey: 'batch:1:idea:0' };

test('ideas persist in assistant.db, deduplicate retries and expire without creating work', t => {
  const f = fixture(t), saved = f.store.propose(input);
  assert.equal(saved.status, 'pending');
  assert.equal(f.open().propose({ ...input, title: '重试改写' }).id, saved.id);
  assert.equal(f.store.propose({ ...input, idempotencyKey: 'other' }).id, saved.id);
  assert.equal(f.store.list().length, 1);
  f.advance(8);
  assert.equal(f.store.list().length, 0);
  assert.equal(f.store.list({ status: 'expired' })[0].id, saved.id);
});
test('dismissal and source correction survive retries and remove derived prose from all statuses', t => {
  const f = fixture(t), saved = f.store.propose(input);
  f.store.dismiss(saved.id);
  assert.equal(f.store.propose(input).status, 'dismissed');
  assert.deepEqual(f.store.invalidate({ references: [{ sessionId: 's', messageId: 'm' }] }).ids, [saved.id]);
  const erased = f.open().list({ status: 'all' })[0];
  assert.equal(erased.status, 'invalidated');
  assert.equal(erased.content, '');
  assert.deepEqual(erased.source, {});
  assert.equal(f.store.propose({ ...input, title: '换词恢复', idempotencyKey: 'new' }).status, 'invalidated');
});
test('forgotten memories invalidate dependent suggestions and prevent rephrased resurrection', t => {
  const f = fixture(t), saved = f.store.propose(input);
  assert.deepEqual(f.store.invalidate({ memoryIds: ['memory:1'] }).ids, [saved.id]);
  assert.equal(f.store.propose({ ...input, title: '另一措辞', idempotencyKey: 'next' }).status, 'invalidated');
  assert.equal(f.store.list().length, 0);
});
test('corrections allow new evidence for the same memory identity but reject the old source', t => {
  const f = fixture(t), saved = f.store.propose(input);
  f.store.invalidate({ kind: 'corrected', memoryIds: input.memoryIds, references: input.source.references });
  assert.equal(f.store.list({ status: 'all' }).find(row => row.id === saved.id).content, '');
  assert.equal(f.store.propose({ ...input, title: 'Reworded old evidence', idempotencyKey: 'old-evidence' }).status, 'invalidated');
  const updated = f.store.propose({ ...input, title: 'Current evidence', content: 'Suggestion based on the corrected fact',
    source: { references: [{ role: 'user', sessionId: 's', messageId: 'corrected-message' }] }, idempotencyKey: 'new-evidence' });
  assert.equal(updated.status, 'pending');
  assert.deepEqual(updated.memoryIds, input.memoryIds);
});
test('unbound, excessive and already expired candidates are rejected', t => {
  const f = fixture(t);
  for (const value of [{ ...input, memoryIds: [], source: {} }, { ...input, title: 'x'.repeat(121) }, { ...input, expiresAt: '2026-11-12T00:00:00Z' }]) assert.throws(() => f.store.propose(value), /来源|有效期/);
  assert.equal(f.store.list().length, 0);
});
