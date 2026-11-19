export const VOICE_CONVERSATION_RECORD = 'plugin:benchgo-plugin/voice-conversation';
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function voiceRecordOf(event) {
  const record = event?.data;
  if (event?.type !== VOICE_CONVERSATION_RECORD || event.ignorable !== true || !record || !nonempty(record.callId) || !nonempty(record.requestId)) return null;
  return ['user', 'assistant', 'handoff', 'execution', 'call-start'].includes(record.kind) ? record : null;
}

/** Project loaded durable events into a compact spoken transcript, independent of executor rows. */
export function readVoiceTranscript(entries, { callId } = {}) {
  const messages = new Map();
  for (const entry of entries || []) {
    const event = entry?.event || entry, record = voiceRecordOf(event);
    if (!record || callId && record.callId !== callId || !['user', 'assistant'].includes(record.kind) || !nonempty(record.text)) continue;
    const id = JSON.stringify([record.callId, record.requestId, record.kind, record.kind === 'user' ? 'user' : record.messageId || record.requestId]);
    const previous = messages.get(id);
    // Snapshot records supersede earlier partials while retaining the original timeline anchor.
    if (previous && event.seq < previous.updatedSeq) {
      if (event.seq < previous.seq) messages.set(id, { ...previous, seq: event.seq, time: event.time });
      continue;
    }
    messages.set(id, { id, kind: record.kind, role: record.kind, callId: record.callId, requestId: record.requestId,
      messageId: record.messageId, text: record.text, partial: record.partial === true,
      seq: previous?.seq ?? event.seq, time: previous?.time ?? event.time, updatedSeq: event.seq });
  }
  return [...messages.values()].sort((left, right) => left.seq - right.seq);
}
