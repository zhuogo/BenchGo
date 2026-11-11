import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAssistantLedger } from '../src/ledger.mjs';

async function fixture(t, seed) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-ledger-'));
  seed?.(directory);
  let store = createAssistantLedger({ directory });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, get store() { return store; }, reopen() { store.close(); store = createAssistantLedger({ directory }); return store; } };
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
function seedLegacy(directory) {
  const db = new DatabaseSync(join(directory, 'ledger.db'));
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE ledger_records(id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_key TEXT UNIQUE NOT NULL, content TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE ledger_fts USING fts5(id UNINDEXED, terms);
      CREATE TABLE ledger_links(from_id TEXT NOT NULL REFERENCES ledger_records(id), to_id TEXT NOT NULL REFERENCES ledger_records(id), relation TEXT NOT NULL, PRIMARY KEY(from_id,to_id,relation));
      CREATE TABLE ledger_watermarks(session_id TEXT PRIMARY KEY, event_seq INTEGER NOT NULL);`);
    const record = db.prepare('INSERT INTO ledger_records VALUES (?,?,?,?,?,?)');
    record.run('old-citation', 'session-event', '["harness","s1",12]', 'copied private transcript', JSON.stringify({ sessionId: 's1', eventSeq: 12, role: 'assistant', staleText: 'copied extra metadata' }), '2026-01-01T00:00:00.000Z');
    record.run('bad-citation', 'session-event', 'broken', 'stale inaccessible text', '{}', '2026-01-01T00:00:00.000Z');
    record.run('business', 'ticket', 'ticket:1', 'business evidence 😀', '{"ticketId":"ticket1"}', '2026-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO ledger_fts VALUES (?,?)').run('old-citation', 'copied private transcript');
    db.prepare('INSERT INTO ledger_fts VALUES (?,?)').run('bad-citation', 'stale inaccessible text');
    db.prepare('INSERT INTO ledger_fts VALUES (?,?)').run('business', 'business evidence');
    db.exec("INSERT INTO ledger_links VALUES ('business','old-citation','source'); INSERT INTO ledger_watermarks VALUES ('s1',12)");
  } finally { db.close(); }
}

test('legacy history migration removes copied text and FTS but preserves citations, business evidence and links', async t => {
  const f = await fixture(t, seedLegacy);
  assert.deepEqual(f.store.reference('old-citation'), { sessionId: 's1', seq: 12 });
  assert.equal(f.store.reference('business'), null);
  assert.throws(() => f.store.reference('missing'), { code: 'LEDGER_NOT_FOUND' });
  assert.throws(() => f.store.reference('bad-citation'), { code: 'LEDGER_REFERENCE_INVALID' });
  assert.throws(() => f.store.read('old-citation'), { code: 'LEDGER_SOURCE_REQUIRED' });
  assert.deepEqual(f.store.search('copied'), []);
  assert.deepEqual(f.store.search('stale'), []);
  assert.equal(f.store.search('business')[0].id, 'business');
  assert.equal(f.store.read('business').content, 'business evidence 😀');
  assert.deepEqual(f.store.related('old-citation').map(row => ({ ...row })), [{ fromId: 'business', toId: 'old-citation', relation: 'source' }]);
  const db = new DatabaseSync(join(f.directory, 'ledger.db'), { readOnly: true });
  try {
    const old = db.prepare('SELECT * FROM ledger_records WHERE id=?').get('old-citation');
    assert.equal(old.kind, 'session-reference');
    assert.equal(old.content, '');
    assert.deepEqual(JSON.parse(old.metadata), { sessionId: 's1', eventSeq: 12 });
    assert.equal(old.source_key, '["harness","s1",12]');
    assert.equal(old.created_at, '2026-01-01T00:00:00.000Z');
    assert.equal(db.prepare("SELECT count(*) AS count FROM ledger_fts WHERE id IN ('old-citation','bad-citation')").get().count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='ledger_watermarks'").get().count, 0);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    const business = db.prepare('SELECT * FROM ledger_records WHERE id=?').get('business');
    assert.deepEqual({ ...business }, { id: 'business', kind: 'ticket', source_key: 'ticket:1', content: 'business evidence 😀', metadata: '{"ticketId":"ticket1"}', created_at: '2026-01-01T00:00:00.000Z' });
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
  f.store.append({ id: 'new-business', kind: 'result', sourceKey: 'result:1', content: 'new result' }, [{ id: 'old-citation', relation: 'reference' }]);
  f.store.rebuildIndex();
  assert.deepEqual(f.store.search('copied'), []);
  assert.equal(f.store.search('business')[0].id, 'business');
  f.reopen();
  assert.deepEqual(f.store.reference('old-citation'), { sessionId: 's1', seq: 12 });
  assert.equal(f.store.read('new-business').content, 'new result');
  assert.equal(f.store.related('old-citation').length, 2);
});

test('history import cannot be reintroduced through ledger append or retired helpers', async t => {
  const { store } = await fixture(t);
  assert.equal(store.importSession, undefined);
  assert.equal(store.watermark, undefined);
  for (const kind of ['session-event', 'session-reference']) {
    assert.throws(() => store.append({ id: kind, kind, sourceKey: kind, content: 'history copy' }), { code: 'LEDGER_HISTORY_RETIRED' });
    assert.throws(() => store.read(kind), { code: 'LEDGER_NOT_FOUND' });
  }
  assert.deepEqual(store.search('history'), []);
});
