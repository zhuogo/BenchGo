import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createChannelCredentials } from '../src/channel-credentials.mjs';
import { createTelegramAdapter, normalizeTelegramEvent } from '../src/channels/telegram/index.mjs';
import { createWeixinAdapter } from '../src/channels/weixin/index.mjs';

const abortable = signal => new Promise((_, reject) => {
  if (signal.aborted) return reject(signal.reason);
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});
async function eventually(check) {
  for (let tries = 0; tries < 100; tries++) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail('Expected adapter state was never reached');
}

test('微信扫码无需先启用，允许名单建议来自微信认证回执', async () => {
  const credentials = { save: async () => ({ ref: 'stored-token' }) };
  const adapter = createWeixinAdapter({ getConfig: () => ({}), credentials, assertCurrent() {},
    authorizeConnection: () => false, fetcher: async url => Response.json(url.includes('get_bot_qrcode')
      ? { qrcode: 'qr', qrcode_img_content: 'https://liteapp.weixin.qq.com/qr' }
      : { status: 'confirmed', ilink_bot_id: 'bot', bot_token: 'secret', ilink_user_id: 'verified-user' }) });
  try {
    const { loginId } = await adapter.action({ operation: 'startLogin', ownerAuthenticated: true });
    const result = await adapter.action({ operation: 'pollLogin', ownerAuthenticated: true, loginId });
    assert.deepEqual(result.config.ownerIds, ['verified-user']);
    assert.equal(result.config.tokenRef, 'stored-token');
  } finally { await adapter.dispose(); }
});

test('微信重启恢复加密游标及已授权回复上下文，保留 64 位标识', async () => {
  const records = new Map();
  const host = { readRecord: async key => records.get(key),
    modifyRecord: async (key, mutate) => records.set(key, await mutate(records.get(key))),
    resolve: async () => ({ value: 'fixture-secret' }) };
  const config = { enabled: true, accountId: 'bot', tokenRef: 'fixture-ref', ownerIds: ['owner'], chatIds: ['owner'] };
  const checkpoint = service => identity => service.runtimeState({ channel: 'weixin', connectionId: 'one', profileId: 'profile', ...identity });
  const seen = [], received = [];
  let accept = true;
  const fetcher = async (url, init) => {
    const input = JSON.parse(init.body);
    if (url.endsWith('getupdates')) {
      seen.push(input.get_updates_buf);
      if (seen.length === 1) return new Response('{"ret":0,"msgs":[{"message_type":1,"message_id":18446744073709551601,"from_user_id":"outsider","context_token":"forbidden-context"},{"message_type":1},{"message_type":1,"message_id":18446744073709551602,"from_user_id":"owner","context_token":"valid-context","item_list":[{"type":1,"text_item":{"text":"hi"}}]}],"get_updates_buf":"saved-cursor"}');
      return abortable(init.signal);
    }
    assert.equal(input.msg.context_token, 'valid-context');
    return new Response(accept ? '{"message_id":18446744073709551603}' : '{"ret":-2,"errmsg":"prepare failed"}');
  };
  let adapter;
  try {
    const mount = () => {
      const credentials = createChannelCredentials({ credentials: host });
      adapter = createWeixinAdapter({ getConfig: () => config, allowUnboundAuthorization: true, credentials,
        runtimeState: checkpoint(credentials), ingest: async value => received.push(value.normalize()), pollDelayMs: 1, fetcher });
    };
    mount();
    await adapter.start();
    await eventually(() => seen.length === 2);
    assert.deepEqual(seen, ['', 'saved-cursor']);
    assert.equal(received.length, 1);
    assert.equal(received[0].source.messageId, '18446744073709551602');
    assert.doesNotMatch(JSON.stringify([received, [...records]]), /fixture-secret|saved-cursor|valid-context|forbidden-context/);
    const sealed = [...records.values()].find(record => record.payload.binding);
    assert.ok(sealed?.payload.ciphertext);
    await adapter.dispose();
    mount();
    await adapter.start();
    const reply = { source: received[0].source, text: 'reply', idempotencyKey: 'key' };
    assert.equal((await adapter.send(reply)).messageId, '18446744073709551603');
    await eventually(() => seen.length === 3);
    assert.equal(seen[2], 'saved-cursor');
    accept = false;
    await assert.rejects(adapter.send(reply), { code: 'REPLY_WINDOW_EXPIRED', deliveryOutcome: 'not_sent' });
    await adapter.dispose();
    config.tokenRef = 'new-secret-ref';
    mount();
    await adapter.start();
    await eventually(() => seen.length === 4);
    assert.equal(seen[3], '');
    await assert.rejects(adapter.send(reply), { code: 'REPLY_WINDOW_EXPIRED' });
  } finally { await adapter?.dispose(); }
});

test('微信收到明确过期回执时呈现重新扫码状态并停止轮询', async () => {
  let calls = 0;
  const adapter = createWeixinAdapter({ getConfig: () => ({ enabled: true, accountId: 'bot', tokenRef: 'ref' }), allowUnboundAuthorization: true,
    credentials: { resolve: async () => ({ value: 'secret' }) }, ingest: () => assert.fail('expired token received an event'),
    fetcher: async () => { calls++; return Response.json({ errcode: -14 }); }, pollDelayMs: 1 });
  try {
    await adapter.start();
    await eventually(async () => (await adapter.status()).authentication === 'failed');
    assert.match((await adapter.status()).error, /重新扫码/);
    assert.equal(calls, 1);
  } finally { await adapter.dispose(); }
});

const telegramIdentity = { id: 8, username: 'personal_bot', is_bot: true };
const telegramMessage = (chatId, updateId) => ({ update_id: updateId,
  message: { chat: { type: 'supergroup', id: chatId }, from: { id: 50 }, message_id: updateId,
    date: 1700000000, message_thread_id: 19, text: '@personal_bot 好', entities: [{ type: 'mention', offset: 0, length: 13 }] } });
const telegramOk = result => Response.json({ ok: true, result });
const telegramConfig = { enabled: true, botTokenRef: 'ref', ownerIds: ['50'], chatIds: ['-55'] };
const telegramOptions = { getConfig: () => telegramConfig, allowUnboundAuthorization: true,
  credentials: { resolve: async () => ({ value: '123:token' }) }, retryMs: 1 };

test('Telegram 跳过无效与范围外更新，仅在入站确认后推进并跨重启续接', async () => {
  const received = [], offsets = [], observed = [];
  let saved, transient = true;
  const runtimeState = () => ({ read: async () => saved, write: async state => { saved = state; } });
  const options = { ...telegramOptions, runtimeState, observeSource: source => observed.push(source.chatId),
    ingest: async event => {
      if (transient) { transient = false; throw new Error('durable write failure'); }
      received.push(event.normalize());
      return { ignored: false };
    },
    fetcher: async (url, init) => {
      if (url.endsWith('getMe')) return telegramOk(telegramIdentity);
      const { offset } = JSON.parse(init.body);
      offsets.push(offset);
      if (offset === 0) return telegramOk([telegramMessage(-99, 100), { update_id: 101, message: { chat: {} } }, telegramMessage(-55, 102)]);
      if (offset === 102) return telegramOk([telegramMessage(-55, 102)]);
      return abortable(init.signal);
    } };
  let adapter = createTelegramAdapter(options);
  try {
    await adapter.start();
    await eventually(() => offsets.includes(103));
    assert.deepEqual(offsets, [0, 102, 103]);
    assert.deepEqual(observed, ['-99']);
    assert.equal(received.length, 1);
    assert.equal(received[0].source.topicId, '19');
    assert.equal(received[0].mentioned, true);
    assert.equal(adapter.status().events, 'verified');
    await adapter.dispose();
    adapter = createTelegramAdapter(options);
    await adapter.start();
    await eventually(() => offsets.length === 4);
    assert.equal(offsets[3], 103);
  } finally { await adapter.dispose(); }
});

test('Telegram 只采用平台明确 @ 的群消息及真实发送者', () => {
  const update = telegramMessage(-55, 100);
  update.message.entities = [];
  update.message.reply_to_message = { message_id: 99, from: { id: 8 } };
  const reply = normalizeTelegramEvent(update, telegramIdentity);
  assert.equal(reply.mentioned, false);
  assert.equal(reply.source.parentMessageId, '-55:99');
  update.message.sender_chat = { id: -55 };
  assert.equal(normalizeTelegramEvent(update, telegramIdentity), null);
});

test('Telegram 区分冲突、凭据错误、网络失败与限流', async t => {
  const modes = [
    [409, 'Conflict: can\'t use getUpdates method while webhook is active', /Webhook/],
    [409, 'Conflict: terminated by other getUpdates request', /其他实例/],
    [401, 'Unauthorized', /Token 无效/],
    [429, 'Too Many Requests', /限流/],
    [null, 'fixture-secret network error', /宿主能否访问/],
  ];
  for (const [code, description, expected] of modes) await t.test(description, async () => {
    const adapter = createTelegramAdapter({ ...telegramOptions, retryMs: 5000, ingest: () => assert.fail('no valid update'),
      fetcher: async url => {
        if (url.endsWith('getMe')) return telegramOk(telegramIdentity);
        if (!code) throw new Error(description);
        return Response.json({ ok: false, error_code: code, description, parameters: { retry_after: 5 } }, { status: code });
      } });
    try {
      await adapter.start();
      await eventually(() => adapter.status().error);
      assert.match(adapter.status().error, expected);
      assert.equal(adapter.status().events, 'unverified');
      assert.equal(adapter.status().authentication, code === 401 ? 'failed' : 'verified');
    } finally { await adapter.dispose(); }
  });
});
