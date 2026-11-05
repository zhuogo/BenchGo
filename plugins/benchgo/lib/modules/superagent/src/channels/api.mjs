import { createHash } from 'node:crypto';

export const channelDefinition = {
  id: 'api', label: 'API Service', defaults: { accountId: 'benchgo-api' }, fields: [{ key: 'accountId', label: '接入名称', type: 'text', required: true }],
  capabilities: { text: true, pullResults: true, attachments: false },
  help: '复用 BenchGo 已认证 API。通过 connectionAction / submit 提交或续聊，使用 tickets 查询工单与结果；不需要另建服务或密钥。',
};
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
export function apiConfig(input = {}) {
  const c = { enabled: false, ownerIds: [], chatIds: [], ...channelDefinition.defaults, ...input };
  if (typeof c.enabled !== 'boolean' || !id(c.accountId) || !Array.isArray(c.ownerIds) || !c.ownerIds.every(id) || !Array.isArray(c.chatIds) || !c.chatIds.every(id)) throw fail('API 配置无效');
  if (c.enabled && c.ownerIds.length !== 1) throw fail('API 请绑定一个明确的主人 ID');
  return c;
}
export function gatewayEvent(channel, c, input) {
  if (!id(input.requestId) || !id(input.conversationId) || typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > 32000) throw fail('请提供 requestId、conversationId 和有效文字');
  if (c.chatIds.length && !c.chatIds.includes(input.conversationId)) throw fail('会话不在允许范围', 403);
  const threadId = `${channel}:${c.accountId}:${input.conversationId}`;
  return { channel, sourceKey: `${channel}:${c.accountId}:${input.requestId}`, threadId, messageId: input.requestId,
    actor: { id: c.ownerIds[0], kind: 'human', owner: true }, kind: 'direct', mentioned: false, occurredAt: new Date().toISOString(), text: input.text,
    source: { channel, accountId: c.accountId, chatId: input.conversationId, messageId: input.requestId, threadId }, raw: {},
  };
}
export function createApiAdapter({ getConfig, ingest }) {
  let disposed = false, received = false;
  const read = async () => { if (disposed) throw fail('API 链接已停止', 503); return apiConfig(await getConfig()); };
  const status = async () => { const c = await read(); return { enabled: c.enabled, configured: c.ownerIds.length === 1, authentication: 'host-authenticated', events: received ? 'verified' : 'unverified', sending: 'pull', connection: { state: c.enabled ? 'connected' : 'stopped' } }; };
  return {
    start: status, status, verify: status,
    async operation(input, { principal } = {}) {
      if (principal?.kind !== 'owner') throw fail('API 需要已认证的 BenchGo 主人会话', 403);
      if (input.operation !== 'submit') throw fail('API 操作不支持；工单结果通过 tickets 查询，直接回复通过 connectionReplies 查询');
      const c = await read(); if (!c.enabled) throw fail('API 链接未启用', 409);
      const event = gatewayEvent('api', c, input);
      const latest = await read(); if (JSON.stringify(latest) !== JSON.stringify(c)) throw fail('API 配置已变更', 409);
      const result = await ingest(event); received = true;
      return { accepted: true, requestId: input.requestId, threadId: event.threadId, result };
    },
    async send({ source, idempotencyKey }) {
      const c = await read();
      if (!c.enabled || source?.channel !== 'api' || source.accountId !== c.accountId || (c.chatIds.length && !c.chatIds.includes(source.chatId))) throw fail('API 交付来源已撤销', 403);
      // Tickets and direct replies each have a durable, owner-readable result mailbox.
      return { status: 'accepted', messageId: `pull:${createHash('sha256').update(String(idempotencyKey)).digest('hex')}`, deliveryMode: 'pull' };
    },
    dispose() { disposed = true; },
  };
}
