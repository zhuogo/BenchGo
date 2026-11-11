// Match the official Chat classification: only source.kind=user is human
// input; other user/message sources are model-only context or notices.
// Older append logs may omit surfaceOp, but replacement copies are never chat.
const appended = event => event?.surfaceOp === undefined || event.surfaceOp === 'append';
export const isTranscriptUser = event => event?.type === 'user/message' && appended(event) && event.data?.source?.kind === 'user';

/** Keep visible content and attachment labels, never attachment paths/bytes. */
export function transcriptContentText(content) {
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    if (block?.type === 'text') return typeof block.text === 'string' ? block.text : '';
    if (block?.type === 'file' || block?.type === 'image') {
      const label = block.type === 'file' ? '文件' : '图片';
      return typeof block.attachment?.name === 'string' && block.attachment.name ? `［${label}：${block.attachment.name}］` : `［${label}］`;
    }
    return '';
  }).filter(Boolean).join('\n');
}

/** Shared by durable history and live records; never infer origin from prose. */
export function transcriptMessage(event) {
  if (isTranscriptUser(event)) return { role: 'user', text: transcriptContentText(event.data.content) };
  if (event?.type === 'assistant/message' && appended(event) && !event.data?.interrupted) {
    return { role: 'assistant', text: transcriptContentText(event.data?.message?.content) };
  }
  if (event?.type === 'plugin:benchgo-plugin/chat-publication' && event.ignorable === true && event.data?.kind === 'final' && typeof event.data.text === 'string') {
    return { role: 'assistant', text: event.data.text };
  }
  return null;
}
