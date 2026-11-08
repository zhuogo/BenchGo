import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installLearningSourceStore } from '../src/learning-source-store.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE sa_tickets(id TEXT PRIMARY KEY,status TEXT,result_version INTEGER,instruction_revision INTEGER,mandate TEXT,updated_at TEXT);
    CREATE TABLE sa_results(ticket_id TEXT,version INTEGER,payload TEXT);
    CREATE TABLE sa_outbox(id TEXT PRIMARY KEY,ticket_id TEXT,state TEXT,payload TEXT,sent_at TEXT);
    CREATE TABLE sa_delivery_receipts(outbox_id TEXT PRIMARY KEY,payload TEXT);
    CREATE TABLE sa_triggers(id TEXT PRIMARY KEY,seq INTEGER,source TEXT,actor TEXT,content TEXT);
    CREATE TABLE sa_trigger_admissions(trigger_id TEXT PRIMARY KEY,gate TEXT);
    CREATE TABLE sa_ticket_triggers(ticket_id TEXT,trigger_id TEXT);`);
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const install = () => installLearningSourceStore({ db, tx });
  const api = install();
  const source = { channel: 'desktop', sessionId: 'router', messageId: 'human' };
  function ticket(id, { status = 'completed', delivery = 'sent', receipt = { status: 'accepted', messageId: 'received' }, outcome = status,
    instructionRevision = 1, publication = 'router', actor = 'human', strength = 'explicit', resultVersion = 1 } = {}) {
    db.prepare('INSERT INTO sa_tickets VALUES (?,?,?,?,?,?)').run(id, status, 1, 1, JSON.stringify({ source }), id);
    db.prepare('INSERT INTO sa_results VALUES (?,?,?)').run(id, 1, JSON.stringify({ outcome, instructionRevision: 1,
      finalSummary: '真实执行结果', toolEvidence: { entries: [{ name: 'test', text: 'output' }] },
      ...(outcome === 'failed' ? { failure: { attempted: '连接', cause: '断网', resumeConditions: '网络恢复' } } : {}) }));
    db.prepare('INSERT INTO sa_outbox VALUES (?,?,?,?,?)').run(id, id, delivery, JSON.stringify({ type: 'ticket.result', publication: { origin: publication },
      outcome, resultVersion, instructionRevision, source }), delivery === 'sent' ? '2026-11-08' : null);
    if (receipt) db.prepare('INSERT INTO sa_delivery_receipts VALUES (?,?)').run(id, JSON.stringify(receipt));
    db.prepare('INSERT INTO sa_triggers VALUES (?,?,?,?,?)').run(id, Number(id.replace(/\D/g, '')) || 1, JSON.stringify(source), JSON.stringify({ kind: actor }), '原始用户指令');
    db.prepare('INSERT INTO sa_trigger_admissions VALUES (?,?)').run(id, JSON.stringify({ allowed: true, strength }));
    db.prepare('INSERT INTO sa_ticket_triggers VALUES (?,?)').run(id, id);
  }
  return { db, api, ticket, install, tx };
}

test('only terminal Tickets with matching confirmed Router delivery can enter learning', t => {
  const f = fixture(t);
  const cases = [{ status: 'waiting' }, { status: 'open' }, { status: 'failed', delivery: 'uncertain' },
    { delivery: 'queued' }, { receipt: null }, { receipt: { status: 'accepted' } }, { publication: 'system' },
    { instructionRevision: 2 }, { resultVersion: 2 }, { outcome: 'failed' }];
  cases.forEach((value, index) => { const id = `invalid-${index}`; f.ticket(id, value); assert.equal(f.api.recordClosedTicket(id), null); });
  assert.deepEqual(f.api.learningSources().items, []);
  f.ticket('good1');
  f.ticket('good2', { status: 'failed' });
  f.api.recordClosedTicket('good1');
  f.api.recordClosedTicket('good2');
  const batch = f.api.learningSources();
  assert.deepEqual(batch.items.map(row => row.status), ['completed', 'failed']);
  assert.equal(batch.items[0].instructions[0].source.role, 'user');
  assert.equal(batch.items[1].result.failure.cause, '断网');
});

test('previously delivered Worker records remain learning sources without using Router summaries as original evidence', t => {
  const f = fixture(t);
  f.ticket('legacy1', { publication: 'worker' });
  f.ticket('natural2');
  f.api.recordClosedTicket('legacy1');
  f.api.recordClosedTicket('natural2');
  const batch = f.api.learningSources();
  assert.equal(batch.items.length, 2);
  assert(batch.items.every(row => row.result.finalSummary === '真实执行结果'));
});

test('global range is stable across scopes, retries and reinstall; cursor commits are idempotent', t => {
  const f = fixture(t);
  for (let i = 1; i <= 3; i++) { f.ticket(`good${i}`); f.api.recordClosedTicket(`good${i}`); }
  const first = f.api.learningSources({ limit: 2 });
  assert.equal(first.hasMore, true);
  assert.deepEqual(f.install().learningSources({ limit: 1 }), first);
  assert.equal(f.api.recordClosedTicket('good1').seq, first.items[0].seq);
  f.api.completeLearningSources(first.batchId);
  const next = f.install().learningSources();
  assert.deepEqual(next.items.map(row => row.ticketId), ['good3']);
  f.api.completeLearningSources(first.batchId);
  f.api.completeLearningSources(next.batchId);
  assert.deepEqual(f.install().learningSources(), { batchId: null, items: [], afterSeq: 3, nextSeq: 3, hasMore: false });
});

test('registration rolls back with close transaction and legacy terminal material is never backfilled', t => {
  const f = fixture(t);
  f.ticket('closed1');
  assert.throws(() => f.tx(() => { f.api.recordClosedTicket('closed1', { inTransaction: true }); throw new Error('crash'); }), /crash/);
  assert.deepEqual(f.api.learningSources().items, []);
  f.ticket('legacy2', { receipt: null });
  const reopened = f.install();
  assert.deepEqual(reopened.learningSources().items, []);
  reopened.recordClosedTicket('closed1');
  assert.deepEqual(reopened.learningSources().items.map(row => row.ticketId), ['closed1']);
});

test('machine or inferred instructions are excluded even when a Ticket has been delivered', t => {
  const f = fixture(t);
  f.ticket('machine1', { actor: 'machine' });
  f.ticket('inferred2', { strength: 'inferred' });
  f.api.recordClosedTicket('machine1'); f.api.recordClosedTicket('inferred2');
  assert.ok(f.api.learningSources().items.every(row => row.instructions.length === 0));
});
