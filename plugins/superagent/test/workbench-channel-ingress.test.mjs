import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installDirectReplyStore } from '../src/direct-reply-store.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createUnifiedChannelIngress } from '../src/channel-ingress.mjs';
import { createWorkbenchChannelIngress } from '../src/workbench-channel-ingress.mjs';
import { createDirectReplyDelivery } from '../src/direct-reply-delivery.mjs';
import { channelSessionKey } from '../src/channel-policy.mjs';

async function fixture() {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  const row = { channel: 'feishu', revision: 1, config: { enabled: true, appId: 'app', ownerOpenIds: ['remote'], chatIds: ['chat'] } };
  const store = { orchestration: database, connections: { read: () => structuredClone(row) } };
  const source = { channel: 'feishu', appId: 'app', sourceType: 'direct', conversationId: 'chat', chatId: 'chat', messageId: 'remote-message', threadId: 'remote-thread' };
  const remote = await createUnifiedChannelIngress({ store }).receive('feishu', { channel: 'feishu', sourceKey: 'remote-message', threadId: 'remote-thread', sourceType: 'direct', actor: { id: 'remote', kind: 'human' }, source, text: 'hello' });
  const thread = { id: 'official-side-thread', sessionId: 'official-session', source: remote.intakeEvent.source, sourceKey: channelSessionKey(remote.intakeEvent.source) };
  const readPolicy = async () => ({ version: 'current', connection: row.config, connections: { feishu: row } });
  const receive = createWorkbenchChannelIngress({ store, readPolicy });
  const message = { id: 'local-message', source: { kind: 'user' }, content: [{ type: 'text', text: '原样直接回复' }] };
  const input = { thread, sessionId: thread.sessionId, message };
  return { database, row, receive, input, readPolicy, remote };
}

test('official owner reply preserves local identity, original ledger and one durable delivery without Router', async () => {
  const f = await fixture();
  try {
    const originalCandidates = f.database.candidates().length;
    const accepted = await f.receive(f.input), duplicate = await f.receive(f.input);
    assert.equal(duplicate.duplicate, true);
    assert.equal(accepted.requiresEval, false);
    assert.equal(accepted.trigger.threadId, f.remote.intakeEvent.threadId);
    assert.equal(accepted.trigger.actor.id, 'desktop-owner');
    assert.equal(accepted.trigger.source.channel, 'desktop');
    assert.deepEqual(accepted.trigger.source.deliveryTarget, f.remote.intakeEvent.source);
    assert.equal(f.database.candidates().length, originalCandidates);
    assert.equal(f.database.directReplies().length, 1);
    assert.equal(accepted.delivery.kind, 'owner');
    const calls = [], projected = [], shutdown = new AbortController();
    const sender = createDirectReplyDelivery({ database: f.database, readPolicy: f.readPolicy, signal: shutdown.signal,
      getAdapter: () => ({ send: async value => { calls.push(value); return { status: 'accepted', messageId: 'sent' }; } }),
      onDelivered: row => { projected.push(row); throw Error('projection unavailable'); } });
    await sender.tick(); await sender.tick();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].source, f.remote.intakeEvent.source);
    assert.equal(calls[0].text, f.input.message.content[0].text);
    assert.equal(projected[0].state, 'sent');
    assert.equal(f.database.directReplies({ state: 'sent' }).length, 1);
    assert.equal(f.database.directReplies({ state: 'queued' }).length, 0);
  } finally { f.database.close(); }
});

test('model source, wrong official session and revoked connection cannot become local owner replies', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.receive({ ...f.input, message: { ...f.input.message, source: { kind: 'model', trusted: true } } }), /真实用户/);
    await assert.rejects(f.receive({ ...f.input, sessionId: 'other' }), /真实用户/);
    await assert.rejects(f.receive({ ...f.input, thread: { ...f.input.thread, sourceKey: 'forged' } }), /真实用户/);
    f.row.config.enabled = false;
    await assert.rejects(f.receive(f.input), /撤销/);
    assert.equal(f.database.directReplies().length, 0);
  } finally { f.database.close(); }
});

test('queued owner reply is suppressed when its actual adapter connection is revoked', async () => {
  const f = await fixture();
  try {
    await f.receive(f.input);
    f.row.revision++;
    let sent = 0;
    const sender = createDirectReplyDelivery({ database: f.database, readPolicy: f.readPolicy, signal: new AbortController().signal,
      getAdapter: () => ({ send: async () => { sent++; } }) });
    await sender.tick();
    assert.equal(sent, 0);
    assert.equal(f.database.directReplies()[0].state, 'suppressed');
  } finally { f.database.close(); }
});

test('legacy direct reply migration preserves candidate rows, reconciliation evidence and foreign keys', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE sa_candidates(id TEXT PRIMARY KEY); CREATE TABLE sa_threads(id TEXT PRIMARY KEY); CREATE TABLE sa_triggers(id TEXT PRIMARY KEY);
      INSERT INTO sa_candidates VALUES('candidate'); INSERT INTO sa_threads VALUES('thread'); INSERT INTO sa_triggers VALUES('trigger');
      CREATE TABLE sa_direct_replies(id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL UNIQUE REFERENCES sa_candidates(id),trigger_id TEXT NOT NULL REFERENCES sa_triggers(id),thread_id TEXT NOT NULL REFERENCES sa_threads(id),text TEXT NOT NULL,kind TEXT NOT NULL,source TEXT NOT NULL,actor TEXT NOT NULL,gate TEXT NOT NULL,policy_version TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,owner TEXT,lease_until INTEGER,last_error TEXT,receipt TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      INSERT INTO sa_direct_replies VALUES('reply','candidate','trigger','thread','old original','answer','{}','{}','{}','old','uncertain',1,1,NULL,NULL,NULL,NULL,'then','then');
      CREATE TABLE sa_direct_reply_reconciliations(id INTEGER PRIMARY KEY,reply_id TEXT NOT NULL REFERENCES sa_direct_replies(id),attempts INTEGER NOT NULL,outcome TEXT NOT NULL,evidence TEXT NOT NULL,receipt TEXT,created_at TEXT NOT NULL);
      INSERT INTO sa_direct_reply_reconciliations VALUES(1,'reply',1,'unknown','kept evidence',NULL,'then');`);
    const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
    const api = installDirectReplyStore({ db, tx }).api;
    assert.equal(api.directReplies()[0].text, 'old original');
    assert.equal(api.directReplies()[0].reconciliations[0].evidence, 'kept evidence');
    assert.equal(db.prepare('PRAGMA table_info(sa_direct_replies)').all().find(row => row.name === 'candidate_id').notnull, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  } finally { db.close(); }
});
