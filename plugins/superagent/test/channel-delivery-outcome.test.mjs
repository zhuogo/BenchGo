import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeishuAdapter } from '../src/channels/feishu/index.mjs';
import { createWhatsAppAdapter } from '../src/channels/whatsapp/index.mjs';
import { createTelegramAdapter } from '../src/channels/telegram/index.mjs';
import { createChannelRuntime } from '../src/channel-runtime.mjs';
import { loadChannelModules } from '../src/channel-catalog.mjs';

const common = { allowUnboundAuthorization: true, ingest: async () => {}, credentials: { resolve: async () => ({ value: 'fixture-token' }) } };
const factories = {
  feishu: fetcher => ({
    adapter: createFeishuAdapter({ ...common, getConfig: () => ({ enabled: true, appId: 'app', appSecretRef: 'secret' }),
      fetcher: (url, options) => url.includes('/auth/') ? Response.json({ code: 0, tenant_access_token: 'fixture-token', expire: 3600 }) : fetcher(url, options) }),
    source: { channel: 'feishu', appId: 'app', chatId: 'chat', messageId: 'original' }, reject: { code: 99991663 },
  }),
  whatsapp: fetcher => ({
    adapter: createWhatsAppAdapter({ ...common, getConfig: () => ({ enabled: true, phoneNumberId: 'phone', accessTokenRef: 'token', appSecretRef: 'secret', verificationTokenRef: 'verify' }), fetcher }),
    source: { channel: 'whatsapp', appId: 'phone', accountId: 'phone', chatId: 'chat', messageId: 'original' }, reject: { error: { code: 131047 } },
  }),
  telegram: fetcher => ({
    adapter: createTelegramAdapter({ ...common, getConfig: () => ({ enabled: true, botTokenRef: 'token' }),
      fetcher: (url, options) => url.endsWith('getMe') ? Response.json({ ok: true, result: { id: 1, is_bot: true } }) : fetcher(url, options) }),
    source: { channel: 'telegram', accountId: '1', chatId: 'chat', messageId: 'original' }, reject: { ok: false, error_code: 429 },
  }),
};

for (const [channel, create] of Object.entries(factories)) test(`${channel} classifies validation, rejection, timeout and missing receipts`, async () => {
  let mode = 'reject', reject;
  const h = create(async () => {
    if (mode === 'timeout') throw new Error('timeout after request');
    if (mode === 'invalid') return new Response('not json', { status: 200 });
    if (mode === 'null') return Response.json(null);
    if (mode === 'server-timeout') return Response.json({}, { status: 408 });
    if (mode === 'missing') return Response.json(channel === 'feishu' ? { code: 0, data: {} } : channel === 'telegram' ? { ok: true, result: {} } : {});
    return Response.json(reject, { status: 400 });
  });
  reject = h.reject;
  const input = { source: h.source, text: 'hello', idempotencyKey: 'opaque-key' };
  try {
    await assert.rejects(h.adapter.send({ ...input, text: '' }), { deliveryOutcome: 'not_sent' });
    await assert.rejects(h.adapter.send(input), { deliveryOutcome: 'not_sent' });
    for (mode of ['timeout', 'server-timeout', 'invalid', 'null', 'missing']) await assert.rejects(h.adapter.send(input), { deliveryOutcome: 'unknown' });
  } finally { await h.adapter.dispose(); }
});

test('credential acquisition failure proves no outbound message was sent', async () => {
  let calls = 0;
  const adapter = createFeishuAdapter({ ingest: async () => {}, credentials: { resolve: async () => null },
    getConfig: () => ({ enabled: true, appId: 'app', appSecretRef: 'secret' }), fetcher: async () => { calls++; throw new Error('unexpected'); } });
  try {
    await assert.rejects(adapter.send({ source: { channel: 'feishu', appId: 'app', chatId: 'chat', messageId: 'origin' }, text: 'hello', idempotencyKey: 'key' }), { deliveryOutcome: 'not_sent' });
    assert.equal(calls, 0);
  } finally { adapter.dispose(); }
});

test('multi-part output preserves confirmed receipts and never labels a partial rejection wholly unsent', async () => {
  await loadChannelModules();
  const config = { enabled: true, phoneNumberId: 'phone', accessTokenRef: 'token', appSecretRef: 'secret', verificationTokenRef: 'verify' };
  let calls = 0;
  const runtime = createChannelRuntime({ ctx: {}, store: { connections: { read: () => ({ config, revision: 1 }) } },
    adapterOptions: { ...common, fetcher: async () => ++calls === 1 ? Response.json({ messages: [{ id: 'first-part' }] }) : Response.json({ error: { code: 131047 } }, { status: 400 }) } });
  try {
    await runtime.restart('whatsapp');
    await assert.rejects(runtime.get('whatsapp').send({ source: { channel: 'whatsapp', appId: 'phone', accountId: 'phone', sourceType: 'direct', conversationId: 'chat', chatId: 'chat', messageId: 'origin', connectionRevision: 1 }, text: 'x'.repeat(2000), idempotencyKey: 'key' }), error => {
      assert.equal(error.deliveryOutcome, 'unknown');
      assert.equal(error.receipt.parts[0].messageId, 'first-part');
      return true;
    });
    assert.equal(calls, 2);
    await assert.rejects(runtime.get('whatsapp').send({ source: { connectionRevision: 0 }, text: 'hello' }), { deliveryOutcome: 'not_sent' });
    assert.equal(calls, 2);
  } finally { await runtime.dispose(); }
});
