import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackAdapter, normalizeSlackEvent, slackConfig } from '../src/channels/slack/index.mjs';
import { createDingtalkAdapter, normalizeDingtalkEvent, dingtalkConfig } from '../src/channels/dingtalk/index.mjs';
import { loadChannelModules, channelDefinition } from '../src/channel-catalog.mjs';
import { createAssistantConnections } from '../src/connections.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createChannelRuntime } from '../src/channel-runtime.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
class Socket extends EventTarget {
  static all = [];
  readyState = 1;
  frames = [];
  constructor(url) { super(); this.url = url; Socket.all.push(this); }
  send(raw) { this.frames.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  frame(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}
const credentials = { resolve: async () => ({ value: 'private-secret' }) };
const slackInput = { enabled: true, accountId: 'Team:Opaque', botTokenRef: 'bot:REF', appTokenRef: 'app:REF', ownerIds: ['User:Owner'] };
const slackPayload = { team_id: 'Team:Opaque', event_id: 'event1', event: { type: 'app_mention', channel: 'Room:X', user: 'User:Owner', ts: '1731000000.000123', text: '<@Bot:U> inspect' } };
const dingInput = { enabled: true, appId: 'App:Opaque', appSecretRef: 'secret:REF', robotCode: 'Robot:X', ownerIds: ['Staff:Owner'] };
const dingPayload = { conversationType: '2', conversationId: 'Room:X', msgId: 'Message:1', senderStaffId: 'Staff:Owner', robotCode: 'Robot:X', isInAtList: true, createAt: 1731000000000, msgtype: 'text', text: { content: 'inspect' }, sessionWebhook: 'never-persist-secret' };
const dingFrame = data => ({ type: 'CALLBACK', headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'Stream:ACK' }, data: JSON.stringify(data) });

test('new channel config preserves opaque identifiers, isolated updates and encrypted references after reload', async () => {
  await loadChannelModules();
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-new-channels-'));
  let connections = createAssistantConnections({ directory });
  try {
    connections.update(slackInput, { channel: 'slack', revision: 0 });
    connections.update(dingInput, { channel: 'dingtalk', revision: 0 });
    connections.update({ chatIds: ['Room:X'] }, { channel: 'slack', revision: 1 });
    connections.close(); connections = createAssistantConnections({ directory });
    assert.equal(connections.read('slack').config.accountId, 'Team:Opaque');
    assert.equal(connections.read('slack').config.appTokenRef, 'app:REF');
    assert.deepEqual(connections.read('slack').config.chatIds, ['Room:X']);
    assert.equal(connections.read('dingtalk').config.robotCode, 'Robot:X');
    assert.equal(connections.read('dingtalk').revision, 1);
    assert.equal(channelDefinition('slack').setupUrl, 'https://api.slack.com/apps');
    assert.equal(channelDefinition('dingtalk').capabilities.attachments, false);
    assert.throws(() => slackConfig({ botToken: 'plaintext' }), /未知字段/);
    assert.throws(() => dingtalkConfig({ enabled: true }), /请配置/);
  } finally { connections.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Slack validates team identity and preserves bot, thread and mention facts', () => {
  const c = slackConfig(slackInput), bot = { userId: 'Bot:U' };
  const result = normalizeSlackEvent(slackPayload, bot, c);
  assert.equal(result.text, 'inspect'); assert.equal(result.actor.owner, undefined);
  assert.equal(result.source.sourceType, 'group');
  assert.equal(result.source.replyThreadId, slackPayload.event.ts);
  assert.equal(result.source.topicId, '');
  assert.equal(normalizeSlackEvent({ ...slackPayload, team_id: 'Other' }, bot, c), null);
  assert.equal(normalizeSlackEvent({ ...slackPayload, event: { ...slackPayload.event, bot_id: 'Bot' } }, bot, c).actor.kind, 'machine');
  assert.equal(normalizeSlackEvent({ ...slackPayload, event: { ...slackPayload.event, type: 'message', channel_type: 'channel', text: 'hello' } }, bot, c).mentioned, false);
  const answer = normalizeSlackEvent({ ...slackPayload, event: { ...slackPayload.event, type: 'message', channel_type: 'channel', text: 'answer', thread_ts: '1730999999.000222' } }, bot, c);
  assert.equal(answer.mentioned, false); assert.equal(answer.source.parentMessageId, 'Room:X:1730999999.000222');
});

test('Slack socket ACK follows durable ingestion; sends require a real receipt and never retry uncertain delivery', async () => {
  let config = slackConfig(slackInput), release, result = { ok: true, channel: 'Room:X', ts: '1731000010.000100' };
  const received = [], calls = [];
  const adapter = createSlackAdapter({ allowUnboundAuthorization: true, getConfig: () => config, credentials, WebSocketImpl: Socket,
    ingest: async event => { received.push(event); await new Promise(resolve => { release = resolve; }); },
    fetcher: async (url, init) => { calls.push([url, init]); return Response.json(url.endsWith('auth.test') ? { ok: true, bot_id: 'Bot', user_id: 'Bot:U', team_id: 'Team:Opaque' } : url.endsWith('apps.connections.open') ? { ok: true, url: 'wss://wss-primary.slack.com/link' } : result); },
  });
  try {
    await adapter.start(); const socket = Socket.all.at(-1);
    socket.frame({ type: 'hello' }); socket.frame({ type: 'events_api', envelope_id: 'Envelope:X', payload: slackPayload }); await tick();
    assert.equal(received.length, 1); assert.equal(socket.frames.length, 0); release(); await tick();
    assert.equal(socket.frames[0].envelope_id, 'Envelope:X');
    assert.equal((await adapter.status()).connection.state, 'connected');
    const receipt = await adapter.send({ source: received[0].source, text: 'done', idempotencyKey: 'Delivery:X' });
    assert.equal(receipt.messageId, 'Room:X:1731000010.000100');
    assert.equal(JSON.parse(calls.at(-1)[1].body).thread_ts, slackPayload.event.ts);
    result = { ok: false, error: 'not_in_channel' };
    await assert.rejects(adapter.send({ source: received[0].source, text: 'done', idempotencyKey: 'Delivery:Y' }), { deliveryOutcome: 'not_sent' });
    result = { ok: true };
    await assert.rejects(adapter.send({ source: received[0].source, text: 'done', idempotencyKey: 'Delivery:Z' }), { deliveryOutcome: 'unknown' });
    assert.equal(calls.filter(([url]) => url.endsWith('chat.postMessage')).length, 3);
    config = { ...config, enabled: false };
    await assert.rejects(adapter.send({ source: received[0].source, text: 'done', idempotencyKey: 'Delivery:Revoked' }), { deliveryOutcome: 'not_sent' });
  } finally { await adapter.dispose(); }
});

test('DingTalk validates the robot and explicit group mention, never persists temporary webhook secrets', () => {
  const config = dingtalkConfig(dingInput), event = normalizeDingtalkEvent(dingPayload, config);
  assert.equal(event.actor.id, 'Staff:Owner'); assert.equal(event.source.messageId, 'Message:1');
  assert.ok(!JSON.stringify(event).includes('never-persist-secret'));
  assert.equal(normalizeDingtalkEvent({ ...dingPayload, isInAtList: false }, config).mentioned, false);
  assert.equal(normalizeDingtalkEvent({ ...dingPayload, robotCode: 'Other' }, config), null);
  assert.equal(normalizeDingtalkEvent({ ...dingPayload, senderStaffId: undefined, senderId: 'untrusted-fallback' }, config), null);
});

test('DingTalk Stream heartbeat/ACK and group/direct REST use official endpoints and confirmed receipts', async () => {
  const config = dingtalkConfig(dingInput), received = [], calls = [];
  let result = { processQueryKey: 'Receipt:Q' };
  const adapter = createDingtalkAdapter({ allowUnboundAuthorization: true, getConfig: () => config, credentials, WebSocketImpl: Socket, ingest: async event => received.push(event), fetcher: async (url, init) => {
    calls.push([url, init]); return Response.json(url.endsWith('connections/open') ? { endpoint: 'wss://wss-open-connection.dingtalk.com/connect', ticket: 'secret-ticket' } : url.endsWith('accessToken') ? { accessToken: 'private-token', expireIn: 7200 } : result);
  } });
  try {
    await adapter.start(); const socket = Socket.all.at(-1);
    assert.equal((await adapter.status()).connection.state, 'connecting');
    socket.frame({ type: 'SYSTEM', headers: { topic: 'CONNECTED' } });
    socket.frame({ type: 'SYSTEM', headers: { topic: 'ping', messageId: 'ping1' }, data: 'pulse' });
    socket.frame(dingFrame(dingPayload)); await tick();
    assert.equal((await adapter.status()).connection.state, 'connected');
    assert.equal(socket.frames[0].data, 'pulse');
    assert.equal(socket.frames[1].headers.messageId, 'Stream:ACK');
    assert.equal(received[0].messageId, 'Message:1');
    assert.equal((await adapter.send({ source: received[0].source, text: 'done', idempotencyKey: 'Delivery:1' })).messageId, 'Receipt:Q');
    assert.equal(calls.at(-1)[0], 'https://api.dingtalk.com/v1.0/robot/groupMessages/send');
    assert.equal(JSON.parse(calls.at(-1)[1].body).openConversationId, 'Room:X');
    const direct = normalizeDingtalkEvent({ ...dingPayload, conversationType: '1' }, config);
    await adapter.send({ source: direct.source, text: 'done', idempotencyKey: 'Delivery:2' });
    assert.deepEqual(JSON.parse(calls.at(-1)[1].body).userIds, ['Staff:Owner']);
    assert.equal(calls.filter(([url]) => url.endsWith('accessToken')).length, 1);
    result = { code: 'Forbidden' }; await assert.rejects(adapter.send({ source: direct.source, text: 'done', idempotencyKey: 'Delivery:3' }), { deliveryOutcome: 'not_sent' });
    result = {}; await assert.rejects(adapter.send({ source: direct.source, text: 'done', idempotencyKey: 'Delivery:4' }), { deliveryOutcome: 'unknown' });
  } finally { await adapter.dispose(); }
});

test('new channel messages enter the existing Router queue, dedupe and reject revoked deliveries', async () => {
  await loadChannelModules(); const directory = await mkdtemp(join(tmpdir(), 'benchgo-im-runtime-'));
  const connections = createAssistantConnections({ directory }), orchestration = createAssistantOrchestrationStore({ directory });
  const runtime = createChannelRuntime({ ctx: {}, store: { connections, orchestration }, adapterOptions: { credentials, WebSocketImpl: Socket,
    fetcher: async url => Response.json(url.endsWith('auth.test') ? { ok: true, bot_id: 'Bot', user_id: 'Bot:U', team_id: 'Team:Opaque' } : { ok: true, url: 'wss://wss-primary.slack.com/link' }) } });
  try {
    connections.update(slackInput, { channel: 'slack', revision: 0 }); await runtime.restart('slack');
    const socket = Socket.all.at(-1); socket.frame({ type: 'hello' });
    socket.frame({ type: 'events_api', envelope_id: 'Envelope:1', payload: slackPayload }); await tick();
    socket.frame({ type: 'events_api', envelope_id: 'Envelope:2', payload: slackPayload }); await tick();
    assert.equal(orchestration.candidates().length, 1);
    assert.equal(orchestration.getTrigger(orchestration.candidates()[0].triggerId), undefined);
    const source = orchestration.readIntakeEvent(orchestration.candidates()[0].triggerId).source;
    assert.equal(source.connectionRevision, 1);
    connections.update({ enabled: false }, { channel: 'slack', revision: 1 });
    await assert.rejects(runtime.get('slack').send({ source, text: 'done', idempotencyKey: 'd' }), { deliveryOutcome: 'not_sent' });
  } finally { await runtime.dispose(); orchestration.close(); connections.close(); await rm(directory, { recursive: true, force: true }); }
});

test('both channels reject reconfiguration during credential resolution before network requests', async () => {
  for (const [factory, input, normalize] of [[createSlackAdapter, slackInput, c => normalizeSlackEvent(slackPayload, { userId: 'Bot:U' }, c)], [createDingtalkAdapter, dingInput, c => normalizeDingtalkEvent(dingPayload, c)]]) {
    let config = { ownerIds: [], chatIds: [], ...input }; const source = normalize(config).source, calls = [];
    const adapter = factory({ allowUnboundAuthorization: true, getConfig: () => config, ingest: async () => {}, credentials: { resolve: async () => { config = { ...config, enabled: false }; return { value: 'secret' }; } }, fetcher: async (...args) => { calls.push(args); return Response.json({}); } });
    await assert.rejects(adapter.send({ source, text: 'done', idempotencyKey: 'd' }), { deliveryOutcome: 'not_sent' });
    assert.equal(calls.length, 0); await adapter.dispose();
  }
});
