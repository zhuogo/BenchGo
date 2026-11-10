import { createHash } from 'node:crypto';
import { authorizeChannel } from './connection-authorization.mjs';
import { beforeDelivery } from './delivery-outcome.mjs';

export const channelDefinition = {
  id: 'api', label: 'API Service', defaults: { accountId: 'benchgo-api' }, fields: [{ key: 'accountId', label: '接入名称', type: 'text', required: true }],
  capabilities: { externalActions: [], direct: true, text: true, pullResults: true, attachments: false },
  help: '复用 BenchGo 已认证 API。通过 connectionAction / submit 提交或续聊，使用 tickets 查询工单与结果；不需要另建服务或密钥。',
};
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
export function apiConfig(input = {}) {
  const c = { enabled: false, ownerIds: [], chatIds: [], ...channelDefinition.defaults, ...input };
  if (typeof c.enabled !== 'boolean' || !id(c.accountId) || !Array.isArray(c.ownerIds) || !c.ownerIds.every(id) || !Array.isArray(c.chatIds) || !c.chatIds.every(id)) throw fail('API 配置无效');
  return c;
}
export function gatewaySource(channel, c, input, actor) {
  if (!id(input.requestId) || !id(input.conversationId)) throw fail('请提供 requestId 和 conversationId');
  if (!actor || !id(actor.id)) throw fail('缺少已认证来源身份', 403);
  const sourceType = channel === 'webhook' ? 'system' : 'direct';
  const threadId = `${channel}:${c.accountId}:${input.conversationId}`;
  return { channel, sourceKey: `${channel}:${c.accountId}:${input.requestId}`, threadId, messageId: input.requestId,
    actor: { id: actor.id, kind: actor.kind }, sourceType, kind: sourceType,
    source: { channel, accountId: c.accountId, sourceType, conversationId: input.conversationId, chatId: input.conversationId, topicId: null, messageId: input.requestId, threadId } };
}
export function gatewayEvent(channel, c, input, actor) {
  const facts = gatewaySource(channel, c, input, actor);
  if (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > 32000) throw fail('请提供有效文字');
  return { ...facts, mentioned: false, occurredAt: new Date().toISOString(), text: input.text, raw: {} };
}
export function createApiAdapter(options) {
  const { getConfig, ingest } = options;
  let disposed = false, received = false;
  const read = async () => { if (disposed) throw fail('API 链接已停止', 503); return apiConfig(await getConfig()); };
  const status = async () => { const c = await read(); return { enabled: c.enabled, configured: !!c.accountId, authentication: 'host-authenticated', events: received ? 'verified' : 'unverified', sending: 'pull', connection: { state: c.enabled ? 'connected' : 'stopped' } }; };
  return {
    start: status, status, verify: status,
    async operation(input, { principal } = {}) {
      if (principal?.kind !== 'owner') throw fail('API 需要已认证的 BenchGo 主人会话', 403);
      if (!id(principal?.id || principal?.userId)) throw fail('Authenticated principal ID is required', 403);
      if (input.operation !== 'submit') throw fail('API 操作不支持；工单结果通过 tickets 查询，直接回复通过 connectionReplies 查询');
      const c = await read(); if (!c.enabled) throw fail('API 链接未启用', 409);
      const event = gatewaySource('api', c, input, { id: principal.id || principal.userId, kind: 'human' });
      await authorizeChannel(options, 'receive', event.source, event.actor);
      const latest = await read(); if (JSON.stringify(latest) !== JSON.stringify(c)) throw fail('API 配置已变更', 409);
      const result = await ingest({ ...event, normalize: () => gatewayEvent('api', c, input, event.actor) }); received = true;
      return { accepted: true, requestId: input.requestId, threadId: event.threadId, result };
    },
    async send({ source, idempotencyKey }) {
      await beforeDelivery(async () => {
        const c = await read();
        await authorizeChannel(options, 'send', source);
        if (!c.enabled || source?.channel !== 'api' || source.accountId !== c.accountId) throw fail('API 交付来源已撤销', 403);
      });
      // Tickets and direct replies each have a durable, owner-readable result mailbox.
      return { status: 'accepted', messageId: `pull:${createHash('sha256').update(String(idempotencyKey)).digest('hex')}`, deliveryMode: 'pull' };
    },
    dispose() { disposed = true; },
  };
}
