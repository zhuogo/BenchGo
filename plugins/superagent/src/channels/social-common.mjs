import { authorizeChannel } from './connection-authorization.mjs';
export function socialConfig(input, defaults) {
  const c = { enabled: false, ownerIds: [], chatIds: [], ...defaults, ...input };
  if (typeof c.enabled !== 'boolean' || typeof c.botTokenRef !== 'string') throw new Error('机器人配置无效');
  for (const key of ['ownerIds', 'chatIds']) if (!Array.isArray(c[key]) || c[key].some(v => typeof v !== 'string' || !v)) throw new Error('身份列表无效');
  return c;
}
export function socialFacts(channel, accountId, message) {
  const { chatId, messageId, actorId, group, topic, conversationId = chatId, parentMessageId, replyThreadId, actorKind = 'human' } = message;
  if (!chatId || !messageId || !actorId) return null;
  const sourceType = topic ? 'topic' : group ? 'group' : 'direct';
  const threadId = `${channel}:${accountId}:${conversationId}:${topic || 'main'}`;
  return { channel, sourceKey: `${channel}:${accountId}:${messageId}`, threadId, messageId, sourceType, kind: sourceType, actor: { id: actorId, kind: actorKind }, source: { channel, accountId, sourceType, conversationId, chatId, topicId: topic || '', messageId, threadId, ...(replyThreadId ? { replyThreadId } : {}), ...(parentMessageId ? { parentMessageId } : {}) } };
}
export function socialEvent(channel, accountId, message) {
  const facts = socialFacts(channel, accountId, message);
  if (!facts || message.metadataOnly) return facts;
  if (!message.text) return null;
  return { ...facts, text: message.text, mentioned: !!message.mentioned, occurredAt: new Date(message.timestamp).toISOString(), raw: {} };
}
export async function authorizeSocial(authorizeConnection, operation, source, actor, allowUnboundAuthorization = false) {
  return authorizeChannel({ authorizeConnection, allowUnboundAuthorization }, operation, source, actor);
}
export function sourceAllowed(source, channel, accountId, config) {
  if (!config.enabled || source?.channel !== channel || source.accountId !== accountId || typeof source.chatId !== 'string' || !source.chatId) throw new Error('Connection revoked or source mismatch');
}
