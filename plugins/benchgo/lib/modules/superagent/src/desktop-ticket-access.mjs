import { desktopTicketOwnerScope, ownsDesktopTicket } from './desktop-ticket-owner.mjs';
import { normalizeTicketTitle } from './ticket-title.mjs';

/** Read current desktop conversation tickets from the orchestration store. */
export function createDesktopTicketAccess(database) {
  const owned = (ticket, ownerSessionId) => {
    if (!ownsDesktopTicket(ticket, ownerSessionId)) throw new Error('工单不属于当前会话');
    return ticket;
  };
  const detail = ticket => ({ ...ticket, title: normalizeTicketTitle(ticket.title, ticket.target), kind: 'ticket',
    revisions: database.ticketRevisions(ticket.id),
    assignments: database.assignments(ticket.id).map(assignment => ({ ...assignment, runs: database.runs(assignment.id) })), results: database.results(ticket.id),
    attentions: database.attentions(ticket.id), deliveries: database.deliveries(ticket.id) });
  return {
    query(ownerSessionId, { status, projectId, limit = 20, offset = 0 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('工单查询 limit 必须为 1 到 100');
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('工单查询 offset 必须为非负整数');
      const scope = desktopTicketOwnerScope(ownerSessionId);
      if (scope && !scope.sessionIds.length) return { tickets: [], nextOffset: null };
      const rows = database.listTickets({ ...(scope ? { ownerSessionIds: scope.sessionIds, ownerThreadId: scope.threadId } : {}), status, projectId, limit: limit + 1, offset, newestFirst: true });
      return {
        tickets: rows.slice(0, limit).map(ticket => ({
          id: ticket.id, title: normalizeTicketTitle(ticket.title, ticket.target), status: ticket.status, liveSummary: ticket.liveSummary,
          adjustmentOfTicketId: ticket.adjustmentOfTicketId,
          project: ticket.mandate.project, threadId: ticket.threadId,
          instructionRevision: ticket.instructionRevision,
          createdAt: ticket.createdAt, updatedAt: ticket.updatedAt,
        })),
        nextOffset: rows.length > limit ? offset + limit : null,
      };
    },
    read(id, ownerSessionId) {
      const ticket = database.getTicket(id);
      return ticket ? detail(owned(ticket, ownerSessionId)) : null;
    },
  };
}
