/** Public display records shared by chat and voice; no runtime or tool authority. */
export const chatPublicationType = 'plugin:benchgo-plugin/chat-publication';
export const channelMessageRecordType = 'plugin:benchgo-plugin/channel-message';

export function channelMessageRecordOf(event) {
  const value = event?.data;
  return event?.type === channelMessageRecordType && event.ignorable === true
    && value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.mirrorKey === 'string' && value.mirrorKey.length > 0
    && ['inbound', 'delivery'].includes(value.direction) && typeof value.text === 'string'
    && value.source && typeof value.source === 'object' && !Array.isArray(value.source)
    && typeof value.source.channel === 'string' && value.source.channel.length > 0
    && typeof value.source.sourceType === 'string' && value.source.sourceType.length > 0
    ? value : null;
}

/** The preceding admitted request binds reminder visibility, never prose or model tags. */
export function chatPublicationRecordOf(event, request) {
  const value = event?.data;
  if (event?.type !== chatPublicationType || event.ignorable !== true || !request?.id
    || value?.requestId !== request.id || typeof value.text !== 'string'
    || !value.text.trim() || value.text.length > 16000) return null;
  const kind = request.source?.kind;
  if (value.kind === 'final') return kind !== 'benchgo-ticket-reply' ? value : null;
  return value.kind === 'ticket-reply' && kind === 'benchgo-ticket-reply'
    && ['approval', 'recovery', 'watchdog'].includes(request.source.replyKind) && !value.suppressed ? value : null;
}
