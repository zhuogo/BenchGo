/** Trusted logical conversation ownership; callers obtain this scope from the engine. */
export function desktopTicketOwnerScope(owner) {
  if (owner === undefined) return undefined;
  if (typeof owner === 'string' && owner) return { sessionIds: [owner] };
  if (!owner || typeof owner.threadId !== 'string' || !owner.threadId
    || !Array.isArray(owner.sessionIds) || owner.sessionIds.some(id => typeof id !== 'string' || !id)) throw new Error('无效工单归属范围');
  return { threadId: owner.threadId, sessionIds: [...new Set(owner.sessionIds)] };
}

export function ownsDesktopTicket(ticket, owner) {
  const scope = desktopTicketOwnerScope(owner);
  if (!scope) return true;
  const source = ticket.mandate.source;
  return source?.channel === 'desktop' && scope.sessionIds.includes(source.sessionId)
    && (scope.threadId === undefined || (source.threadId || 'main') === scope.threadId);
}
