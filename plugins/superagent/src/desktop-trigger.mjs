import { createHash } from 'node:crypto';

/** Called only at trusted desktop ingress; message content never supplies identity. */
export function recordDesktopTrigger(database, { sessionId, threadId = 'main', message }) {
  if (message?.source?.kind !== 'user') return null;
  if (!sessionId || !message.id) throw new Error('桌面消息缺少会话或消息标识');
  const content = (message.content || []).filter(block => block.type === 'text').map(block => block.text || '').join('\n');
  const source = { channel: 'desktop', sessionId, messageId: message.id, threadId };
  return database.ingest({
    dedupeKey: `desktop-message:${createHash('sha256').update(JSON.stringify([sessionId, message.id])).digest('hex')}`,
    thread: { id: `desktop:${sessionId}`, source: { type: 'desktop', id: sessionId } },
    source, actor: { kind: 'human', id: 'desktop-owner' }, content, mode: 'direct',
    gate: { allowed: true, strength: 'explicit', reason: 'desktop-owner-message' },
  });
}
