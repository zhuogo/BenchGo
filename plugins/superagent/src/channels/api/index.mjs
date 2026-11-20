import { createHash } from 'node:crypto';
import { ownerChannelActorId } from '../../channel-policy.mjs';
import { authorizeChannel } from '../connection-authorization.mjs';
import { beforeDelivery } from '../delivery-outcome.mjs';

export const channelDefinition = {
  id: 'api', label: '外部集成', defaults: { enabled: false, accountId: 'benchgo-api' }, fields: [{ key: 'accountId', label: '接入名称', type: 'text', required: true }],
  capabilities: { externalActions: [], direct: true, text: true, pullResults: true, attachments: false },
};
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
export function apiConfig(input = {}) {
  const c = { ...channelDefinition.defaults, ...input };
  if (typeof c.enabled !== 'boolean' || !id(c.accountId)) throw fail('外部集成配置无效');
  return c;
}
function apiSource(c, input) {
  if (!id(input.requestId) || !id(input.conversationId)) throw fail('请提供 requestId 和 conversationId');
  const channel = 'api', sourceType = 'direct';
  const threadId = `${channel}:${c.accountId}:${input.conversationId}`;
  return { channel, sourceKey: `${channel}:${c.accountId}:${input.requestId}`, threadId, messageId: input.requestId,
    actor: { id: ownerChannelActorId, kind: 'human' }, sourceType, kind: sourceType,
    source: { channel, accountId: c.accountId, sourceType, conversationId: input.conversationId, chatId: input.conversationId, topicId: null, messageId: input.requestId, threadId } };
}
function apiEvent(source, text) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 32000) throw fail('请提供有效文字');
  return { ...source, mentioned: false, occurredAt: new Date().toISOString(), text, raw: {} };
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
      if (input.operation !== 'submit') throw fail('API 操作不支持；任务结果通过 tasks 查询，直接回复通过 connectionReplies 查询');
      const c = await read(); if (!c.enabled) throw fail('API 链接未启用', 409);
      const event = apiSource(c, input);
      await authorizeChannel(options, 'receive', event.source, event.actor);
      const latest = await read(); if (JSON.stringify(latest) !== JSON.stringify(c)) throw fail('API 配置已变更', 409);
      const result = await ingest({ ...event, normalize: () => apiEvent(event, input.text) }); received = !result?.ignored || received;
      return { accepted: true, requestId: input.requestId, threadId: event.threadId, result };
    },
    async send({ source, idempotencyKey }) {
      await beforeDelivery(async () => {
        const c = await read();
        await authorizeChannel(options, 'send', source);
        if (!c.enabled || source?.channel !== 'api' || source.accountId !== c.accountId) throw fail('API 交付来源已撤销', 403);
      });
      // Tasks and direct replies each have a durable, owner-readable result mailbox.
      return { status: 'accepted', messageId: `pull:${createHash('sha256').update(String(idempotencyKey)).digest('hex')}`, deliveryMode: 'pull' };
    },
    dispose() { disposed = true; },
  };
}
