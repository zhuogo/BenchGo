import { createHash } from 'node:crypto';

export const sourceTypes = Object.freeze(['direct', 'group', 'topic', 'system']);
export const channelExternalSendInputSchema = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: Object.freeze({
    targetTriggerId: Object.freeze({ type: 'string', minLength: 1, description: '已准入且属于目标渠道的真实 Trigger ID；从可信任务上下文取得，不得编造或用会话 ID 代替。' }),
    text: Object.freeze({ type: 'string', minLength: 1, description: '此次另行发送的完整最终正文；审批只覆盖这段确切内容。' }),
  }),
  required: Object.freeze(['targetTriggerId', 'text']),
});
const id = value => typeof value === 'string' && value.length > 0;
export function channelGroupMode(config, conversationId) {
  if (config.groups == null) return !config.chatIds?.length || config.chatIds.includes(conversationId) ? 'all' : 'disabled';
  return config.groups.find(group => group.chatId === conversationId)?.mode || config.otherGroups || 'disabled';
}
export function channelSourceAllowed(config, source, row) {
  if (!config?.enabled || !sourceTypes.includes(source?.sourceType) || !id(source.channel)) return false;
  if (row?.channel && source.channel !== row.channel) return false;
  if (source.connectionRevision !== undefined && source.connectionRevision !== row?.revision) return false;
  if (source.connectionId !== undefined && source.connectionId !== (row?.connectionId || source.channel)) return false;
  const account = config.accountId || config.botId || config.appId || config.phoneNumberId;
  if (account && (source.accountId || source.appId) !== account) return false;
  const conversation = source.conversationId;
  if (source.sourceType === 'system') return !source.topicId && (!config.chatIds?.length || config.chatIds.includes(conversation));
  if (!id(conversation) || !id(source.chatId)) return false;
  if (source.sourceType !== 'topic' && source.chatId !== conversation) return false;
  if (source.sourceType === 'topic' ? !id(source.topicId) : !!source.topicId) return false;
  if (source.sourceType === 'direct' && config.directMessages === false) return false;
  if (config.groups != null) return source.sourceType === 'direct' || channelGroupMode(config, conversation) !== 'disabled';
  return !config.chatIds?.length || config.chatIds.includes(conversation);
}
export function connectionPolicy(row) {
  const config = row.config;
  return { version: `${row.channel}:${row.revision}`, routeDirect: true, config, connection: row,
    ownerIds: config.ownerOpenIds || config.ownerIds || [], actorIds: config.ownerOpenIds || config.ownerIds || [],
    machineIds: config.machineOpenIds || config.machineIds || [], allowHumanRequests: config.accessMode === 'platform' };
}
export function authorizeChannelConnection(readConnection, channel, { operation, source, actor } = {}) {
  const row = { ...readConnection(channel), channel };
  const connectionRead = source?.sourceType === 'system' && !source.messageId && !source.conversationId;
  if (!row.config?.enabled || source && !connectionRead && !channelSourceAllowed(row.config, source, row)) throw Object.assign(new Error('渠道授权或来源范围已撤销'), { status: 403, deliveryOutcome: 'not_sent' });
  if (source && (source.channel !== channel || source.connectionRevision !== undefined && source.connectionRevision !== row.revision)) throw Object.assign(new Error('渠道连接身份或版本不匹配'), { status: 403 });
  const account = row.config.accountId || row.config.botId || row.config.appId || row.config.phoneNumberId;
  if (source && account && (source.accountId || source.appId) !== account) throw Object.assign(new Error('渠道账号身份不匹配'), { status: 403 });
  if (operation === 'voice-control' && (actor?.kind !== 'human' || !(row.config.ownerIds || []).includes(actor.id))) throw Object.assign(new Error('语音控制需要已核实的主人身份'), { status: 403 });
  return row;
}
/** Stable across reconnects/revisions, isolated by authenticated adapter account. */
export function channelSessionKey(source) {
  if (!sourceTypes.includes(source?.sourceType)) throw new Error('渠道来源缺少统一类型');
  return `channel:${createHash('sha256').update(JSON.stringify([source.channel, source.connectionId || source.channel, source.appId || source.accountId || '', source.conversationId || '', source.topicId || ''])).digest('hex')}`;
}
export function prepareChannelExternalSend(readConnection, readTrigger, channel, input, { principal } = {}) {
  if (principal?.kind !== 'owner') throw new Error('渠道外发需要已认证主人');
  if (!input || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(channelExternalSendInputSchema.properties, key))
    || typeof input.targetTriggerId !== 'string' || !input.targetTriggerId.trim() || typeof input.text !== 'string' || !input.text.trim()) {
    throw Object.assign(new Error('外发参数无效。input 必须仅含 {"targetTriggerId":"真实来源记录的 Trigger ID","text":"完整最终正文"}，两项均为非空字符串。请按 catalog.inputSchema 填写；缺少可信目标时向用户询问，不猜字段或搜索安装源码。'), { code: 'ACTION_INPUT_INVALID' });
  }
  const trigger = readTrigger(input.targetTriggerId);
  if (!trigger || trigger.source?.channel !== channel) throw new Error('外发目标没有可信渠道来源');
  authorizeChannelConnection(readConnection, channel, { operation: 'send', source: trigger.source });
  const source = structuredClone(trigger.source), text = input.text;
  return { origin: null, target: structuredClone(source), content: { text }, submission: { input: { targetTriggerId: input.targetTriggerId, text }, source, text } };
}
