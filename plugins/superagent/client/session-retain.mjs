/** Host ensure can precede the client's session-catalog notification. */
export async function retainAssistantSession(sessions, sessionId, signal) {
  signal?.throwIfAborted();
  try { return sessions.retain(sessionId, { source: 'workspaceOperation', signal }); }
  catch (error) {
    if (!String(error?.message).startsWith('sessions.retain: unknown session ')) throw error;
    await sessions.refresh();
    signal?.throwIfAborted();
    return sessions.retain(sessionId, { source: 'workspaceOperation', signal });
  }
}

/** Idle conversations need only the host's root status feed, not a resumed writer. */
export function assistantBackgroundSessions(state = {}, selectedSessionId, statuses = new Map(), catalog = {}) {
  const sessions = new Map((state.threads || []).filter(thread => thread.sessionId && !thread.archived)
    .map(thread => [thread.sessionId, thread.id]));
  if (state.mainSessionId) sessions.set(state.mainSessionId, 'main');
  for (const [id] of sessions) {
    const status = statuses.get(id);
    if (id === selectedSessionId || !(status?.pendingInteraction || (status?.running ?? catalog.byId?.[id]?.running))) sessions.delete(id);
  }
  return sessions;
}
