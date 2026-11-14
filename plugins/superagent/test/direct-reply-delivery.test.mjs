import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantStore } from '../src/store.mjs';
import { createAssessmentRunner } from '../src/assessment-runner.mjs';
import { readAssessmentPolicy, authorizeAssessment } from '../src/assessment-policy.mjs';
import { ingestAssistantEvent } from '../src/intake.mjs';
import { createDirectReplyDelivery } from '../src/direct-reply-delivery.mjs';
import { createOrchestrationRuntime } from '../src/orchestration-runtime.mjs';
import { deliveryFailure } from '../src/channels/delivery-outcome.mjs';

async function fixture(t, { kind = 'answer', send, actorKind = 'human', available = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-direct-delivery-'));
  const store = await createAssistantStore({ dataDirectory: directory });
  const shutdown = new AbortController();
  let sender, runner;
  t.after(async () => { shutdown.abort(); await sender?.stop(); await runner?.stop(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.updateConfig({ models: [{ providerId: 'provider', modelId: 'exact-model' }] });
  store.connections.update({ enabled: true, appId: 'app', appSecretRef: 'ref', ownerOpenIds: ['owner'], chatIds: ['chat'] }, { revision: 0 });
  const readPolicy = threadId => readAssessmentPolicy(store, { list: () => [] }, threadId);
  const source = { channel: 'feishu', sourceType: 'group', connectionId: 'feishu', conversationId: 'chat', mentioned: true, appId: 'app', chatId: 'chat', messageId: 'message' };
  const event = { channel: 'feishu', kind: 'group', text: '你好', sourceKey: 'message', threadId: 'thread', mentioned: true,
    actor: { id: 'owner', kind: actorKind }, source };
  const policy = await readPolicy();
  const ingest = () => ingestAssistantEvent(store.orchestration, event, { version: policy.version, ownerIds: ['owner'], threadIds: ['chat'] });
  ingest();
  runner = createAssessmentRunner({ database: store.orchestration, readPolicy, authorize: authorizeAssessment,
    assess: async ({ candidates }) => candidates.map(row => ({ candidateId: row.candidateId, outcome: kind, replyText: '你好，有什么可以帮你？', reason: 'Explicit greeting' })) });
  await runner.tick();
  const calls = [];
  sender = createDirectReplyDelivery({ database: store.orchestration, readPolicy, signal: shutdown.signal,
    getAdapter: () => available ? { send: async input => { calls.push(input); return send ? send(input) : { status: 'accepted', messageId: 'reply-id' }; } } : null });
  return { store, sender, calls, source, ingest, runner };
}

for (const kind of ['answer', 'ask']) test(`${kind} commits without a Task and delivers only to its original source once`, async t => {
  const h = await fixture(t, { kind });
  assert.equal(h.store.orchestration.listTasks().length, 0);
  h.ingest(); await h.runner.tick();
  await Promise.all([h.sender.tick(), h.sender.tick()]);
  await h.sender.tick();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].source, h.source);
  const rows = h.store.orchestration.directReplies();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'sent');
  assert.equal(rows[0].receipt.messageId, 'reply-id');
});

test('a revoked channel suppresses queued direct replies before any send', async t => {
  const h = await fixture(t);
  const current = h.store.connections.read();
  h.store.connections.update({ enabled: false }, { revision: current.revision });
  await h.sender.tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.orchestration.directReplies()[0].state, 'suppressed');
});

test('a newer message does not suppress an already authorized queued answer', async t => {
  const h = await fixture(t);
  const db = h.store.orchestration;
  const old = db.getTrigger(db.directReplies()[0].triggerId);
  db.ingest({ dedupeKey: 'newer-message', thread: { id: 'newer-thread', source: { type: 'feishu', id: 'newer-thread' } },
    source: { ...h.source, messageId: 'newer' }, actor: old.actor, content: 'new request',
    createdAt: new Date(Date.parse(old.createdAt) + 360000).toISOString(), gate: { allowed: false } });
  await h.sender.tick();
  assert.equal(h.calls.length, 1);
  assert.equal(db.directReplies()[0].state, 'sent');
});

test('unknown transport outcome stays uncertain and never blindly retries', async t => {
  const h = await fixture(t, { send: async () => { throw new Error('socket closed after remote acceptance'); } });
  await h.sender.tick(); await h.sender.tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.store.orchestration.directReplies()[0].state, 'uncertain');
});

test('proven unsent transport rejection queues backoff without immediate duplicate send', async t => {
  const h = await fixture(t, { send: async () => { throw deliveryFailure('rejected', 'not_sent'); } });
  await h.sender.tick(); await h.sender.tick();
  const row = h.store.orchestration.directReplies()[0];
  assert.equal(h.calls.length, 1);
  assert.equal(row.state, 'queued');
  assert.ok(row.nextAt > Date.now());
});

test('missing transport retains a queued reply with retry backoff', async t => {
  const h = await fixture(t, { available: false });
  await h.sender.tick(); await h.sender.tick();
  const row = h.store.orchestration.directReplies()[0];
  assert.equal(row.state, 'queued');
  assert.equal(row.attempts, 1);
  assert.equal(h.calls.length, 0);
});

test('production orchestration tick delivers direct replies without invoking a Worker', async t => {
  const h = await fixture(t);
  let sent = 0;
  const runtime = createOrchestrationRuntime({ ctx: {}, store: h.store,
    execute: async () => { assert.fail('A greeting must not execute a Worker'); },
    feishu: { send: async ({ source }) => { assert.deepEqual(source, h.source); sent++; return { status: 'accepted', messageId: 'runtime-reply' }; } } });
  try {
    await runtime.tick();
    assert.equal(sent, 1);
    assert.equal(h.store.orchestration.directReplies()[0].state, 'sent');
    assert.equal(h.store.orchestration.directReplies({ channel: 'telegram' }).length, 0);
    assert.equal(h.store.orchestration.directReplies({ channel: 'feishu', threadId: 'thread' }).length, 1);
  } finally { await runtime.stop(); }
});

test('a follow-up sees only confirmed replies from the same source thread', async t => {
  const h = await fixture(t, { kind: 'ask' });
  const readPolicy = threadId => readAssessmentPolicy(h.store, { list: () => [] }, threadId);
  const policy = await readPolicy('thread');
  const observations = [];
  const runner = createAssessmentRunner({ database: h.store.orchestration, readPolicy, authorize: authorizeAssessment,
    assess: async ({ candidates }) => candidates.map(row => {
      observations.push(row.context.recentReplies);
      return { candidateId: row.candidateId, outcome: 'ignore', reason: 'Observation only' };
    }) });
  try {
    for (let index = 0; index < 2; index++) {
      if (index) await h.sender.tick();
      ingestAssistantEvent(h.store.orchestration, { channel: 'feishu', kind: 'group', text: '中国', mentioned: true,
        sourceKey: `follow-${index}`, threadId: 'thread', actor: { id: 'owner', kind: 'human' }, source: { ...h.source, messageId: `follow-${index}` } },
      { version: policy.version, ownerIds: ['owner'], threadIds: ['chat'] });
      await runner.tick();
    }
    assert.deepEqual(observations[0], []);
    assert.equal(observations[1].length, 1);
    assert.equal(observations[1][0].kind, 'ask');
  } finally { await runner.stop(); }
});
