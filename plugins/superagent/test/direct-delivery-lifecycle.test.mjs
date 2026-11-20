import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { taskReplySignal } from '../src/task-reply.mjs';
import { createDirectReplyDelivery } from '../src/direct-reply-delivery.mjs';
import { createUnifiedChannelIngress } from '../src/channel-ingress.mjs';
import { replyWindowExpired } from '../src/channels/delivery-outcome.mjs';

async function fixture(t, channel = 'feishu') {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-result-notice-'));
  let db = createAssistantOrchestrationStore({ directory });
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const source = channel === 'desktop' ? { channel, sessionId: 'router', messageId: 'human' }
    : channel === 'wecom' ? { channel, sourceType: 'group', accountId: 'bot', connectionId: channel, connectionRevision: 1,
      conversationId: 'chat', chatId: 'chat', topicId: null, messageId: 'human', replyRequestId: 'req-original', mentioned: true }
    : { channel, sourceType: 'direct', appId: 'app', conversationId: 'chat', chatId: 'chat', messageId: 'human' };
  const { trigger } = db.ingest({ dedupeKey: 'human', thread: { id: 'thread', source: { type: channel, id: channel === 'wecom' ? 'thread' : 'router' } },
    source, actor: { kind: 'human', id: 'owner' }, content: 'original task', mode: 'direct', gate: { allowed: true, strength: 'explicit' } });
  const task = db.createTask({ threadId: 'thread', target: 'task', sourceTriggerIds: [trigger.id], mandate: { source } });
  db.createAssignment(task.id, { id: 'work' });
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true });
  const run = db.prepareRun(assignment.id, { ...assignment, sessionId: 'worker', directory: 'fixture' });
  db.updateRun(run.id, { ...assignment, state: 'submitted' });
  const result = { summary: 'Original Worker result', instructionRevision: 1, runId: run.id, sessionId: run.sessionId, completion: { kind: 'completed' } };
  db.commitResult(task.id, { assignment, uniqueKey: 'result', result, now: 1 });
  const [notice] = db.pendingResultNotifications({ now: 2 });
  const signal = taskReplySignal(db, notice);
  const input = { signal, sessionId: 'router', requestId: 'expression', messages: [{ id: 'public', text: 'Public Router reply', seq: 3 }] };
  return { get db() { return db; }, task, assignment, input, notice, source,
    reopen() { db.close(); db = createAssistantOrchestrationStore({ directory }); } };
}

test('external Router reply reuses the direct ledger, deduplicates and confirms only an actual accepted receipt', async t => {
  const f = await fixture(t);
  const row = f.db.enqueueRouterReply(f.input);
  assert.equal(row.kind, 'router');
  assert.equal(f.db.enqueueRouterReply(f.input).id, row.id);
  assert.deepEqual(f.db.learningSources().items, []);
  const [claimed] = f.db.claimDirectReplies({ owner: 'sender' });
  f.db.finishDirectReply(claimed.id, { owner: 'sender', uncertain: true });
  assert.deepEqual(f.db.claimDirectReplies({ owner: 'blind-retry', now: Date.now() + 100000 }), []);
  assert.equal(f.db.results(f.task.id)[0].reply, undefined);
  f.reopen();
  f.db.reconcileDirectReply(row.id, { attempts: 1, outcome: 'sent', evidence: 'provider receipt', receipt: { status: 'accepted', messageId: 'external' } });
  assert.equal(f.db.results(f.task.id)[0].reply.receipt.messageId, 'external');
  assert.equal(f.db.learningSources().items.length, 1);
  assert.equal(f.db.assignments(f.task.id)[0].attempts, 1);
  assert.deepEqual(f.db.deliveries(f.task.id), []);
});

test('Router channel delivery uses the existing adapter and immutable public text', async t => {
  const f = await fixture(t);
  f.db.enqueueRouterReply(f.input);
  let sends = 0;
  const shutdown = new AbortController();
  const delivery = createDirectReplyDelivery({ database: f.db, signal: shutdown.signal,
    readPolicy: async () => ({ connection: { enabled: true, appId: 'app', chatIds: ['chat'] } }),
    getAdapter: () => ({ send: async input => { sends++; assert.deepEqual(input.source, f.source);
      assert.equal(input.text, 'Public Router reply'); return { status: 'accepted', messageId: 'external' }; } }) });
  await delivery.tick();
  assert.equal(sends, 1);
  assert.equal(f.db.results(f.task.id)[0].reply.receipt.messageId, 'external');
  assert.equal(f.db.learningSources().items.length, 1);
});

test('an expired Router result waits durably and refreshes only the original owner reply anchor', async t => {
  const f = await fixture(t, 'wecom');
  const original = f.db.enqueueRouterReply(f.input);
  const connection = { revision: 1, config: { enabled: true, botId: 'bot', ownerIds: ['owner', 'other-owner'], chatIds: ['chat', 'other-chat'] } };
  const ingress = () => createUnifiedChannelIngress({ store: { orchestration: f.db, connections: { read: () => connection } } });
  const receive = (messageId, { actor = 'owner', mentioned = true, scope = {} } = {}) => ingress().receive('wecom', {
    channel: 'wecom', sourceType: 'group', threadId: 'thread', messageId, sourceKey: `wecom:bot:${messageId}`,
    source: { ...f.source, messageId, replyRequestId: `req-${messageId}`, messageOccurredAt: '2026-11-20T01:02:03.000Z', ...scope },
    actor: { kind: 'human', id: actor }, text: '新消息', mentioned,
  });
  const sends = [];
  const shutdown = new AbortController();
  const senderFor = () => createDirectReplyDelivery({ database: f.db, signal: shutdown.signal,
    readPolicy: async () => ({ connections: { wecom: connection } }),
    getAdapter: () => ({ send: async input => {
      sends.push(input);
      if (sends.length === 1) {
        // The next message can persist while the old outbound receipt is pending.
        await receive('concurrent');
        throw replyWindowExpired('expired');
      }
      if (sends.length === 2) throw replyWindowExpired('expired again');
      return { status: 'accepted', messageId: 'platform-receipt' };
    } }) });
  await senderFor().tick();
  assert.equal(f.db.directReplies()[0].state, 'waiting_reply_window');
  f.reopen();
  const sender = senderFor();
  await sender.tick();
  assert.equal(sends[1].source.messageId, 'concurrent');
  const replay = await receive('concurrent', { scope: { replyRequestId: 'req-replayed' } });
  assert.equal(replay.duplicate, true);
  connection.revision++;
  assert.equal((await receive('concurrent')).ignored, true);
  connection.revision--;
  await receive('different-owner', { actor: 'other-owner' });
  await receive('different-chat', { scope: { chatId: 'other-chat', conversationId: 'other-chat' } });
  await receive('no-mention', { mentioned: false });
  await sender.tick();
  assert.equal(sends.length, 2);
  await receive('fresh');
  await sender.tick();
  await sender.tick();
  assert.equal(sends.length, 3);
  assert.deepEqual(sends[2], { source: { ...f.source, messageId: 'fresh', replyRequestId: 'req-fresh', messageOccurredAt: '2026-11-20T01:02:03.000Z' },
    text: original.text, idempotencyKey: `direct-reply:${original.id}` });
  const [sent] = f.db.directReplies();
  assert.deepEqual(sent.source, original.source);
  assert.equal(sent.triggerId, original.triggerId);
  assert.equal(sent.state, 'sent');
  assert.equal(f.db.results(f.task.id)[0].reply.receipt.messageId, 'platform-receipt');
  assert.equal(f.db.assignments(f.task.id)[0].attempts, 1);
});

test('a matching fresh anchor cannot revive a delivery after its connection revision was revoked', async t => {
  const f = await fixture(t, 'wecom');
  f.db.enqueueRouterReply(f.input);
  const connection = { revision: 1, config: { enabled: true, botId: 'bot', ownerIds: ['owner'], chatIds: ['chat'] } };
  const ingress = createUnifiedChannelIngress({ store: { orchestration: f.db, connections: { read: () => connection } } });
  const receive = messageId => ingress.receive('wecom', { channel: 'wecom', sourceType: 'group', threadId: 'thread', messageId,
    sourceKey: `wecom:bot:${messageId}`, source: { ...f.source, messageId }, actor: { kind: 'human', id: 'owner' }, text: '新消息', mentioned: true });
  let sends = 0;
  const sender = createDirectReplyDelivery({ database: f.db, signal: new AbortController().signal,
    readPolicy: async () => ({ connections: { wecom: connection } }),
    getAdapter: () => ({ send: async () => { sends++; throw replyWindowExpired('expired'); } }) });
  await sender.tick();
  connection.revision++;
  await receive('different-revision');
  await sender.tick();
  assert.equal(f.db.directReplies()[0].state, 'waiting_reply_window');
  assert.equal(sends, 1);
  // A previously persisted matching anchor is insufficient under current policy.
  connection.revision--;
  await receive('same-revision-before-revoke');
  connection.revision++;
  await sender.tick();
  assert.equal(f.db.directReplies()[0].state, 'suppressed');
  assert.equal(sends, 1);
});

test('changed source or result version cannot enqueue a Router transport', async t => {
  const f = await fixture(t);
  assert.throws(() => f.db.enqueueRouterReply({ ...f.input, signal: { ...f.input.signal, source: { ...f.source, chatId: 'other' } } }));
  assert.throws(() => f.db.enqueueRouterReply({ ...f.input, signal: { ...f.input.signal, resultVersion: 2 } }));
  f.db.enqueueRouterReply(f.input);
  assert.throws(() => f.db.enqueueRouterReply({ ...f.input, messages: [{ id: 'public', text: 'changed' }] }), { code: 'DIRECT_REPLY_SOURCE_CONFLICT' });
});

test('known-unsent historical result outbox migrates while sent and uncertain history never replays', async t => {
  for (const state of ['queued', 'sent', 'uncertain']) await t.test(state, async t => {
    const f = await fixture(t, 'desktop');
    const raw = new DatabaseSync(f.db.path);
    const saved = f.db.results(f.task.id)[0]; delete saved.notification;
    raw.prepare('UPDATE sa_results SET payload=? WHERE task_id=?').run(JSON.stringify(saved), f.task.id);
    raw.prepare('INSERT INTO sa_outbox(id,unique_key,task_id,payload,state,attempts,next_at,created_at,updated_at) VALUES (?,?,?,?,?,0,0,?,?)')
      .run('legacy', 'result', f.task.id, JSON.stringify({ ...f.notice.payload, publication: { origin: 'router', action: 'deliver', text: 'old hidden draft' } }), state, '2026-01-01', '2026-01-01');
    raw.close(); f.reopen();
    assert.equal(f.db.deliveries(f.task.id)[0].state, state === 'queued' ? 'cancelled' : state);
    assert.equal(f.db.pendingResultNotifications().length, state === 'queued' ? 1 : 0);
  });
});

test('an expired known-unsent legacy expression lease migrates before ordinary outbox claiming', async t => {
  const f = await fixture(t, 'desktop');
  const raw = new DatabaseSync(f.db.path), result = f.db.results(f.task.id)[0];
  delete result.notification;
  raw.prepare('UPDATE sa_results SET payload=? WHERE task_id=?').run(JSON.stringify(result), f.task.id);
  raw.prepare("INSERT INTO sa_outbox(id,unique_key,task_id,payload,state,owner,lease_until,attempts,next_at,created_at,updated_at) VALUES (?,?,?,?,'claimed','old',?,1,0,?,?)")
    .run('old-lease', 'result', f.task.id, JSON.stringify({ ...f.notice.payload, replyState: 'pending' }), 10 ** 13, '2026-01-01', '2026-01-01');
  raw.close(); f.reopen();
  assert.deepEqual(f.db.pendingResultNotifications(), []);
  assert.deepEqual(f.db.claimOutbox('new', { now: 10 ** 13 + 1 }), []);
  assert.equal(f.db.deliveries(f.task.id)[0].state, 'cancelled');
  assert.equal(f.db.pendingResultNotifications({ now: 10 ** 13 + 1 }).length, 1);
});

test('legacy uncertain transport suppresses fresh expression even after an idempotent result commit', async t => {
  const f = await fixture(t, 'desktop'), raw = new DatabaseSync(f.db.path);
  const result = f.db.results(f.task.id)[0]; delete result.notification;
  raw.prepare('UPDATE sa_results SET payload=? WHERE task_id=?').run(JSON.stringify(result), f.task.id);
  raw.prepare("INSERT INTO sa_outbox(id,unique_key,task_id,payload,state,attempts,next_at,created_at,updated_at) VALUES (?,?,?,?,'uncertain',1,0,?,?)")
    .run('unknown', 'result', f.task.id, JSON.stringify(f.notice.payload), '2026-01-01', '2026-01-01');
  raw.close(); f.reopen();
  const { commitFingerprint, deliveryKey, committedAt, association, version, taskId, outcome, commitKey, ...draft } = result;
  f.db.commitResult(f.task.id, { assignment: f.assignment, uniqueKey: 'result', result: draft, now: 10 });
  assert.equal(f.db.results(f.task.id)[0].notification.state, 'suppressed');
  assert.equal(f.db.resultNotification(f.task.id, 'result'), null);
  assert.deepEqual(f.db.pendingResultNotifications(), []);
});
