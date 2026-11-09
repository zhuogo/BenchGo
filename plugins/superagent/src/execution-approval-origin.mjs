import { ownsDesktopTicket } from './desktop-ticket-owner.mjs';
import { validateTicketMandate } from './assessment-policy.mjs';
import { workerAppliedTicket } from './worker-permissions.mjs';
import { channelSessionKey } from './channel-policy.mjs';

/** Read-only presentation links. The official Worker request remains the only approval. */
export function executionApprovalOrigins({ database, ownerScope, ownerSessionId, policy, now = Date.now(), toolName = 'assistant_external_action', channelSource }) {
  if (!ownerSessionId || !ownerScope?.threadId || !ownerScope.sessionIds?.includes(ownerSessionId)) return [];
  const origins = [];
  for (let offset = 0; ; offset += 100) {
    const tickets = database.listTickets({ ...(!channelSource ? { ownerSessionIds: ownerScope.sessionIds, ownerThreadId: ownerScope.threadId } : {}),
      archived: false, limit: 100, offset });
    for (const ticket of tickets) {
      const owned = ticket.mandate && (channelSource ? ticket.mandate.source?.channel !== 'desktop'
        && channelSessionKey(ticket.mandate.source) === channelSessionKey(channelSource) : ownsDesktopTicket(ticket, ownerScope));
      if (!['open', 'waiting'].includes(ticket.status) || !ticket.mandate || !owned
        || !validateTicketMandate(ticket.mandate, { policy })) continue;
      for (const assignment of database.assignments(ticket.id)) {
        if (assignment.state !== 'claimed' || !assignment.owner || !Number.isFinite(assignment.leaseUntil) || assignment.leaseUntil <= now) continue;
        let applied;
        try {
          // Listing candidate sessions never grants a tool. At decision time the
          // actual PendingApproval tool name must pass the live capability gate.
          applied = toolName === null ? { ...ticket, ...database.appliedTicketSnapshot?.(assignment.id) }
            : workerAppliedTicket(database, assignment, { name: toolName });
        }
        catch { continue; }
        if (!validateTicketMandate(applied.mandate, { policy })) continue;
        for (const run of database.runs(assignment.id)) {
          if (!run.sessionId || !['submitted', 'running'].includes(run.state)
            || run.owner !== assignment.owner || run.fence !== assignment.fence) continue;
          origins.push({ ticketId: ticket.id, title: ticket.title || ticket.target, assignmentId: assignment.id,
            runId: run.id, sessionId: run.sessionId, ownerSessionId, ownerThreadId: ownerScope.threadId });
        }
      }
    }
    if (tickets.length < 100) break;
  }
  return origins;
}

/** The review inbox is a projection of this profile's existing official sessions,
 * not another approval store. Only the official PendingApproval can be answered. */
export async function resolveApprovalOrigins({ store, engine, input = {}, peer, readPolicy }) {
  if (peer?.principal?.kind !== 'owner') throw Object.assign(new Error('仅主人可查看待审核事项'), { status: 403 });
  if (input.sessionId !== undefined && (typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 200))
    throw Object.assign(new Error('无效审核会话标识'), { status: 400 });
  if (input.toolName !== undefined && (typeof input.toolName !== 'string' || !input.toolName || input.toolName.length > 200 || !input.sessionId))
    throw Object.assign(new Error('复核审批工具时必须指定原会话及工具名'), { status: 400 });
  const state = await store.getState(), origins = [];
  const sources = [
    ...(state.mainSessionId ? [{ id: 'main', sessionId: state.mainSessionId, title: '主聊天' }] : []),
    ...(state.threads || []).filter(thread => thread.id !== 'main' && thread.sessionId && !thread.archived),
  ];
  for (const source of sources) {
    if (source.sourceKey && source.sourceKey !== channelSessionKey(source.source)) continue;
    const sourceTitle = source.title || '旁聊';
    if (!input.sessionId || input.sessionId === source.sessionId) origins.push({ kind: 'router', title: sourceTitle,
      sourceTitle, sessionId: source.sessionId, ownerSessionId: source.sessionId, ownerThreadId: source.id });
    const ownerScope = await engine.ticketOwnerScope(source.id);
    const workers = executionApprovalOrigins({ database: store.orchestration, ownerScope,
      ownerSessionId: source.sessionId, policy: await readPolicy(source.id), toolName: input.toolName ?? null,
      ...(source.sourceKey ? { channelSource: source.source } : {}) });
    for (const worker of workers) if (!input.sessionId || input.sessionId === worker.sessionId)
      origins.push({ ...worker, kind: 'worker', sourceTitle });
  }
  // A clear/archive can complete during the asynchronous policy/scope reads.
  const latest = await store.getState();
  return { origins: origins.filter(origin => origin.ownerThreadId === 'main'
    ? latest.mainSessionId === origin.ownerSessionId
    : (latest.threads || []).some(thread => !thread.archived && thread.id === origin.ownerThreadId
      && thread.sessionId === origin.ownerSessionId && (!thread.sourceKey || thread.sourceKey === channelSessionKey(thread.source)))) };
}
