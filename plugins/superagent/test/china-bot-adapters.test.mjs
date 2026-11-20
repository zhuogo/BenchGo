import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createQqAdapter, normalizeQqEvent, qqConfig } from '../src/channels/qq/index.mjs';
import { createWecomAdapter, normalizeWecomEvent, wecomConfig } from '../src/channels/wecom/index.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const now = Date.parse('2026-11-20T09:00:00Z');
const credentials = { resolve: async () => ({ value: 'fixture-secret' }) };

function sockets() {
  const instances = [];
  class Socket extends EventTarget {
    readyState = 1;
    frames = [];
    constructor() { super(); instances.push(this); }
    send(raw) { this.frames.push(JSON.parse(raw)); }
    close(code) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatchEvent(Object.assign(new Event('close'), { code }));
    }
    open() { this.dispatchEvent(new Event('open')); }
    frame(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  }
  return { instances, Socket };
}

const qqInput = { enabled: true, appId: 'App:Opaque', appSecretRef: 'ref' };
const qqEvent = (t, id, timestamp, actor = 'Owner:X') => ({
  op: 0, t, d: {
    id, timestamp, group_openid: 'Group:X', channel_id: 'Channel:X', content: '问候',
    author: { id: actor, user_openid: actor, member_openid: actor },
  },
});
const hello = { op: 10, d: { heartbeat_interval: 30000 } };
const ready = { op: 0, t: 'READY', d: { session_id: 'Session:X' }, s: 1 };

test('QQ 默认只订阅私聊与群 @，断线先接收补传再标记已连接', async () => {
  const { instances, Socket } = sockets(), received = [];
  const config = qqConfig(qqInput);
  const adapter = createQqAdapter({
    getConfig: () => config, credentials, WebSocketImpl: Socket, reconnectMs: 1,
    authorizeConnection: async ({ actor }) => actor?.id !== 'Denied:X',
    ingest: async event => { received.push(event.normalize()); },
    fetcher: async url => Response.json(url.endsWith('/gateway') ? { url: 'wss://api.sgroup.qq.com/ws' } : { access_token: 'fixture', expires_in: 7200 }),
  });
  try {
    await adapter.start();
    const first = instances[0];
    first.frame(hello);
    first.frame(ready);
    first.frame({ ...qqEvent('GROUP_AT_MESSAGE_CREATE', 'Denied', new Date(now).toISOString(), 'Denied:X'), s: 2 });
    first.frame({ ...qqEvent('AT_MESSAGE_CREATE', 'Legacy', new Date(now).toISOString()), s: 3 });
    await tick();
    assert.equal(first.frames[0].d.intents, 1 << 25);
    assert.equal((await adapter.status()).events, 'unverified');
    assert.equal(first.readyState, 1);
    first.frame({ op: 7 });
    for (let i = 0; instances.length < 2 && i < 30; i++) await delay(5);
    const second = instances[1];
    assert.ok(second, 'QQ reconnects after op 7');
    second.frame(hello);
    second.frame({ ...qqEvent('C2C_MESSAGE_CREATE', 'Missed', new Date(now).toISOString()), s: 4 });
    second.frame({ op: 0, t: 'RESUMED', s: 5 });
    await tick();
    assert.deepEqual(second.frames[0], { op: 6, d: { token: 'QQBot fixture', session_id: 'Session:X', seq: 3 } });
    assert.deepEqual(received.map(event => event.messageId), ['Missed']);
    assert.equal((await adapter.status()).connection.state, 'connected');
    second.close(4014);
    assert.match((await adapter.status()).error, /订阅权限/);
    assert.equal((await adapter.status()).connection.state, 'failed');
  } finally { await adapter.dispose(); }
});

test('QQ 按私聊和群聊时效判定，后续消息使用新锚点并保留分段回执', async () => {
  const calls = [], config = qqConfig(qqInput);
  let reply = Response.json({ id: 'accepted' });
  const adapter = createQqAdapter({
    getConfig: () => config, credentials, now: () => now, allowUnboundAuthorization: true,
    fetcher: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return url.endsWith('/getAppAccessToken') ? Response.json({ access_token: 'fixture', expires_in: 7200 }) : reply.clone();
    },
  });
  const source = (type, id, age) => normalizeQqEvent(qqEvent(type, id, new Date(now - age).toISOString()), config).source;
  const send = (source, key) => adapter.send({ source, text: '结果', idempotencyKey: key });
  try {
    await assert.rejects(send(source('GROUP_AT_MESSAGE_CREATE', 'OldGroup', 300000), 'old-group'), { code: 'REPLY_WINDOW_EXPIRED' });
    await assert.rejects(send(source('C2C_MESSAGE_CREATE', 'OldUser', 3600000), 'old-user'), { code: 'REPLY_WINDOW_EXPIRED' });
    assert.equal(calls.length, 0);
    const direct = source('C2C_MESSAGE_CREATE', 'Direct', 300000);
    assert.equal((await send(direct, 'part:0')).messageId, 'accepted');
    const group = source('GROUP_AT_MESSAGE_CREATE', 'NewGroup', 0);
    await send(group, 'part:0');
    await send(group, 'part:1');
    assert.deepEqual(calls.slice(1).map(call => call.body.msg_id), ['Direct', 'NewGroup', 'NewGroup']);
    assert.notEqual(calls.at(-1).body.msg_seq, calls.at(-2).body.msg_seq);
    assert.equal(calls.at(-1).url, 'https://api.sgroup.qq.com/v2/groups/Group%3AX/messages');
    reply = Response.json({ code: 400, message: 'msg_id has expired' }, { status: 400 });
    await assert.rejects(send(group, 'expired-by-platform'), { code: 'REPLY_WINDOW_EXPIRED' });
    reply = Response.json({ code: 503, message: 'msg_id has expired' }, { status: 503 });
    await assert.rejects(send(group, 'unknown'), { deliveryOutcome: 'unknown' });
    assert.equal(normalizeQqEvent(qqEvent('AT_MESSAGE_CREATE', 'Legacy', null), qqConfig({ ...qqInput, eventScope: 'legacy' })).source.targetType, 'channels');
    assert.throws(() => qqConfig({ ...qqInput, eventScope: 'invalid' }), /事件范围 无效/);
  } finally { await adapter.dispose(); }
});

test('企业微信群来源绑定机器人与群，过期锚点确认未发，补发以平台回执计', async () => {
  const { instances, Socket } = sockets(), received = [];
  const config = wecomConfig({ enabled: true, botId: 'Bot:X', secretRef: 'ref' });
  const adapter = createWecomAdapter({
    getConfig: () => config, credentials, WebSocketImpl: Socket, now: () => now,
    authorizeConnection: async ({ source }) => source?.chatId !== 'Denied:X',
    ingest: async event => { received.push(event.normalize()); },
  });
  const message = (id, createdAt, extra = {}) => ({
    cmd: 'aibot_msg_callback', headers: { req_id: `req:${id}` },
    body: { msgid: id, chattype: 'group', aibotid: 'Bot:X', chatid: 'Group:X',
      create_time: createdAt / 1000, from: { userid: 'Owner:X' }, text: { content: '问候' }, ...extra },
  });
  try {
    await adapter.start();
    const socket = instances[0];
    socket.open(); await tick();
    socket.frame({ headers: socket.frames[0].headers, errcode: 0 });
    socket.frame(message('Denied', now, { chatid: 'Denied:X' }));
    socket.frame(message('WrongBot', now, { aibotid: 'other' }));
    socket.frame(message('MissingChat', now, { chatid: undefined }));
    socket.frame(message('Fresh', now));
    await tick();
    assert.deepEqual(received.map(event => event.messageId), ['Fresh']);
    assert.equal(received[0].mentioned, true);
    const expired = normalizeWecomEvent(message('Expired', now - 86400000), config).source;
    await assert.rejects(adapter.send({ source: expired, text: '结果', idempotencyKey: 'reply' }), { code: 'REPLY_WINDOW_EXPIRED' });
    assert.equal(socket.frames.length, 1);
    const sending = adapter.send({ source: received[0].source, text: '结果', idempotencyKey: 'reply' });
    await tick();
    const frame = socket.frames.at(-1);
    assert.equal(frame.headers.req_id, 'req:Fresh');
    assert.equal(frame.cmd, 'aibot_respond_msg');
    assert.equal(frame.body.stream.finish, true);
    socket.frame({ headers: frame.headers, errcode: 0 });
    assert.equal((await sending).messageId, frame.body.stream.id);
    const inFlight = assert.rejects(adapter.send({ source: received[0].source, text: '结果', idempotencyKey: 'disconnect' }), { deliveryOutcome: 'unknown' });
    await tick();
    socket.frame({ cmd: 'aibot_event_callback', body: { event: { eventtype: 'disconnected_event' } } });
    await inFlight;
    assert.match((await adapter.status()).error, /另一运行实例/);
    assert.equal((await adapter.status()).connection.state, 'failed');
  } finally { await adapter.dispose(); }
});
