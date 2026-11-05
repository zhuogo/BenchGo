export function socialConfig(input, defaults) {
  const c = { enabled: false, ownerIds: [], chatIds: [], ...defaults, ...input };
  if (typeof c.enabled !== 'boolean' || typeof c.botTokenRef !== 'string') throw new Error('机器人配置无效');
  for (const key of ['ownerIds', 'chatIds']) if (!Array.isArray(c[key]) || c[key].some(v => typeof v !== 'string' || !v)) throw new Error('身份列表无效');
  return c;
}
export function socialEvent(channel, accountId, message, config) {
  const { chatId, messageId, actorId, text, group, mentioned, topic, timestamp } = message;
  if (!chatId || !messageId || !actorId || !text || (group && !mentioned) || (config.chatIds.length && !config.chatIds.includes(chatId))) return null;
  const threadId = `${channel}:${accountId}:${chatId}:${topic || 'main'}`;
  return { channel, sourceKey: `${channel}:${accountId}:${messageId}`, threadId, messageId, actor: { id: actorId, kind: 'human', owner: config.ownerIds.includes(actorId) }, kind: group ? 'group' : 'direct', mentioned: !!mentioned, text, occurredAt: new Date(timestamp).toISOString(), source: { channel, accountId, chatId, messageId, threadId, ...(topic ? { topicId: topic } : {}) }, raw: {} };
}
export function sourceAllowed(source, channel, accountId, config) {
  if (!config.enabled || source?.channel !== channel || source.accountId !== accountId || typeof source.chatId !== 'string' || !source.chatId || (config.chatIds.length && !config.chatIds.includes(source.chatId))) throw new Error('交付来源已撤销或不属于当前连接');
}
