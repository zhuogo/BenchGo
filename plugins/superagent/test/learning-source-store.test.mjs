import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installLearningSourceStore } from '../src/learning-source-store.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE sa_tasks(id TEXT PRIMARY KEY,status TEXT,result_version INTEGER,instruction_revision INTEGER,mandate TEXT,updated_at TEXT);
    CREATE TABLE sa_results(task_id TEXT,version INTEGER,payload TEXT);
    CREATE TABLE sa_outbox(id TEXT PRIMARY KEY,task_id TEXT,state TEXT,payload TEXT,sent_at TEXT);
    CREATE TABLE sa_delivery_receipts(outbox_id TEXT PRIMARY KEY,payload TEXT);
    CREATE TABLE sa_triggers(id TEXT PRIMARY KEY,seq INTEGER,source TEXT,actor TEXT,content TEXT);
    CREATE TABLE sa_trigger_admissions(trigger_id TEXT PRIMARY KEY,gate TEXT);
    CREATE TABLE sa_task_triggers(task_id TEXT,trigger_id TEXT);`);
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const install = () => installLearningSourceStore({ db, tx });
  const api = install();
  const source = { channel: 'desktop', sessionId: 'router', messageId: 'human' };
  function task(id, { status = 'completed', delivery = 'sent', receipt = { status: 'accepted', messageId: 'received' }, outcome = status,
    instructionRevision = 1, publication = 'worker', actor = 'human', strength = 'explicit', resultVersion = 1 } = {}) {
    db.prepare('INSERT INTO sa_tasks VALUES (?,?,?,?,?,?)').run(id, status, 1, 1, JSON.stringify({ source }), id);
    db.prepare('INSERT INTO sa_results VALUES (?,?,?)').run(id, 1, JSON.stringify({ outcome, instructionRevision: 1, summary: '真实执行结果' }));
    db.prepare('INSERT INTO sa_outbox VALUES (?,?,?,?,?)').run(id, id, delivery, JSON.stringify({ type: 'task.result', publication: { origin: publication },
      outcome, resultVersion, instructionRevision, source }), delivery === 'sent' ? '2026-11-08' : null);
    if (receipt) db.prepare('INSERT INTO sa_delivery_receipts VALUES (?,?)').run(id, JSON.stringify(receipt));
    db.prepare('INSERT INTO sa_triggers VALUES (?,?,?,?,?)').run(id, Number(id.replace(/\D/g, '')) || 1, JSON.stringify(source), JSON.stringify({ kind: actor }), '原始用户指令');
    db.prepare('INSERT INTO sa_trigger_admissions VALUES (?,?)').run(id, JSON.stringify({ allowed: true, strength }));
    db.prepare('INSERT INTO sa_task_triggers VALUES (?,?)').run(id, id);
  }
  return { db, api, task, install, tx };
}

test('only terminal Tasks with matching confirmed worker delivery can enter learning', t => {
  const f = fixture(t);
  const cases = [{ status: 'waiting' }, { status: 'running' }, { status: 'waiting', outcome: 'failed', delivery: 'uncertain' },
    { delivery: 'queued' }, { receipt: null }, { receipt: { status: 'accepted' } }, { publication: 'system' },
    { instructionRevision: 2 }, { resultVersion: 2 }, { outcome: 'failed' }];
  cases.forEach((value, index) => { const id = `invalid-${index}`; f.task(id, value); assert.equal(f.api.recordClosedTask(id), null); });
  assert.deepEqual(f.api.learningSources().items, []);
  f.task('good1');
  const stored = JSON.parse(f.db.prepare('SELECT payload FROM sa_results WHERE task_id=?').get('good1').payload);
  f.db.prepare('UPDATE sa_results SET payload=? WHERE task_id=?').run(JSON.stringify({ ...stored, transcript: { hash: 'private' }, executionEffects: { effectsVerified: true } }), 'good1');
  f.task('not-closed2', { status: 'waiting', outcome: 'failed' });
  f.api.recordClosedTask('good1');
  assert.equal(f.api.recordClosedTask('not-closed2'), null);
  const batch = f.api.learningSources();
  assert.deepEqual(batch.items.map(row => row.status), ['completed']);
  assert.equal(batch.items[0].instructions[0].source.role, 'user');
  assert.deepEqual(batch.items[0].result, { summary: '真实执行结果' }, 'only the last Worker message is learning material');
});

test('global range is stable across scopes, retries and reinstall; cursor commits are idempotent', t => {
  const f = fixture(t);
  for (let i = 1; i <= 3; i++) { f.task(`good${i}`); f.api.recordClosedTask(`good${i}`); }
  const first = f.api.learningSources({ limit: 2 });
  assert.equal(first.hasMore, true);
  assert.deepEqual(f.install().learningSources({ limit: 1 }), first);
  assert.equal(f.api.recordClosedTask('good1').seq, first.items[0].seq);
  f.api.completeLearningSources(first.batchId);
  const next = f.install().learningSources();
  assert.deepEqual(next.items.map(row => row.taskId), ['good3']);
  f.api.completeLearningSources(first.batchId);
  f.api.completeLearningSources(next.batchId);
  assert.deepEqual(f.install().learningSources(), { batchId: null, items: [], afterSeq: 3, nextSeq: 3, hasMore: false });
});

test('registration rolls back with close transaction and unregistered terminal material is never backfilled', t => {
  const f = fixture(t);
  f.task('closed1');
  assert.throws(() => f.tx(() => { f.api.recordClosedTask('closed1', { inTransaction: true }); throw new Error('crash'); }), /crash/);
  assert.deepEqual(f.api.learningSources().items, []);
  f.task('undelivered2', { receipt: null });
  const reopened = f.install();
  assert.deepEqual(reopened.learningSources().items, []);
  reopened.recordClosedTask('closed1');
  assert.deepEqual(reopened.learningSources().items.map(row => row.taskId), ['closed1']);
});

test('machine or inferred instructions are excluded even when a Task has been delivered', t => {
  const f = fixture(t);
  f.task('machine1', { actor: 'machine' });
  f.task('inferred2', { strength: 'inferred' });
  f.api.recordClosedTask('machine1'); f.api.recordClosedTask('inferred2');
  assert.ok(f.api.learningSources().items.every(row => row.instructions.length === 0));
});
