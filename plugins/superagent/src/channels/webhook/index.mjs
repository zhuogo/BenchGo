import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { apiConfig, gatewayEvent, gatewaySource } from '../api/index.mjs';
import { authorizeChannel } from '../connection-authorization.mjs';
import { beforeDelivery } from '../delivery-outcome.mjs';

export const channelDefinition = {
  id: 'webhook', label: 'Webhook', defaults: { accountId: 'benchgo-webhook', signingSecretRef: '' },
  fields: [{ key: 'accountId', label: '接入名称', type: 'text', required: true }, { key: 'signingSecretRef', label: '签名密钥', type: 'secretRef', required: true }],
  capabilities: { externalActions: [], text: true, signedEvents: true, pullResults: true, attachments: false },
  help: 'POST /api/commander/assistant/channels/webhook。使用签名密钥及时间戳认证；密钥绑定当前机器连接身份。结果保存在工单中，通过已认证 API 查询。',
};
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function webhookConfig(input = {}) {
  const c = apiConfig({ ...channelDefinition.defaults, ...input });
  if (typeof c.signingSecretRef !== 'string' || (c.enabled && !c.signingSecretRef)) throw fail('请配置 Webhook 签名凭据');
  return c;
}
export function createWebhookAdapter(options) {
  const { getConfig, credentials, ingest, now = Date.now } = options;
  let disposed = false, verified = false, received = false;
  const read = async () => { if (disposed) throw fail('Webhook 已停止', 503); return webhookConfig(await getConfig()); };
  const secret = async c => { const value = (await credentials.resolve(c.signingSecretRef))?.value; if (!value) throw fail('Webhook 签名凭据不可用', 503); return value; };
  const status = async () => { const c = await read(); return { enabled: c.enabled, configured: !!c.signingSecretRef, authentication: verified ? 'verified' : 'unverified', events: received ? 'verified' : 'unverified', sending: 'pull', connection: { state: !c.enabled ? 'stopped' : received ? 'connected' : 'listening' } }; };
  return {
    start: status, status,
    async verify() { const c = await read(); if (!c.enabled) throw fail('Webhook 未启用', 409); await secret(c); return { ...await status(), note: '签名凭据可读取，真实签名请求接收后才标记认证已验证' }; },
    async handle(request) {
      try {
        const c = await read(); if (!c.enabled) throw fail('Webhook 未启用', 409);
        if (request.method !== 'POST') throw fail('Method not allowed', 405);
        const timestamp = request.headers.get('x-benchgo-timestamp'), supplied = request.headers.get('x-benchgo-signature');
        if (!/^\d{10}$/.test(timestamp || '') || Math.abs(now() - Number(timestamp) * 1000) > 300000 || !/^[a-f0-9]{64}$/i.test(supplied || '')) throw fail('Webhook 签名或时间戳无效', 401);
        await authorizeChannel(options, 'history', { channel: 'webhook', accountId: c.accountId, sourceType: 'system', conversationId: null, chatId: null, topicId: null }, { id: c.accountId, kind: 'machine' });
        const reader = request.body?.getReader(); if (!reader) throw fail('请求正文为空');
        const chunks = []; let size = 0;
        try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 65536) { await reader.cancel(); throw fail('请求正文超过 64 KB', 413); } chunks.push(item.value); } } finally { reader.releaseLock(); }
        const raw = Buffer.concat(chunks), expected = createHmac('sha256', await secret(c)).update(timestamp + '.').update(raw).digest();
        if (!timingSafeEqual(expected, Buffer.from(supplied, 'hex'))) throw fail('Webhook 签名无效', 401);
        let body; try { body = JSON.parse(raw); } catch { throw fail('请求 JSON 无效'); }
        const event = gatewaySource('webhook', c, body, { id: c.accountId, kind: 'machine' });
        await authorizeChannel(options, 'receive', event.source, event.actor);
        if (JSON.stringify(await read()) !== JSON.stringify(c)) throw fail('Webhook 配置已变更', 409);
        // Stable sourceKey is deduplicated in the persistent intake ledger, including restarts.
        const result = await ingest({ ...event, normalize: () => gatewayEvent('webhook', c, body, event.actor) }); verified = true; received = true;
        return Response.json({ accepted: true, requestId: body.requestId, threadId: event.threadId, triggerId: result?.trigger?.id }, { status: 202 });
      } catch (error) { return Response.json({ error: error.status && error.status < 500 ? error.message : 'Webhook 暂未受理，请使用相同 requestId 重试' }, { status: error.status || 503 }); }
    },
    async send({ source, idempotencyKey }) {
      await beforeDelivery(async () => {
        const c = await read();
        await authorizeChannel(options, 'send', source);
        if (!c.enabled || source?.channel !== 'webhook' || source.accountId !== c.accountId) throw fail('Webhook 交付来源已撤销', 403);
      });
      return { status: 'accepted', messageId: `pull:${createHash('sha256').update(String(idempotencyKey)).digest('hex')}`, deliveryMode: 'pull' };
    },
    dispose() { disposed = true; },
  };
}
