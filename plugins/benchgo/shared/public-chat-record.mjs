/** Public display records shared by chat and voice; no runtime or tool authority. */
export const chatPublicationType = 'plugin:benchgo-plugin/chat-publication';
export const channelMessageRecordType = 'plugin:benchgo-plugin/channel-message';

/** Host signal identity is independent of the transport's descriptive source label. */
export function isHostReplyRequest(request) {
  const source = request?.source;
  if (source?.kind === 'benchgo-task-reply') return true;
  return typeof source?.kind === 'string' && source.kind.length > 0
    && !['user', 'user-question-reply'].includes(source.kind)
    && ['result', 'state', 'approval', 'recovery', 'watchdog'].includes(source.replyKind)
    && typeof source.eventKey === 'string' && source.eventKey.length > 0;
}

/** Only newly admitted completion signals participate in ordinary conversation. */
export function isTaskResultReplyRequest(request) {
  const source = request?.source;
  return isHostReplyRequest(request) && source.replyKind === 'result' && source.replyMode === 'conversation'
    && typeof source.eventKey === 'string' && source.eventKey.trim().length > 0
    && typeof source.taskId === 'string' && source.taskId.trim().length > 0;
}

/** A recorded host draft has a bound request; this does not authorize delivery. */
export function hostReplyPublicationOf(event, request) {
  const value = event?.data;
  if (event?.type !== chatPublicationType || event.ignorable !== true || !request?.id
    || value?.requestId !== request.id || !isHostReplyRequest(request)
    || typeof value.kind !== 'string' || !value.kind || value.kind === 'final') return null;
  if (value.suppressed === true) return value.text === undefined ? value : null;
  return typeof value.text === 'string' && value.text.trim() && value.text.length <= 16000 ? value : null;
}

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
  if (value.kind === 'final') return !isHostReplyRequest(request) || isTaskResultReplyRequest(request) ? value : null;
  return hostReplyPublicationOf(event, request)
    && (['approval', 'recovery', 'watchdog'].includes(request.source.replyKind)
      || request.source.replyKind === 'state' && value.kind === 'task-reply') && !value.suppressed ? value : null;
}
