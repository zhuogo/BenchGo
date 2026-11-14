import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createOrchestrationRuntime } from '../src/orchestration-runtime.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const receipt = id => ({ status: 'accepted', messageId: `message:${id}` });
const future = 10 ** 13;

async function fixture(t, { outboxes = 0, replies = 0 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-mirror-recovery-'));
  const db = createAssistantOrchestrationStore({ directory }), raw = new DatabaseSync(db.path), runtimes = [];
  const at = '2026-01-01T00:00:00.000Z';
  raw.prepare('INSERT INTO sa_threads VALUES (?,?,?,?,?)').run('thread', 'desktop', 'owner', '{}', at);
  raw.prepare('INSERT INTO sa_triggers(id,dedupe_key,thread_id,source,actor,content,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('trigger', 'trigger', 'thread', '{}', '{}', 'original', 'hash', at);
  const task = raw.prepare('INSERT INTO sa_tasks(id,thread_id,target,status,mandate,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
  const outbox = raw.prepare('INSERT INTO sa_outbox(id,unique_key,task_id,payload,state,next_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)');
  const direct = raw.prepare('INSERT INTO sa_direct_replies(id,trigger_id,thread_id,text,kind,source,actor,gate,policy_version,state,next_at,receipt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const saved = raw.prepare('INSERT INTO sa_delivery_receipts VALUES (?,?)');
  function addOutbox(id, { state = 'sent', taskId = 'task', text = 'original' } = {}) {
    outbox.run(id, `unique:${id}`, taskId, JSON.stringify({ type: 'fixture', text, source: { channel: 'desktop' } }), state, future, at, at);
    if (state === 'sent') saved.run(id, JSON.stringify(receipt(id)));
  }
  function addReply(id, { state = 'sent' } = {}) {
    direct.run(id, 'trigger', 'thread', 'original', 'answer', '{}', '{}', '{}', 'p1', state, future,
      state === 'sent' ? JSON.stringify(receipt(id)) : null, at, at);
  }
  raw.exec('BEGIN');
  task.run('task', 'thread', 'history', 'completed', '{}', at, at);
  for (let i = 0; i < outboxes; i++) {
    // Distinct Tasks exercise recovery past the former 1000-Task ceiling.
    const taskId = `task:${i}`; task.run(taskId, 'thread', 'history', 'completed', '{}', at, at);
    addOutbox(`outbox:${i}`, { taskId });
  }
  for (let i = 0; i < replies; i++) addReply(`reply:${i}`);
  raw.exec('COMMIT');
  const runtime = options => {
    const value = createOrchestrationRuntime({ ctx: {}, store: { orchestration: db, paths: { workspace: directory } },
      execute: async () => { throw new Error('History must never execute'); }, ...options });
    runtimes.push(value); return value;
  };
  t.after(async () => {
    await Promise.all(runtimes.map(value => value.stop()));
    raw.close(); db.close(); await rm(directory, { recursive: true, force: true });
  });
  return { db, raw, directory, runtime, addOutbox, addReply };
}

test('startup recovery pages every accepted delivery beyond 1000 Tasks and replies, then does no history reads while idle', async t => {
  const h = await fixture(t, { outboxes: 1105, replies: 1105 }), mirrored = new Map(), reads = { outbox: 0, direct: 0 };
  for (const [name, key] of [['sentDeliveryPage', 'outbox'], ['sentDirectReplyPage', 'direct']]) {
    const page = h.db[name];
    h.db[name] = options => { reads[key]++; const result = page(options); assert.ok(result.entries.length <= 100); return result; };
  }
  h.db.directReplies = () => { throw new Error('Recovery must never use the full history list'); };
  const runtime = h.runtime({ onDelivered: row => mirrored.set(row.id, (mirrored.get(row.id) || 0) + 1) });
  let yielded = false;
  setImmediate(() => { yielded = true; });
  await runtime.tick();
  assert.equal(yielded, true, 'startup yields between bounded pages');
  assert.equal(mirrored.size, 2210); assert.ok([...mirrored.values()].every(count => count === 1));
  assert.deepEqual(reads, { outbox: 12, direct: 12 });
  for (let i = 0; i < 5; i++) await runtime.tick();
  assert.deepEqual(reads, { outbox: 12, direct: 12 });
});

test('recovery cut and live events cover old queued rows, concurrent inserts and reconciliations without duplicate callbacks', async t => {
  const h = await fixture(t, { outboxes: 205, replies: 205 });
  let pages = 0;
  for (const name of ['sentDeliveryPage', 'sentDirectReplyPage']) {
    const read = h.db[name]; h.db[name] = options => { pages++; return read(options); };
  }
  h.raw.prepare("UPDATE sa_outbox SET state='queued' WHERE id=?").run('outbox:0');
  h.raw.prepare("UPDATE sa_direct_replies SET state='queued',receipt=NULL WHERE id=?").run('reply:0');
  h.raw.prepare("UPDATE sa_outbox SET state='uncertain',attempts=1 WHERE id=?").run('outbox:1');
  h.raw.prepare("UPDATE sa_direct_replies SET state='uncertain',attempts=1,receipt=NULL WHERE id=?").run('reply:1');
  const entered = deferred(), release = deferred(), mirrored = new Map();
  const runtime = h.runtime({ onDelivered: async row => {
    mirrored.set(row.id, (mirrored.get(row.id) || 0) + 1);
    if (row.id === 'outbox:2') { entered.resolve(); await release.promise; }
  } });
  const recovery = runtime.tick(); await entered.promise;
  const overlap = runtime.tick();
  h.addOutbox('new:outbox', { state: 'queued' }); h.addReply('new:reply', { state: 'queued' });
  for (const row of h.db.claimOutbox('external', { now: future }))
    h.db.finishOutbox(row.id, { owner: 'external', sent: true, receipt: receipt(row.id), now: future + 1 });
  for (const row of h.db.claimDirectReplies({ owner: 'external', now: future }))
    h.db.finishDirectReply(row.id, { owner: 'external', sent: true, receipt: receipt(row.id), now: future + 1 });
  h.db.reconcileOutbox('outbox:1', { attempts: 1, outcome: 'sent', evidence: 'provider receipt', receipt: receipt('outbox:1') });
  h.db.reconcileDirectReply('reply:1', { attempts: 1, outcome: 'sent', evidence: 'provider receipt', receipt: receipt('reply:1') });
  await Promise.resolve();
  for (const id of ['outbox:0', 'reply:0', 'outbox:1', 'reply:1', 'new:outbox', 'new:reply'])
    assert.equal(mirrored.get(id), 1, 'committed live updates do not wait for recovery');
  release.resolve(); await Promise.all([recovery, overlap]);
  await Promise.all([runtime.tick(), runtime.tick()]); await runtime.tick();
  assert.equal(mirrored.size, 412); assert.ok([...mirrored.values()].every(count => count === 1));
  assert.equal(pages, 6, 'concurrent ticks share one recovery pump');
});

test('commit observer and immediate transport callback share one in-flight mirror and failed sinks retry without resending', async t => {
  const h = await fixture(t), entered = deferred(), release = deferred();
  let attempts = 0, sends = 0, clock = Date.now();
  const runtime = h.runtime({ now: () => clock, deliverDesktop: async row => { sends++; return receipt(row.id); },
    onDelivered: async () => { if (++attempts === 1) { entered.resolve(); await release.promise; throw new Error('sink unavailable'); } } });
  h.addOutbox('live', { state: 'queued' });
  h.raw.prepare('UPDATE sa_outbox SET next_at=0 WHERE id=?').run('live');
  const pending = runtime.tick(); await entered.promise;
  const concurrent = runtime.tick(); await Promise.resolve(); assert.equal(attempts, 1);
  release.resolve(); await Promise.all([pending, concurrent]);
  await runtime.tick(); assert.equal(attempts, 1);
  clock += 29999; await runtime.tick(); assert.equal(attempts, 1);
  clock++; await runtime.tick(); assert.equal(attempts, 2); assert.equal(sends, 1);
  for (let i = 0; i < 3; i++) await runtime.tick();
  assert.equal(attempts, 2); assert.equal(sends, 1);
});

test('restart replays persisted history through stable sink identities without duplicating messages', async t => {
  const h = await fixture(t, { outboxes: 3, replies: 3 }), persisted = new Set();
  let calls = 0, inserts = 0;
  const onDelivered = row => { calls++; if (!persisted.has(row.id)) { persisted.add(row.id); inserts++; } };
  const first = h.runtime({ onDelivered }); await first.tick(); await first.stop();
  const reopened = createAssistantOrchestrationStore({ filename: h.db.path });
  const second = createOrchestrationRuntime({ ctx: {}, store: { orchestration: reopened, paths: { workspace: h.directory } }, execute: async () => {}, onDelivered });
  try {
    await second.tick(); await second.tick();
    assert.equal(calls, 12); assert.equal(inserts, 6); assert.equal(persisted.size, 6);
  } finally { await second.stop(); reopened.close(); }
});

test('failed history reads keep their cursor and back off while live mirrors remain immediate', async t => {
  const h = await fixture(t, { outboxes: 205 }), mirrored = new Map(), read = h.db.sentDeliveryPage;
  let clock = Date.now(), pages = 0;
  h.db.sentDeliveryPage = options => { if (++pages === 2) throw new Error('database temporarily unavailable'); return read(options); };
  const runtime = h.runtime({ now: () => clock, onDelivered: row => mirrored.set(row.id, (mirrored.get(row.id) || 0) + 1) });
  await runtime.tick(); assert.equal(pages, 2); assert.equal(mirrored.size, 100);
  h.addOutbox('live', { state: 'queued' });
  h.db.claimOutbox('external', { now: future });
  h.db.finishOutbox('live', { owner: 'external', sent: true, receipt: receipt('live'), now: future + 1 });
  await Promise.resolve(); assert.equal(mirrored.get('live'), 1);
  clock += 29999; await runtime.tick(); assert.equal(pages, 2);
  clock++; await runtime.tick();
  assert.equal(pages, 4); assert.equal(mirrored.size, 206); assert.ok([...mirrored.values()].every(count => count === 1));
});

test('stop waits for the current mirror and interrupts recovery before another page or live callback', async t => {
  const h = await fixture(t, { outboxes: 205 }), entered = deferred(), release = deferred(), read = h.db.sentDeliveryPage;
  let pages = 0, calls = 0;
  h.db.sentDeliveryPage = options => { pages++; return read(options); };
  const runtime = h.runtime({ onDelivered: async () => { calls++; entered.resolve(); await release.promise; } });
  const pending = runtime.tick(); await entered.promise;
  let stopped = false;
  const stopping = runtime.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  release.resolve(); await Promise.all([pending, stopping]);
  assert.equal(pages, 1); assert.equal(calls, 1);
  h.addOutbox('after-stop', { state: 'queued' }); h.db.claimOutbox('external', { now: future });
  h.db.finishOutbox('after-stop', { owner: 'external', sent: true, receipt: receipt('after-stop'), now: future + 1 });
  await runtime.tick(); assert.equal(calls, 1);
});

test('observers see only committed accepted receipts and cannot undo delivery or leak rolled-back writes', async t => {
  const h = await fixture(t), seen = [];
  h.addOutbox('outbox', { state: 'queued' }); h.addReply('reply', { state: 'queued' });
  h.db.onSentDelivery(row => {
    const table = row.uniqueKey ? 'sa_outbox' : 'sa_direct_replies';
    assert.equal(h.raw.prepare(`SELECT state FROM ${table} WHERE id=?`).get(row.id).state, 'sent');
    seen.push(row.id);
  });
  h.db.onSentDelivery(() => { throw new Error('observer failed'); });
  h.db.onSentDelivery(async () => { throw new Error('async observer failed'); });
  h.db.claimOutbox('sender', { now: future }); h.db.claimDirectReplies({ owner: 'sender', now: future });
  assert.throws(() => h.db.finishOutbox('outbox', { owner: 'sender', sent: true, receipt: [], now: future + 1 }));
  assert.throws(() => h.db.finishDirectReply('reply', { owner: 'sender', sent: true, receipt: [], now: future + 1 }));
  assert.deepEqual(seen, []);
  assert.equal(h.raw.prepare('SELECT state FROM sa_outbox WHERE id=?').get('outbox').state, 'claimed');
  assert.equal(h.db.finishOutbox('outbox', { owner: 'sender', sent: true, receipt: receipt('outbox'), now: future + 1 }).state, 'sent');
  assert.equal(h.db.finishDirectReply('reply', { owner: 'sender', sent: true, receipt: receipt('reply'), now: future + 1 }).state, 'sent');
  await Promise.resolve(); assert.deepEqual(seen, ['outbox', 'reply']);
});
