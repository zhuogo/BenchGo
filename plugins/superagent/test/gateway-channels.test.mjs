import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiAdapter } from '../src/channels/api/index.mjs';
import { channelMessageChunks } from '../src/channels/message-chunks.mjs';

test('long channel replies retain every Unicode character within platform limits', () => {
  const text = '测试🙂\n'.repeat(2000), parts = channelMessageChunks(text);
  assert.ok(parts.length > 1); assert.equal(parts.join(''), text);
  for (const part of parts) { assert.ok(Buffer.byteLength(part) <= 1800); assert.doesNotMatch(part, /\uFFFD/); }
});

test('external requests use the same owner identity and preserve idempotent source', async () => {
  let config = { enabled: true, accountId: 'API:Exact' }; const events = [];
  const api = createApiAdapter({ allowUnboundAuthorization: true, getConfig: () => config, ingest: async event => events.push(event) });
  const input = { operation: 'submit', requestId: 'event:1', conversationId: 'project/topic', text: 'hello', actorId: 'spoof', ownerAuthenticated: true };
  await assert.rejects(api.operation(input), { status: 403 });
  await api.operation(input, { principal: { kind: 'owner', id: 'host-owner' } });
  await api.operation(input, { principal: { kind: 'owner', id: 'another-session-owner' } });
  assert.deepEqual(events.map(event => event.actor), [{ id: 'desktop-owner', kind: 'human' }, { id: 'desktop-owner', kind: 'human' }]);
  assert.equal(events[0].sourceKey, events[1].sourceKey);
  assert.equal((await api.send({ source: events[0].source, idempotencyKey: 'result' })).deliveryMode, 'pull');
  config = { ...config, enabled: false }; await assert.rejects(api.operation(input, { principal: { kind: 'owner', id: 'host-owner' } }), /未启用/);
});

test('API source verification precedes body normalization and requires real principal ID', async () => {
  let normalized = false;
  const input = { operation: 'submit', requestId: 'r', conversationId: 'room', get text() { normalized = true; return 'hello'; } };
  const api = createApiAdapter({ getConfig: () => ({ enabled: true }), authorizeConnection: ({ source, actor }) => { assert.equal(normalized, false); assert.equal(actor.id, 'desktop-owner'); assert.equal(source.conversationId, 'room'); }, ingest: async event => { assert.equal(normalized, false); return event.normalize(); } });
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
