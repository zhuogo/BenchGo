import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { whatsappConfig, normalizeWhatsAppEvents, createWhatsAppAdapter } from '../src/whatsapp.mjs';

const config = () => whatsappConfig({ enabled: true, phoneNumberId: 'phone', accessTokenRef: 'access', appSecretRef: 'app', verificationTokenRef: 'verify', ownerIds: ['owner'] });
const event = () => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'phone' }, messages: [{ id: 'message', from: 'owner', timestamp: '1780000000', type: 'text', text: { body: '做这个项目' } }] } }] }] });
const request = (body, signature = true) => { const raw = JSON.stringify(body); return new Request('https://benchgo.test/whatsapp', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': signature ? 'sha256=' + createHmac('sha256', 'app-secret').update(raw).digest('hex') : 'bad' } }); };
function fixture() {
  const current = config(), inputs = [], calls = [];
  const adapter = createWhatsAppAdapter({ getConfig: () => current, credentials: { resolve: async ref => ({ value: `${ref}-secret` }) }, ingest: async input => inputs.push(input), fetcher: async (url, options) => { calls.push({ url, options }); return Response.json(options.method === 'GET' ? { id: 'phone' } : { messages: [{ id: 'reply' }] }); } });
  return { current, inputs, calls, adapter };
}
test('configuration rejects inline secrets and deduplicates permitted identities', () => {
  assert.throws(() => whatsappConfig({ accessToken: 'secret' }), /无效/);
  assert.throws(() => whatsappConfig({ enabled: true }), /凭据/);
  assert.deepEqual(whatsappConfig({ ownerIds: ['a', 'a'] }).ownerIds, ['a']);
});
test('normalization scopes phone identity, preserves thread, and derives ownership from configuration', () => {
  const body = event(), c = config();
  const [input] = normalizeWhatsAppEvents(body, c);
  assert.equal(input.actor.owner, true);
  assert.equal(input.sourceKey, 'whatsapp:phone:message');
  assert.equal(input.threadId, 'whatsapp:phone:owner:direct');
  c.phoneNumberId = 'other'; assert.deepEqual(normalizeWhatsAppEvents(body, c), []);
  c.phoneNumberId = 'phone'; c.chatIds = ['other']; assert.deepEqual(normalizeWhatsAppEvents(body, c), []);
});
test('webhook authenticates exact bytes before durable intake and retries intake failures', async () => {
  const f = fixture();
  assert.equal((await f.adapter.handle(request(event(), false))).status, 401);
  assert.equal(f.inputs.length, 0);
  assert.equal((await f.adapter.handle(request(event()))).status, 200);
  assert.equal(f.inputs.length, 1);
  const broken = createWhatsAppAdapter({ getConfig: config, credentials: { resolve: async () => ({ value: 'app-secret' }) }, ingest: async () => { throw new Error('private body'); } });
  const response = await broken.handle(request(event())); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private/);
});
test('verification challenge and Graph verification check credentials and account identity', async () => {
  const f = fixture();
  assert.equal((await f.adapter.handle(new Request('https://benchgo.test/?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=challenge'))).status, 401);
  const response = await f.adapter.handle(new Request('https://benchgo.test/?hub.mode=subscribe&hub.verify_token=verify-secret&hub.challenge=challenge'));
  assert.equal(await response.text(), 'challenge');
  assert.equal((await f.adapter.verify()).authentication, 'verified');
});
test('reply uses original message and chat; disallowed and revoked sources cannot send', async () => {
  const f = fixture(), source = normalizeWhatsAppEvents(event(), f.current)[0].source;
  assert.equal((await f.adapter.send({ source, text: '完成', idempotencyKey: 'key' })).messageId, 'reply');
  const payload = JSON.parse(f.calls[0].options.body);
  assert.equal(payload.to, 'owner'); assert.equal(payload.context.message_id, 'message');
  f.current.chatIds = ['other'];
  await assert.rejects(f.adapter.send({ source, text: '完成', idempotencyKey: 'key' }), /范围/);
  f.current.enabled = false;
  await assert.rejects(f.adapter.send({ source, text: '完成', idempotencyKey: 'key' }), /未启用/);
});
test('media explicitly reports unavailable body instead of pretending a transcription', () => {
  const body = event(); body.entry[0].changes[0].value.messages[0] = { id: 'audio', from: 'owner', timestamp: '1780000000', type: 'audio', audio: { id: 'asset' } };
  assert.match(normalizeWhatsAppEvents(body, config())[0].text, /不支持读取媒体正文/);
});
