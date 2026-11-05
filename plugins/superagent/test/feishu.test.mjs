import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { createFeishuAdapter, feishuConfig, normalizeFeishuEvent, feishuSourceAllowed } from '../src/feishu.mjs';

const config = () => feishuConfig({ enabled: true, appId: 'app', appSecretRef: 'secret-ref', verificationTokenRef: 'verify-ref', botOpenId: 'bot', ownerOpenIds: ['owner'], chatIds: ['chat'] });
const event = () => ({ schema: '2.0', header: { app_id: 'app', token: 'verify-value', event_id: 'event', event_type: 'im.message.receive_v1' }, event: { sender: { sender_type: 'user', sender_id: { open_id: 'owner' } }, message: { message_id: 'message', chat_id: 'chat', chat_type: 'group', create_time: '1780000000000', message_type: 'text', content: JSON.stringify({ text: '@_user_1 帮我看看' }), mentions: [{ id: { open_id: 'bot' }, key: '@_user_1' }] } } });
const req = (body, headers = {}) => new Request('https://benchgo.test/feishu', { method: 'POST', body: JSON.stringify(body), headers });

test('new group scope separates direct messages and preserves legacy access defaults', () => {
  const legacy = config(), source = { appId: 'app', chatId: 'other', chatType: 'p2p' };
  assert.equal(legacy.accessMode, 'owners');
  assert.equal(feishuSourceAllowed(legacy, source), false);
  const next = feishuConfig({ ...legacy, accessMode: 'platform', groups: [{ chatId: 'chat', name: '测试群', mode: 'mentions' }] });
  assert.equal(feishuSourceAllowed(next, source), true);
  assert.equal(feishuSourceAllowed(next, { ...source, chatType: 'group' }), false);
  assert.equal(feishuSourceAllowed(next, { ...source, chatId: 'chat', chatType: 'group' }), true);
  next.directMessages = false;
  assert.equal(feishuSourceAllowed(next, source), false);
  assert.throws(() => feishuConfig({ groups: [{ chatId: 'a', mode: 'all' }, { chatId: 'a', mode: 'mentions' }] }), /重复/);
});

test('disabled saved connection can verify and paginate joined chats without sending messages', async () => {
  const current = { ...config(), enabled: false }, calls = [];
  const adapter = createFeishuAdapter({ getConfig: () => current, credentials: { resolve: async () => ({ value: 'secret' }) }, ingest() {}, fetcher: async url => {
    calls.push(url);
    return Response.json(url.includes('/auth/') ? { code: 0, tenant_access_token: 'token', expire: 7200 } : url.includes('/bot/') ? { code: 0, bot: { open_id: 'bot', app_name: '窝头' } } : { code: 0, data: { items: [{ chat_id: 'chat', name: '无敌大队' }], has_more: true, page_token: 'next:opaque' } });
  } });
  assert.equal((await adapter.verify()).botName, '窝头');
  assert.deepEqual(await adapter.listChats({ pageToken: 'page:opaque' }), { chats: [{ chatId: 'chat', name: '无敌大队' }], nextPageToken: 'next:opaque' });
  assert.ok(calls.at(-1).includes('page_token=page%3Aopaque'));
  assert.equal(calls.some(url => url.includes('/reply')), false);
  adapter.dispose();
});

test('history is anchored, bounded to the same chat and fails visibly on permission errors', async () => {
  const current = config(), source = normalizeFeishuEvent(event(), current).source;
  const row = (message_id, chat_id = 'chat') => ({ message_id, chat_id, create_time: '1780000000000', msg_type: 'text', body: { content: JSON.stringify({ text: message_id }) }, sender: { id: 'owner', sender_type: 'user' } });
  let failHistory = false, revoked = false;
  const adapter = createFeishuAdapter({ getConfig: () => current, credentials: { resolve: async () => ({ value: 'secret' }) }, ingest() {}, fetcher: async url => {
    if (url.includes('/auth/')) return Response.json({ code: 0, tenant_access_token: 'token', expire: 7200 });
    if (url.includes('/messages?')) {
      if (revoked) current.chatIds = ['other'];
      return Response.json(failHistory ? { code: 99991672 } : { code: 0, data: { items: [row('before'), row('foreign', 'foreign')] } });
    }
    return Response.json({ code: 0, data: { items: [row('message')] } });
  } });
  const result = await adapter.readContext({ source });
  assert.equal(result.status, 'available');
  assert.deepEqual(result.messages.map(row => row.messageId), ['message', 'before']);
  failHistory = true;
  assert.equal((await adapter.readContext({ source })).status, 'partial');
  failHistory = false; revoked = true;
  await assert.rejects(adapter.readContext({ source }), /配置已变更/);
  adapter.dispose();
});
function fixture(options = {}) {
  const calls = [], ingested = [], current = config();
  const values = { 'secret-ref': 'secret-value', 'verify-ref': 'verify-value', 'encrypt-ref': 'encrypt-value' };
  const adapter = createFeishuAdapter({ getConfig: () => current, credentials: { resolve: async ref => ({ value: values[ref] }) }, ingest: async value => { ingested.push(value); }, fetcher: async (url, options) => { calls.push({ url, options }); return Response.json(url.includes('/auth/') ? { code: 0, tenant_access_token: 'access-token', expire: 7200 } : url.includes('/bot/') ? { code: 0, bot: { open_id: 'bot' } } : { code: 0, data: { message_id: 'reply' } }); }, ...options });
  return { adapter, calls, ingested, current, values };
}

test('bot identity persistence does not erase successful credential verification', async () => {
  const f = fixture();
  f.current.botOpenId = '';
  const verified = await f.adapter.verify();
  f.current.botOpenId = verified.botOpenId;
  assert.equal((await f.adapter.status()).authentication, 'verified');
  f.current.appSecretRef = 'changed';
  assert.equal((await f.adapter.status()).authentication, 'unverified');
  f.adapter.dispose();
});

test('history failure retains locally received source discussion as reference only', async () => {
  let ingested = false;
  const f = fixture({ readLocalContext: async () => [{ messageId: 'local', text: 'Existing discussion', createdAt: '2026-11-03T00:00:00.000Z' }],
    ingest: async () => { ingested = true; }, fetcher: async url => Response.json(url.includes('/auth/') ? { code: 0, tenant_access_token: 'token', expire: 7200 } : { code: 99991672 }) });
  const context = await f.adapter.readContext({ source: { channel: 'feishu', appId: 'app', chatId: 'chat', messageId: 'anchor' } });
  assert.equal(context.status, 'partial');
  assert.equal(context.messages[0].text, 'Existing discussion');
  assert.equal(ingested, false);
  f.adapter.dispose();
});

test('configuration contains references only and rejects inline secrets', () => {
  assert.throws(() => feishuConfig({ appSecret: 'leak' }), /未知/);
  assert.throws(() => feishuConfig({ enabled: true }), /引用/);
  assert.deepEqual(feishuConfig({ ownerOpenIds: ['a', 'a'] }).ownerOpenIds, ['a']);
});

test('rich text is readable and unsupported attachments are not presented as parsed content', () => {
  const input = event(); input.event.message.message_type = 'post';
  input.event.message.content = JSON.stringify({ zh_cn: { title: '项目说明', content: [[{ tag: 'text', text: '参考 ' }, { tag: 'a', text: '文档', href: 'https://example.test' }]] } });
  assert.equal(normalizeFeishuEvent(input, config()).text, '项目说明\n参考 文档 (https://example.test)');
  input.event.message.message_type = 'file'; input.event.message.content = JSON.stringify({ file_key: 'private-resource-key' });
  const normalized = normalizeFeishuEvent(input, config());
  assert.match(normalized.text, /暂不支持/); assert.doesNotMatch(normalized.text, /private-resource-key/);
});
test('verified metadata determines mention and ownership, raw event excludes auth token', () => {
  const input = event(), normalized = normalizeFeishuEvent(input, config());
  assert.equal(normalized.mentioned, true);
  assert.equal(normalized.actor.owner, true);
  assert.equal(normalized.sourceKey, 'feishu:app:message');
  assert.equal(JSON.stringify(normalized).includes('verify-value'), false);
  input.event.message.mentions = [];
  assert.equal(normalizeFeishuEvent(input, config()).mentioned, false);
  input.event.sender.sender_id.open_id = 'bot';
  assert.equal(normalizeFeishuEvent(input, config()), null);
});
test('reply metadata preserves opaque parent and root IDs in group and direct messages', () => {
  const input = event();
  Object.assign(input.event.message, { parent_id: 'parent:opaque', root_id: 'root:opaque', thread_id: 'thread:opaque' });
  let normalized = normalizeFeishuEvent(input, config());
  assert.equal(normalized.source.parentMessageId, 'parent:opaque');
  assert.equal(normalized.source.rootMessageId, 'root:opaque');
  assert.equal(normalized.threadId, 'feishu:app:chat:thread:opaque');
  assert.equal(normalized.source.replyInThread, true);
  input.event.message.chat_type = 'p2p';
  normalized = normalizeFeishuEvent(input, config());
  assert.equal(normalized.threadId, 'feishu:app:chat:direct');
  assert.equal(normalized.source.parentMessageId, 'parent:opaque');
  for (const key of ['parent_id', 'root_id', 'thread_id']) {
    const invalid = structuredClone(input);
    invalid.event.message[key] = { id: 'not-an-id' };
    assert.throws(() => normalizeFeishuEvent(invalid, config()), /关联标识/);
  }
  const plain = normalizeFeishuEvent(event(), config());
  assert.equal(Object.hasOwn(plain.source, 'parentMessageId'), false);
  assert.equal(Object.hasOwn(plain.source, 'rootMessageId'), false);
});
test('callback verifies token/app and acknowledges only after durable ingestion', async () => {
  const f = fixture();
  let e = event(); e.header.token = 'forged';
  assert.equal((await f.adapter.handle(req(e))).status, 401);
  e = event(); e.header.app_id = 'other';
  assert.equal((await f.adapter.handle(req(e))).status, 401);
  assert.equal(f.ingested.length, 0);
  assert.equal((await f.adapter.handle(req(event()))).status, 200);
  assert.equal(f.ingested.length, 1);
  assert.equal((await f.adapter.status()).events, 'verified');
  assert.equal((await f.adapter.status()).sending, 'unverified');
  e = event(); e.event.message.chat_id = 'outside';
  assert.equal((await f.adapter.handle(req(e))).status, 200);
  assert.equal(f.ingested.length, 1);
  const failing = fixture({ ingest: async () => { throw Error('private content'); } });
  const response = await failing.adapter.handle(req(event()));
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('private content'), false);
});
test('challenge authenticates without declaring event subscription verified', async () => {
  const f = fixture();
  const response = await f.adapter.handle(req({ type: 'url_verification', token: 'verify-value', challenge: 'challenge' }));
  assert.deepEqual(await response.json(), { challenge: 'challenge' });
  assert.equal((await f.adapter.status()).events, 'unverified');
});
test('encrypted callback verifies raw body signature and timestamp before decrypting', async () => {
  const now = 1780000000000, f = fixture({ now: () => now }); f.current.encryptKeyRef = 'encrypt-ref';
  const iv = Buffer.alloc(16, 1), key = createHash('sha256').update('encrypt-value').digest();
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const body = { encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(event())), cipher.final()]).toString('base64') };
  const timestamp = String(now / 1000), nonce = 'nonce';
  const signature = createHash('sha256').update(timestamp + nonce + 'encrypt-value' + JSON.stringify(body)).digest('hex');
  const headers = { 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': signature };
  assert.equal((await f.adapter.handle(req(body, headers))).status, 200);
  assert.equal(f.ingested.length, 1);
  assert.equal((await f.adapter.handle(req(body, { ...headers, 'x-lark-signature': 'bad' }))).status, 401);
  assert.equal((await f.adapter.handle(req(body, { ...headers, 'x-lark-request-timestamp': '1' }))).status, 401);
});
test('reply retains stable UUID, exact source, and accepted differs from delivered', async () => {
  const f = fixture(), source = normalizeFeishuEvent(event(), config()).source;
  assert.equal((await f.adapter.verify()).botOpenId, 'bot');
  const input = { source, text: '结果原文', idempotencyKey: 'delivery-1' };
  const first = await f.adapter.send(input), second = await f.adapter.send(input);
  assert.equal(first.status, 'accepted'); assert.equal(first.uuid, second.uuid);
  assert.equal(f.calls.filter(call => call.url.includes('/auth/')).length, 1);
  const sent = JSON.parse(f.calls.at(-1).options.body);
  assert.equal(JSON.parse(sent.content).text, input.text);
  assert.equal(f.calls.at(-1).url.endsWith('/message/reply'), true);
  await assert.rejects(f.adapter.send({ ...input, source: { ...source, appId: 'other' } }), /范围/);
  f.values['secret-ref'] = 'rotated'; await f.adapter.send(input);
  assert.equal(f.calls.filter(call => call.url.includes('/auth/')).length, 2);
  f.current.enabled = false;
  await assert.rejects(f.adapter.send(input), /未启用/);
});
test('transport failure is explicit and never exposes provider response secrets', async () => {
  const f = fixture({ fetcher: async () => Response.json({ code: 999, msg: 'secret-value' }, { status: 403 }) });
  await assert.rejects(f.adapter.verify(), error => !error.message.includes('secret-value') && error.status === 502);
  assert.equal((await f.adapter.status()).authentication, 'failed');
  f.adapter.dispose(); await assert.rejects(f.adapter.status(), /abort/i);
});
test('disabling while token request is pending prevents the subsequent message send', async () => {
  let finish; const started = new Promise(resolve => { finish = resolve; });
  let release; const pending = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const f = fixture({ fetcher: async () => { calls++; finish(); await pending; return Response.json({ code: 0, tenant_access_token: 'access', expire: 3600 }); } });
  const sending = f.adapter.send({ source: normalizeFeishuEvent(event(), config()).source, text: 'result', idempotencyKey: 'pending' });
  await started; f.current.enabled = false; release();
  await assert.rejects(sending, /未启用/);
  assert.equal(calls, 1);
});
