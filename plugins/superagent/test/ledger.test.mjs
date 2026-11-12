import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantLedger } from '../src/ledger.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-ledger-'));
  const store = createAssistantLedger({ directory });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store };
}
test('FTS5 retrieves Chinese original text and index rebuild preserves it', async t => {
  const { store } = await fixture(t);
  const original = '主人说：飞书连接需保存原文，预算 123.45 元。';
  store.append({ id: 't1', kind: 'trigger', sourceKey: 'feishu:e1', content: original });
  assert.equal(store.search('飞书连接')[0].content, original);
  assert.equal(store.search('123.45')[0].id, 't1');
  assert.deepEqual(store.search('没有这个词'), []);
  store.rebuildIndex();
  assert.equal(store.search('保存原文')[0].content, original);
});
test('records are immutable and links cannot dangle; append is atomic', async t => {
  const { store } = await fixture(t);
  const input = { id: 't1', kind: 'trigger', sourceKey: 'e1', content: '原文' };
  assert.equal(store.append(input).duplicate, false);
  assert.equal(store.append(input).duplicate, true);
  assert.throws(() => store.append({ ...input, content: '改写' }), { code: 'LEDGER_CONFLICT' });
  assert.throws(() => store.append({ ...input, id: 't2', sourceKey: 'e2' }, [{ id: 'missing', relation: 'ticket' }]), { code: 'LEDGER_NOT_FOUND' });
  assert.throws(() => store.read('t2'), { code: 'LEDGER_NOT_FOUND' });
  store.append({ id: 'ticket1', kind: 'ticket', sourceKey: 'ticket1', content: '任务' }, [{ id: 't1', relation: 'source' }]);
  assert.equal(store.related('t1')[0].fromId, 'ticket1');
});
test('long original is losslessly paged including emoji', async t => {
  const { store } = await fixture(t);
  const content = '前😀后'.repeat(100);
  store.append({ id: 'long', kind: 'trigger', sourceKey: 'long', content });
  let cursor = 0, rebuilt = '';
  do { const page = store.read('long', { cursor, limit: 7 }); rebuilt += page.content; cursor = page.nextCursor; assert.equal(page.fullLength, 300); assert.equal(page.complete, false); } while (cursor !== null);
  assert.equal(rebuilt, content);
  assert.equal(store.read('long').complete, true);
});

test('business source filter applies before result limit', async t => {
  const { store } = await fixture(t);
  store.append({ id: 'first', kind: 'trigger', sourceKey: 'first', content: '共同查询', metadata: { sessionId: 'first' } });
  store.append({ id: 'second', kind: 'trigger', sourceKey: 'second', content: '共同查询第二会话', metadata: { sessionId: 'second' } });
  const hits = store.search('共同查询', { sessionId: 'second', limit: 1 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].metadata.sessionId, 'second');
  assert.deepEqual(store.search('共同查询', { sessionId: 'missing' }), []);
});
