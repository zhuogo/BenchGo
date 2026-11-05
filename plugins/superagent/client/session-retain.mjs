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
