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

export function sidebarThreads(threads, { list = 'side', archived = false, channels = [] } = {}) {
  const connected = new Map(channels.filter(channel => channelIsConnected(channel.status)).map(channel => [channel.id, channel]));
  return threads.filter(thread => thread.id !== 'main' && !!thread.archived === !!archived
    && (list === 'im' ? isFixedChannelThread(thread) && connected.has(thread.source.channel)
      && !sourceConnectionMismatch(thread, connected.get(thread.source.channel))
      : !thread.sourceKey && (!thread.source?.channel || thread.source.channel === 'desktop')))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}
