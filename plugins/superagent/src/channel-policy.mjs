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
  return { version: `${row.channel}:${row.revision}`, config, connection: row,
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
  if (!trigger || trigger.source?.channel !== channel) throw Object.assign(new Error('外发目标没有可信渠道来源：targetTriggerId 必须是账本中已准入的完整原始 ID（保留 trigger: 等已有前缀），且属于当前渠道。渠道目标不由保险库登记；请核对可信来源，不补造绑定或改猜 ID。'), { code: 'ACTION_TARGET_NOT_FOUND' });
  authorizeChannelConnection(readConnection, channel, { operation: 'send', source: trigger.source });
  const source = structuredClone(trigger.source), text = input.text;
  return { origin: null, target: structuredClone(source), content: { text }, submission: { input: { targetTriggerId: input.targetTriggerId, text }, source, text } };
}

/** Adapter admission: platform identities and conversation policy stay at this boundary. */
export function channelAdmissionCheck(event, policy) {
  const source = event?.source;
  const owner = event?.actor?.kind === 'human' && policy.ownerIds?.includes(event.actor.id);
  const platformHuman = event?.actor?.kind === 'human' && policy.allowHumanRequests === true;
  const machine = event?.actor?.kind === 'machine';
  const allowedActor = !source?.selfOrigin && !source?.replyLoop && !!(owner || platformHuman || (machine ? policy.machineIds : policy.actorIds)?.includes(event?.actor?.id));
  const valid = !!source && sourceTypes.includes(source.sourceType) && source.channel === event.channel && (!event.sourceType || event.sourceType === source.sourceType)
    && (source.sourceType === 'system' || typeof source.conversationId === 'string' && !!source.conversationId && typeof source.chatId === 'string' && !!source.chatId)
    && (source.sourceType !== 'topic' || typeof source.topicId === 'string' && !!source.topicId);
  const allowedThread = valid && (policy.config ? channelSourceAllowed(policy.config, source, policy.connection)
    : policy.sourceAllowed !== false && (!policy.threadIds || policy.threadIds.includes(source.conversationId)));
  const direct = source?.sourceType === 'direct' && allowedActor;
  const requested = direct || machine || event.mentioned === true;
  const allowed = !!allowedThread && allowedActor && (direct || machine || (['group', 'topic'].includes(source?.sourceType) && event.mentioned === true));
  return { explicit: allowed && event?.actor?.kind === 'human', requested, direct, allowed, allowedActor, allowedThread, valid,
    strength: allowed ? (machine ? 'inferred' : 'explicit') : 'ignore',
    reason: !allowedThread ? 'channelDenied' : !allowedActor ? 'actorDenied' : !requested ? 'notMentioned' : 'allowed' };

}


export function assessChannelAdmission({ policy, candidate, trigger, decision }) {
  const channel = trigger.source?.channel || 'feishu';
  const config = channel === 'feishu' ? policy.connection : policy.connections?.[channel]?.config;
  if (!config) return { allowed: false, reason: 'unknown-channel' };
  if (!['direct', 'group', 'topic', 'system'].includes(trigger.source?.sourceType)) return { allowed: false, reason: 'source-evidence-expired-recollect-required' };
  if (decision.outcome === 'accept' && trigger.source.sourceType === 'group' && trigger.source.mentioned !== true) return { allowed: false, reason: 'group-new-task-requires-mention' };
  const channelAllowed = channelScope(config, trigger.source, policy.connections?.[channel]);
  const platformHuman = connectionPolicy({ config }).allowHumanRequests && trigger.actor.kind === 'human';
  const explicit = trigger.actor.kind === 'human' && (platformHuman || (config.ownerOpenIds || config.ownerIds || []).includes(trigger.actor.id)) && candidate.gate.strength === 'explicit';
  const inferred = trigger.actor.kind === 'machine' && (config.machineOpenIds || config.machineIds || []).includes(trigger.actor.id)
    && candidate.gate.strength === 'inferred' && decision.outcome === 'accept' && (channel === 'feishu' ? policy.mode : config.admissionMode) === 'auto'
    && validRuleReferences(decision.ruleIds, channel === 'feishu' ? policy.enabledRuleIds : policy.connections?.[channel]?.enabledRuleIds);
  const machineAttention = decision.outcome === 'stop' && trigger.source.sourceType !== 'direct'
    && trigger.actor.kind === 'machine' && (config.machineOpenIds || config.machineIds || []).includes(trigger.actor.id)
    && candidate.gate.allowed === true && candidate.gate.strength === 'inferred' && candidate.gate.evidence?.sourceVerified === true;
  if (!channelAllowed || candidate.gate.allowed === false || (!explicit && !inferred && !machineAttention)) return { allowed: false, reason: 'current-channel-actor-or-rule-denied' };
  if (['answer', 'ask'].includes(decision.outcome)) {
    if (!explicit || decision.ticketId !== undefined) return { allowed: false, reason: 'direct-reply-requires-explicit-human-source' };
    return { allowed: true, reason: 'authenticated-direct-reply' };
  }

  const evidence = candidate.gate.evidence;
  if (decision.outcome === 'stop' && trigger.source.sourceType !== 'direct') return { allowed: true, outcome: 'attach', routerAttention: true, reason: 'non-direct-stop-router-attention' };
  if (decision.outcome === 'stop' && !(evidence?.sourceVerified === true && ['sourceType', 'connectionId', 'conversationId'].every(key => evidence[key] === trigger.source[key]))) return { allowed: false, reason: 'stop-requires-verified-source' };
  return { allowed: true, reason: inferred ? 'enabled-written-rules' : 'authenticated-platform-request', mandate: {
    ...(inferred ? { admission: 'enabled-rules', strength: 'inferred', actorKind: trigger.actor.kind, ruleIds: [...decision.ruleIds] } : { admission: 'platform-request', actorKind: trigger.actor.kind }),
  } };
}
export function validateChannelMandate(mandate, policy) {
  const source = mandate.source, channel = source?.channel || 'feishu';
  const config = channel === 'feishu' ? policy.connection : policy.connections?.[channel]?.config;
  if (!channelScope(config, source, policy.connections?.[channel])) return false;
  const admitted = channelAdmissionCheck({ channel, source, actor: { id: mandate.actorId, kind: mandate.actorKind || 'human' } }, connectionPolicy({ ...policy.connections?.[channel], channel, config }));
  return admitted.allowedActor && (mandate.admission !== 'enabled-rules' || mandate.strength === 'inferred'
    && (channel === 'feishu' ? policy.mode : config.admissionMode) === 'auto'
    && validRuleReferences(mandate.ruleIds, channel === 'feishu' ? policy.enabledRuleIds : policy.connections?.[channel]?.enabledRuleIds))
    && mandate.controlledActions === 'require-current-policy-and-harness-approval';
}
function validRuleReferences(ruleIds, enabledRuleIds) {
  return Array.isArray(ruleIds) && ruleIds.length > 0 && new Set(ruleIds).size === ruleIds.length
    && Array.isArray(enabledRuleIds) && ruleIds.every(id => typeof id === 'string' && enabledRuleIds.includes(id));
}
function channelScope(config, source, row) {
  return !!config?.enabled && channelSourceAllowed(config, source, row);
}
