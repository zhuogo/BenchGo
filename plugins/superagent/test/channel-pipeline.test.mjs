import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createUnifiedChannelIngress } from '../src/channel-ingress.mjs';
import { feishuIncomingEvent } from '../src/feishu.mjs';
import { channelSessionKey, authorizeChannelConnection, channelSourceAllowed } from '../src/channel-policy.mjs';
import { channelDefinition, channelIds, loadChannelModules } from '../src/channel-catalog.mjs';

function fixture(channel = 'feishu') {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  const row = { revision: 1, config: { enabled: true, appId: 'app', ownerOpenIds: ['owner'], ownerIds: ['owner'], chatIds: ['chat'] } };
  const projected = [], store = { connections: { read: () => structuredClone(row) }, orchestration: database };
  return { database, row, projected, ingress: createUnifiedChannelIngress({ store, onInbound: (...args) => projected.push(args) }), channel };
}
function envelope({ actor = 'owner', chat = 'chat', type = 'group', mentioned = true, content = '{"text":"hello"}' } = {}) {
  return { header: { event_type: 'im.message.receive_v1', event_id: 'event', app_id: 'app' }, event: {
    sender: { sender_type: 'user', sender_id: { open_id: actor } }, message: { chat_type: type, message_id: 'm', chat_id: chat, create_time: '1780000000000', message_type: 'text', content, mentions: mentioned ? [{ id: { open_id: 'bot' } }] : [] },
  } };
}
const incoming = body => feishuIncomingEvent(body, { appId: 'app', botOpenId: 'bot' });

test('source verification precedes body normalization and denied events never create Triggers', async () => {
  const f = fixture();
  try {
    for (const patch of [{ actor: 'stranger' }, { chat: 'outside' }]) {
      const body = envelope(patch);
      Object.defineProperty(body.event.message, 'content', { get() { assert.fail('denied source must not read content'); } });
      assert.equal((await f.ingress.receive('feishu', incoming(body))).ignored, true);
    }
    assert.equal(f.database.candidates().length, 0);
    assert.equal(f.projected.length, 0);
  } finally { f.database.close(); }
});

test('unmentioned group is preserved by adapter and ignored by unified admission before Trigger', async () => {
  const f = fixture();
  try {
    const event = incoming(envelope({ mentioned: false }));
    assert.equal(event.source.sourceType, 'group');
    assert.equal((await f.ingress.receive('feishu', event)).gate.reason, 'notMentioned');
    assert.equal(f.database.candidates().length, 0);
    assert.equal(f.projected.length, 0);
  } finally { f.database.close(); }
});

test('durable intake binds connection evidence, queues direct assessment and projects one stable official key', async () => {
  const f = fixture();
  try {
    const event = incoming(envelope({ type: 'p2p', mentioned: false }));
    const result = await f.ingress.receive('feishu', event);
    assert.equal(result.requiresEval, true);
    assert.equal(result.trigger, null);
    assert.equal(result.intakeEvent.intakeStage, 'pending');
    assert.equal(result.candidate.gate.evidence.ownerVerified, true);
    assert.equal(result.candidate.gate.evidence.sourceVerified, true);
    assert.equal(result.intakeEvent.source.connectionId, 'feishu');
    assert.equal((await f.ingress.receive('feishu', event)).duplicate, true);
    assert.equal(f.database.candidates().length, 1);
    assert.equal(f.projected.length, 2, 'official projection retries use the same Trigger identity');
    assert.equal(f.projected[0][2].sessionKey, f.projected[1][2].sessionKey);
    assert.equal(channelSessionKey({ ...result.intakeEvent.source, connectionRevision: 99 }), f.projected[0][2].sessionKey);
    assert.notEqual(channelSessionKey({ ...result.intakeEvent.source, appId: 'other' }), f.projected[0][2].sessionKey);
  } finally { f.database.close(); }
});

test('async normalization cannot mutate identity or commit after connection revocation', async () => {
  const f = fixture();
  try {
    const original = incoming(envelope()), normalized = original.normalize();
    await assert.rejects(f.ingress.receive('feishu', { ...original, normalize: async () => ({ ...normalized, actor: { id: 'someone', kind: 'human' } }) }), /归一/);
    await assert.rejects(f.ingress.receive('feishu', { ...original, normalize: async () => { f.row.revision++; return normalized; } }), /更改/);
    assert.equal(f.database.candidates().length, 0);
    assert.equal(f.projected.length, 0);
  } finally { f.database.close(); }
});

test('a subscribed unmentioned follow-up is admitted into the original ledger without another candidate', async () => {
  const f = fixture();
  try {
    const first = await f.ingress.receive('feishu', incoming(envelope()));
    const lease = f.database.claimEval(first.intakeEvent.threadId, { owner: 'router', policyVersion: 'feishu:1' });
    const { ticket } = f.database.decide(first.candidate.id, { evalId: lease.id, owner: 'router', policyVersion: 'feishu:1', outcome: 'accept', assessment: {}, ticket: { target: 'work', mandate: { actorId: 'owner', source: first.intakeEvent.source } } });
    const followup = envelope({ mentioned: false });
    followup.event.message.message_id = 'followup'; followup.event.message.root_id = 'm';
    const received = await f.ingress.receive('feishu', incoming(followup));
    assert.equal(received.requiresEval, false);
    assert.equal(received.delivery.ticketId, ticket.id);
    assert.equal(received.trigger.intakeStage, 'admitted');
    assert.equal(f.database.candidates().length, 1);
    assert.equal(f.database.pendingSubscriptionMessages(ticket.id).length, 1);
  } finally { f.database.close(); }
});

test('topic mapping requires native thread evidence; root-only replies remain group and private replies remain direct', () => {
  const body = envelope(); body.event.message.root_id = 'root';
  assert.equal(incoming(body).source.sourceType, 'group');
  body.event.message.thread_id = 'topic';
  assert.equal(incoming(body).source.sourceType, 'topic');
  assert.equal(incoming(body).source.topicId, 'topic');
  body.event.message.chat_type = 'p2p';
  assert.equal(incoming(body).source.sourceType, 'direct');
  assert.equal(incoming(body).source.topicId, undefined);
});

test('connection reads honor independent enablement without borrowing a chat allowlist or account identity', () => {
  const config = { enabled: true, accountId: 'account', chatIds: ['chat'] }, read = () => ({ revision: 4, config });
  const source = { channel: 'email', accountId: 'account', sourceType: 'system', conversationId: null, chatId: null };
  assert.doesNotThrow(() => authorizeChannelConnection(read, 'email', { operation: 'history', source }));
  assert.throws(() => authorizeChannelConnection(read, 'email', { operation: 'history', source: { ...source, accountId: 'other' } }), /身份/);
  config.enabled = false;
  assert.throws(() => authorizeChannelConnection(read, 'email', { operation: 'history', source }), /撤销/);
  assert.equal(channelSourceAllowed({ ...config, enabled: true }, { ...source, sourceType: 'native-private', conversationId: 'chat', chatId: 'chat' }), false);
});

test('catalog declares normalized actual capabilities and pull channels do not claim external-send', async () => {
  await loadChannelModules();
  for (const id of channelIds) {
    const { capabilities } = channelDefinition(id);
    for (const key of ['text', 'direct', 'groups', 'topics', 'images', 'attachments', 'cards', 'history', 'receipts']) assert.equal(typeof capabilities[key], 'boolean', `${id}:${key}`);
    assert.deepEqual(capabilities.externalActions, ['api', 'webhook'].includes(id) ? [] : ['external-send']);
  }
});

test('external-send preparation uses a real stored target, full content and current authorization', async () => {
  const f = fixture();
  try {
    const accepted = await f.ingress.receive('feishu', incoming(envelope()));
    const input = { targetTriggerId: accepted.intakeEvent.id, text: '完整外发正文' };
    assert.throws(() => f.ingress.prepareExternalSend('feishu', input, { principal: { kind: 'owner' } }), /可信渠道来源/);
    const lease = f.database.claimEval(accepted.intakeEvent.threadId, { owner: 'test-router', policyVersion: 'feishu:1' });
    f.database.decide(accepted.candidate.id, { evalId: lease.id, owner: 'test-router', policyVersion: 'feishu:1', outcome: 'accept', assessment: {}, ticket: { target: 'existing source task', mandate: { source: accepted.intakeEvent.source } } });
    const frozen = f.ingress.prepareExternalSend('feishu', input, { principal: { kind: 'owner' } });
    assert.deepEqual(frozen.submission.input, input);
    assert.equal(frozen.content.text, input.text);
    assert.equal(frozen.target.messageId, 'm');
    assert.throws(() => f.ingress.prepareExternalSend('feishu', { ...input, source: { chatId: 'forged' } }, { principal: { kind: 'owner' } }), /真实来源/);
    assert.throws(() => f.ingress.prepareExternalSend('feishu', input, { principal: { kind: 'human' } }), /主人/);
    f.row.config.enabled = false;
    assert.throws(() => f.ingress.prepareExternalSend('feishu', input, { principal: { kind: 'owner' } }), /撤销/);
  } finally { f.database.close(); }
});
