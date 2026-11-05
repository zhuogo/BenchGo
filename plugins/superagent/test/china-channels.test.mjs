import test from 'node:test';
import assert from 'node:assert/strict';
import { createWecomAdapter, normalizeWecomEvent, wecomConfig } from '../src/channels/wecom.mjs';
import { createQqAdapter, normalizeQqEvent, qqConfig } from '../src/channels/qq.mjs';
import { createWeixinAdapter, normalizeWeixinEvent, weixinConfig } from '../src/channels/weixin.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
class Socket extends EventTarget {
  static all = [];
  readyState = 1;
  frames = [];
  constructor(url) { super(); this.url = url; Socket.all.push(this); }
  send(raw) { this.frames.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  open() { this.dispatchEvent(new Event('open')); }
  frame(frame) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })); }
}
const credentials = { resolve: async () => ({ value: 'private-token' }) };
test('中国渠道配置严格校验且来源身份由可信配置决定', () => {
  assert.throws(() => wecomConfig({ enabled: true }), /请配置/);
  assert.throws(() => qqConfig({ appSecret: 'secret' }), /未知字段/);
  assert.throws(() => weixinConfig({ ownerIds: [''] }), /无效/);
  const c = wecomConfig({ botId: 'bot', ownerIds: ['owner'], chatIds: ['group'] });
  const event = normalizeWecomEvent({ cmd: 'aibot_msg_callback', headers: { req_id: 'req' }, body: { msgid: 'm', chattype: 'group', chatid: 'group', from: { userid: 'owner' }, text: { content: 'hello' } } }, c);
  assert.equal(event.actor.owner, true); assert.equal(event.source.replyRequestId, 'req'); assert.equal(event.mentioned, true);
  assert.equal(normalizeWecomEvent({ cmd: 'aibot_msg_callback', body: { msgid: 'm', chatid: 'denied', from: { userid: 'owner' }, text: { content: 'x' } } }, c), null);
  assert.ok(!JSON.stringify(event).includes('secret'));
});
test('企业微信订阅认证、真实回执与停用释放', async () => {
  let config = wecomConfig({ enabled: true, botId: 'b', secretRef: 'ref' }); const received = [];
  const adapter = createWecomAdapter({ getConfig: () => config, credentials, ingest: async e => received.push(e), WebSocketImpl: Socket, ackTimeoutMs: 20 });
  await adapter.start(); const socket = Socket.all.at(-1); socket.open(); await tick();
  const subscription = socket.frames[0]; assert.equal(subscription.cmd, 'aibot_subscribe');
  socket.frame({ headers: subscription.headers, errcode: 0 }); await tick();
  socket.frame({ cmd: 'aibot_msg_callback', headers: { req_id: 'r' }, body: { msgid: 'm', from: { userid: 'u' }, text: { content: 'hi' } } }); await tick();
  assert.equal(received.length, 1); assert.equal((await adapter.status()).authentication, 'verified');
  const sending = adapter.send({ source: received[0].source, text: 'hello', idempotencyKey: 'delivery1' }); await tick();
  const outgoing = socket.frames.at(-1); assert.equal(outgoing.cmd, 'aibot_send_msg'); socket.frame({ headers: outgoing.headers, errcode: 0 });
  assert.equal((await sending).status, 'accepted');
  const rejected = assert.rejects(adapter.send({ source: received[0].source, text: 'rejected', idempotencyKey: 'delivery-rejected' }), { deliveryOutcome: 'not_sent' });
  await tick(); socket.frame({ headers: socket.frames.at(-1).headers, errcode: 400 }); await rejected;
  await assert.rejects(adapter.send({ source: received[0].source, text: 'uncertain', idempotencyKey: 'delivery-timeout' }), { deliveryOutcome: 'unknown' });
  config = { ...config, enabled: false }; await assert.rejects(adapter.send({ source: received[0].source, text: 'blocked', idempotencyKey: 'delivery2' }), /停用/);
  await adapter.dispose(); assert.equal(socket.readyState, 3);
});
test('QQ 按事件目标类型归一化，发送前复验凭据等待期间的撤销', async () => {
  let config = qqConfig({ enabled: true, appId: 'app', appSecretRef: 'ref', ownerIds: ['u'] });
  const event = normalizeQqEvent({ t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'm', group_openid: 'g', author: { member_openid: 'u' }, content: 'hi' } }, config);
  assert.equal(event.source.targetType, 'groups'); assert.equal(event.actor.owner, true);
  const calls = [];
  const adapter = createQqAdapter({ getConfig: () => config, credentials: { resolve: async () => { config = { ...config, enabled: false }; return { value: 'secret' }; } }, ingest: async () => {}, fetcher: async (...args) => { calls.push(args); return Response.json({}); } });
  await assert.rejects(adapter.send({ source: event.source, text: 'hi', idempotencyKey: 'k' }), /停用/); assert.equal(calls.length, 0); await adapter.dispose();
});
test('QQ 网关认证、消息受理及发送使用官方 API', async () => {
  const config = qqConfig({ enabled: true, appId: 'app', appSecretRef: 'ref' }), received = [], calls = [];
  const adapter = createQqAdapter({ getConfig: () => config, credentials, ingest: async e => received.push(e), WebSocketImpl: Socket,
    fetcher: async (url, init) => { calls.push([url, init]); return Response.json(url.includes('getAppAccessToken') ? { access_token: 'token', expires_in: 7200 } : url.endsWith('/gateway') ? { url: 'wss://api.sgroup.qq.com/websocket' } : { id: 'sent' }); } });
  await adapter.start(); const socket = Socket.all.at(-1); socket.frame({ op: 10, d: { heartbeat_interval: 30000 } }); await tick(); assert.equal(socket.frames[0].op, 2);
  socket.frame({ op: 0, t: 'READY', s: 1, d: { session_id: 'session' } });
  socket.frame({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: 'm', author: { user_openid: 'u' }, content: 'hi' } }); await tick();
  assert.equal(received.length, 1);
  await adapter.send({ source: received[0].source, text: 'reply', idempotencyKey: 'key' });
  assert.equal(calls.at(-1)[0], 'https://api.sgroup.qq.com/v2/users/u/messages'); assert.equal(JSON.parse(calls.at(-1)[1].body).msg_id, 'm'); await adapter.dispose();
});
test('微信私聊长轮询保留回复上下文且不泄露进事件，取消轮询', async () => {
  const config = weixinConfig({ enabled: true, accountId: 'bot', tokenRef: 'ref' }), received = [], calls = [];
  let delivery = { ret: 0 };
  assert.equal(normalizeWeixinEvent({ message_type: 1, group_id: 'g' }, config), null);
  assert.equal(normalizeWeixinEvent({ message_type: 1, chat_room_id: 'g' }, config), null);
  const adapter = createWeixinAdapter({ getConfig: () => config, credentials, ingest: async e => received.push(e), pollDelayMs: 50000,
    fetcher: async (url, init) => { calls.push([url, init]); return Response.json(url.endsWith('getupdates') ? { ret: 0, msgs: [{ message_type: 1, message_id: 'm', from_user_id: 'u', context_token: 'private-context', item_list: [{ type: 1, text_item: { text: 'hi' } }] }], get_updates_buf: 'next' } : delivery); } });
  await adapter.start(); await tick(); assert.equal(received.length, 1); assert.ok(!JSON.stringify(received).includes('private-context'));
  await adapter.send({ source: received[0].source, text: 'reply', idempotencyKey: 'k' });
  assert.equal(JSON.parse(calls.at(-1)[1].body).msg.context_token, 'private-context');
  delivery = { ret: -1 }; await assert.rejects(adapter.send({ source: received[0].source, text: 'reply', idempotencyKey: 'reject' }), { deliveryOutcome: 'not_sent' });
  delivery = {}; await assert.rejects(adapter.send({ source: received[0].source, text: 'reply', idempotencyKey: 'unknown' }), { deliveryOutcome: 'unknown' });
  await adapter.dispose(); assert.equal((await adapter.status()).connection.state, 'stopped');
});

test('微信扫码仅主人可用，确认凭据安全保存并只返回引用', async () => {
  const saved = [], requests = [];
  const adapter = createWeixinAdapter({ getConfig: () => ({}), credentials, ingest: async () => {},
    saveCredential: async entry => { saved.push(entry); return { ref: 'benchgo-channel:weixin:reference' }; },
    fetcher: async url => { requests.push(url); return Response.json(url.includes('get_bot_qrcode')
      ? { qrcode: 'private-session-code', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/example' }
      : { status: 'confirmed', ilink_bot_id: 'bot-id', bot_token: 'never-public-token', baseurl: 'https://ilinkai.weixin.qq.com/' }); } });
  await assert.rejects(adapter.action({ operation: 'startLogin' }), /仅允许/); assert.equal(requests.length, 0);
  const started = await adapter.action({ operation: 'startLogin', ownerAuthenticated: true });
  assert.equal(started.qrContent, 'https://liteapp.weixin.qq.com/q/example'); assert.ok(!JSON.stringify(started).includes('private-session-code'));
  const result = await adapter.action({ operation: 'pollLogin', ownerAuthenticated: true, loginId: started.loginId });
  assert.equal(result.status, 'confirmed'); assert.equal(result.config.accountId, 'bot-id'); assert.equal(saved[0].secret, 'never-public-token');
  assert.equal(saved[0].field, 'tokenRef'); assert.ok(!JSON.stringify(result).includes('never-public-token'));
  await assert.rejects(adapter.action({ operation: 'pollLogin', ownerAuthenticated: true, loginId: started.loginId }), /已失效/);
  await adapter.dispose();
});

test('微信扫码过期清理，拒绝外部服务地址与恶意跳转', async () => {
  assert.throws(() => weixinConfig({ baseUrl: 'https://attacker.example' }), /官方/);
  let clock = 0, mode = 'redirect'; const calls = [];
  const adapter = createWeixinAdapter({ getConfig: () => ({}), credentials, ingest: async () => {}, now: () => clock,
    saveCredential: async () => ({ ref: 'saved' }),
    fetcher: async url => { calls.push(url); return Response.json(url.includes('get_bot_qrcode')
      ? { qrcode: 'code', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/example' }
      : { status: 'scaned_but_redirect', redirect_host: mode === 'redirect' ? 'attacker.example' : 'ilinkai.weixin.qq.com' }); } });
  const first = await adapter.action({ operation: 'startLogin', ownerAuthenticated: true });
  await assert.rejects(adapter.action({ operation: 'pollLogin', loginId: first.loginId, ownerAuthenticated: true }), /官方/);
  assert.ok(calls.every(url => url.startsWith('https://ilinkai.weixin.qq.com/')));
  mode = 'safe'; const second = await adapter.action({ operation: 'startLogin', ownerAuthenticated: true }); clock = 480001;
  await assert.rejects(adapter.action({ operation: 'pollLogin', loginId: second.loginId, ownerAuthenticated: true }), /已失效/);
  assert.equal(calls.length, 3); await adapter.dispose();
});
