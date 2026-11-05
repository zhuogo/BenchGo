export const reactionScope = (threadId, sessionId) => JSON.stringify([threadId, sessionId || null]);

/** Reactions are local feedback, never an instruction or an approval. */
export async function setMessageReaction({ engine, database }, { threadId = 'main', messageKey, emoji }) {
  if (typeof messageKey !== 'string' || messageKey.length > 500 || (emoji !== null && !['👍', '❤️', '😂', '🎉', '🤔', '👎'].includes(emoji))) throw new Error('Invalid message reaction');
  const first = await engine.history(threadId, { limit: 200 });
  let found = false;
  if (messageKey.startsWith('message:')) {
    let page = first;
    while (true) {
      if (page.messages.some(row => `message:${row.id}` === messageKey)) { found = true; break; }
      if (!page.hasMore || page.nextBefore == null) break;
      const before = page.nextBefore;
      page = await engine.history(threadId, { limit: 200, before });
      if (page.sessionId !== first.sessionId) throw new Error('Conversation changed; refresh before reacting');
      if (page.hasMore && page.nextBefore >= before) throw new Error('Invalid history cursor');
    }
  } else if (messageKey.startsWith('notification:')) {
    let after = 0;
    while (true) {
      const page = database.notifications({ threadId, after, limit: 500 });
      if (page.events.some(row => `notification:${row.eventId || row.id}` === messageKey && row.threadId === threadId)) { found = true; break; }
      if (!page.hasMore || page.cursor <= after) break;
      after = page.cursor;
    }
  }
  if (!found) throw new Error('Message does not belong to this conversation');
  return database.setMessageReaction(reactionScope(threadId, first.sessionId), messageKey, emoji);
}
