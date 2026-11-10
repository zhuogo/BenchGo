export const sidebarListStorageKey = 'benchgo.assistant.sidebarList';

export function readSidebarList(storage) {
  try { return storage?.getItem(sidebarListStorageKey) === 'im' ? 'im' : 'side'; } catch { return 'side'; }
}

export function channelIsConnected(status) {
  const authentication = status?.connection?.authenticated === true ? 'verified' : status?.authentication;
  return status?.enabled === true && !status.error && ['verified', 'host-authenticated'].includes(authentication)
    && ['connected', 'listening'].includes(status?.connection?.state);
}

/** The server owns source identity and its stable hash; the sidebar only reads it. */
export function isFixedChannelThread(thread) {
  return /^channel:[a-f\d]{64}$/.test(thread?.sourceKey || '') && !!thread.sessionId
    && typeof thread.source?.channel === 'string' && thread.source.channel !== 'desktop'
    && ['direct', 'group', 'topic'].includes(thread.source?.sourceType)
    && typeof thread.source.conversationId === 'string' && !!thread.source.conversationId
    && (thread.source.sourceType !== 'topic' || !!thread.source.topicId);
}

export function sourceConnectionMismatch(thread, channel) {
  return ['connectionId', 'appId', 'accountId'].some(field => thread.source?.[field] != null
    && channel?.status?.[field] != null && thread.source[field] !== channel.status[field]);
}

const sourceNames = { direct: '私聊', group: '群聊', topic: '话题' };
const displayName = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) : '';

/** Presentation metadata never participates in source/session identity. */
export function channelThreadTitle(thread, channel) {
  const source = thread?.source || {}, names = channel?.sourceNames?.[thread?.sourceKey] || {};
  const label = displayName(channel?.label) || (source.channel === 'feishu' ? '飞书' : displayName(source.channel)) || 'IM';
  const name = source.sourceType === 'direct' ? displayName(names.senderName || source.senderName)
    : displayName(names.conversationName || source.conversationName);
  return `${label}${sourceNames[source.sourceType] || ''}${name ? ` · ${name}` : ''}`;
}

export function sidebarThreads(threads, { list = 'side', archived = false, channels = [] } = {}) {
  const connected = new Map(channels.filter(channel => channelIsConnected(channel.status)).map(channel => [channel.id, channel]));
  return threads.filter(thread => thread.id !== 'main' && !!thread.archived === !!archived
    && (list === 'im' ? isFixedChannelThread(thread) && connected.has(thread.source.channel)
      && !sourceConnectionMismatch(thread, connected.get(thread.source.channel))
      : !thread.sourceKey && (!thread.source?.channel || thread.source.channel === 'desktop')))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}
