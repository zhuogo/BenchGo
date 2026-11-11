/** The same source identity joins live speech with the original durable message. */
export function transcriptSourceId(event) {
  const data = event?.data || {};
  if (event?.type === 'user/message') return `user:${data.id || event.seq}`;
  if (event?.type === 'plugin:benchgo-plugin/chat-publication') return `publication:${event.seq}`;
  if (event?.type === 'assistant/message' || event?.type === 'assistant/live-chunk') {
    if (data.turn !== undefined && data.step !== undefined) return `assistant:${data.turn}:${data.step}`;
    return data.message?.id ? `assistant:${data.message.id}` : data.attemptId ? `attempt:${data.attemptId}` : `assistant:${event.seq}`;
  }
  return undefined;
}
