import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApiAdapter } from '../src/channels/api.mjs';
import { createWebhookAdapter } from '../src/channels/webhook.mjs';
import { channelMessageChunks } from '../src/channels/message-chunks.mjs';

test('long channel replies retain every Unicode character within platform limits', () => {
  const text = '测试🙂\n'.repeat(2000), parts = channelMessageChunks(text);
  assert.ok(parts.length > 1); assert.equal(parts.join(''), text);
  for (const part of parts) { assert.ok(Buffer.byteLength(part) <= 1800); assert.doesNotMatch(part, /\uFFFD/); }
});

test('API submit trusts host principal and authenticated actor, preserves idempotent source', async () => {
  let config = { enabled: true, ownerIds: ['bound-owner'], accountId: 'API:Exact' }; const events = [];
  const api = createApiAdapter({ allowUnboundAuthorization: true, getConfig: () => config, ingest: async event => events.push(event) });
  const input = { operation: 'submit', requestId: 'event:1', conversationId: 'project/topic', text: 'hello', actorId: 'spoof', ownerAuthenticated: true };
  await assert.rejects(api.operation(input), { status: 403 });
  await api.operation(input, { principal: { kind: 'owner', id: 'host-owner' } });
  await api.operation(input, { principal: { kind: 'owner', id: 'host-owner' } });
  assert.equal(events[0].actor.id, 'host-owner'); assert.equal(events[0].sourceKey, events[1].sourceKey);
  assert.equal((await api.send({ source: events[0].source, idempotencyKey: 'result' })).deliveryMode, 'pull');
  config = { ...config, enabled: false }; await assert.rejects(api.operation(input, { principal: { kind: 'owner', id: 'host-owner' } }), /未启用/);
});

test('Webhook verifies exact body and timestamp before durable admission, binds actor', async () => {
  const events = [], time = 1793700000000, secret = 'private-signing-key'; let enabled = true;
  const adapter = createWebhookAdapter({ allowUnboundAuthorization: true, getConfig: () => ({ enabled, ownerIds: ['owner'], signingSecretRef: 'REF', chatIds: ['room'] }), credentials: { resolve: async () => ({ value: secret }) }, ingest: async event => { events.push(event); return { trigger: { id: 'trigger' } }; }, now: () => time });
  const body = JSON.stringify({ requestId: 'id', conversationId: 'room', text: 'do work', actorId: 'spoof', owner: true });
  const request = (raw = body, timestamp = String(time / 1000), key = secret) => new Request('https://benchgo.test/api/commander/assistant/channels/webhook', { method: 'POST', body: raw, headers: { 'x-benchgo-timestamp': timestamp, 'x-benchgo-signature': createHmac('sha256', key).update(timestamp + '.').update(raw).digest('hex') } });
  assert.equal((await adapter.handle(request(body, String(time / 1000 - 301)))).status, 401);
  assert.equal((await adapter.handle(request(body, undefined, 'wrong'))).status, 401);
  assert.equal(events.length, 0);
  const receipt = await adapter.handle(request()); assert.equal(receipt.status, 202);
  assert.equal(events[0].actor.id, 'benchgo-webhook'); assert.equal(JSON.stringify(events).includes(secret), false);
  assert.equal((await adapter.status()).events, 'verified');
  enabled = false; assert.equal((await adapter.handle(request())).status, 409);
});

test('Webhook rejects oversized signed bodies and does not acknowledge failed persistence', async () => {
  const secret = 'key', timestamp = String(Math.floor(Date.now() / 1000));
  const adapter = createWebhookAdapter({ allowUnboundAuthorization: true, getConfig: () => ({ enabled: true, ownerIds: ['owner'], signingSecretRef: 'REF' }), credentials: { resolve: async () => ({ value: secret }) }, ingest: async () => { throw new Error('private internal details'); } });
  const req = raw => new Request('https://benchgo.test/webhook', { method: 'POST', body: raw, headers: { 'x-benchgo-timestamp': timestamp, 'x-benchgo-signature': createHmac('sha256', secret).update(timestamp + '.').update(raw).digest('hex') } });
  assert.equal((await adapter.handle(req('x'.repeat(65537)))).status, 413);
  const result = await adapter.handle(req(JSON.stringify({ requestId: '1', conversationId: 'r', text: 'hello' })));
  assert.equal(result.status, 503); assert.doesNotMatch(await result.text(), /private/);
});

test('API source verification precedes body normalization and requires real principal ID', async () => {
  let normalized = false;
  const input = { operation: 'submit', requestId: 'r', conversationId: 'room', get text() { normalized = true; return 'hello'; } };
  const api = createApiAdapter({ getConfig: () => ({ enabled: true }), authorizeConnection: ({ source, actor }) => { assert.equal(normalized, false); assert.equal(actor.id, 'real'); assert.equal(source.conversationId, 'room'); }, ingest: async event => { assert.equal(normalized, false); return event.normalize(); } });
  await assert.rejects(api.operation(input, { principal: { kind: 'owner' } }), /principal ID/);
  const result = await api.operation(input, { principal: { kind: 'owner', id: 'real' } });
  assert.equal(result.result.text, 'hello'); assert.equal(result.result.actor.owner, undefined);
});

test('gateway authorization fails closed and revoked send never succeeds', async () => {
  const api = createApiAdapter({ getConfig: () => ({ enabled: true }), ingest: async () => {} });
  await assert.rejects(api.operation({ operation: 'submit', requestId: 'r', conversationId: 'c', text: 'hello' }, { principal: { kind: 'owner', id: 'real' } }), /统一授权/);
  const revoked = createApiAdapter({ getConfig: () => ({ enabled: true }), authorizeConnection: () => false });
  await assert.rejects(revoked.send({ source: { channel: 'api', accountId: 'benchgo-api' }, idempotencyKey: 'r' }), /撤销/);
});
