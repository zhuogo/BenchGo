import { ownsDesktopTicket } from './desktop-ticket-owner.mjs';
import { validateTicketMandate } from './assessment-policy.mjs';
import { workerAppliedTicket } from './worker-permissions.mjs';

/** Read-only presentation links. The official Worker request remains the only approval. */
export function executionApprovalOrigins({ database, ownerScope, ownerSessionId, policy, now = Date.now() }) {
  if (!ownerSessionId || !ownerScope?.threadId || !ownerScope.sessionIds?.includes(ownerSessionId)) return [];
  const origins = [];
  for (let offset = 0; ; offset += 100) {
    const tickets = database.listTickets({ ownerSessionIds: ownerScope.sessionIds, ownerThreadId: ownerScope.threadId,
      archived: false, limit: 100, offset });
    for (const ticket of tickets) {
      if (!['open', 'waiting'].includes(ticket.status) || !ticket.mandate || !ownsDesktopTicket(ticket, ownerScope)
        || !validateTicketMandate(ticket.mandate, { policy })) continue;
      for (const assignment of database.assignments(ticket.id)) {
        if (assignment.state !== 'claimed' || !assignment.owner || !Number.isFinite(assignment.leaseUntil) || assignment.leaseUntil <= now) continue;
        let applied;
        try { applied = workerAppliedTicket(database, assignment, { name: 'assistant_external_action' }); }
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

/** Scope comes from the current profile and engine, never from client-supplied Worker ids. */
export async function resolveExecutionApprovalOrigins({ store, engine, input, peer, readPolicy }) {
  if (peer?.principal?.kind !== 'owner') throw Object.assign(new Error('仅主人可查看执行审批'), { status: 403 });
  const threadId = input.threadId ?? 'main', state = await store.getState();
  const thread = threadId === 'main' ? { sessionId: state.mainSessionId } : state.threads.find(item => item.id === threadId && !item.archived);
  if (!thread?.sessionId || thread.sessionId !== input.ownerSessionId) return { origins: [] };
  const ownerScope = await engine.ticketOwnerScope(threadId);
  return { origins: executionApprovalOrigins({ database: store.orchestration, ownerScope,
    ownerSessionId: thread.sessionId, policy: await readPolicy(threadId) }) };
}
