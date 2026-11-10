import { desktopTicketOwnerScope, ownsDesktopTicket } from './desktop-ticket-owner.mjs';
import { normalizeTicketTitle } from './ticket-title.mjs';
import { isDesktopTicketManagementScope } from './desktop-ticket-management-authority.mjs';

export const TICKET_SUMMARY_MAX_CHARS = 320;
const concise = (value, max = TICKET_SUMMARY_MAX_CHARS) => typeof value === 'string' ? Array.from(value.replace(/\s+/gu, ' ').trim()).slice(0, max).join('') : '';

/** A bounded paragraph for routine coordination; persisted evidence stays in get. */
export function conciseTicketSummary(ticket) {
  const live = ticket.liveSummary;
  const reason = ticket.continuationWait;
  const control = ticket.executionControl || {};
  const summary = control.stopped ? '已停止，等待明确的继续要求。'
    : control.stopRequested ? '正在确认停止，等待执行端核实。'
    : control.paused || control.pauseRequested ? '已请求暂停，等待明确恢复。'
    : [concise(reason?.reason || live?.blocker, 120),
      reason?.resumeConditions || reason?.nextStep ? `继续条件：${concise(reason.resumeConditions || reason.nextStep, 120)}` : '',
      reason?.code === 'EXECUTION_FAILED' ? '下一步：补充条件后明确继续或修订要求。' : concise(live?.progress, 60)].filter(Boolean).join('；');
  return concise(summary || ({ running: '正在推进。', waiting: '等待执行条件。', completed: '已完成并交付。' })[ticket.status]);
}

/** Read current desktop conversation tickets from the orchestration store. */
export function createDesktopTicketAccess(database) {
  const owned = (ticket, ownerSessionId) => {
    if (!isDesktopTicketManagementScope(ownerSessionId) && !ownsDesktopTicket(ticket, ownerSessionId)) throw new Error('工单不属于当前会话');
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
      const scope = isDesktopTicketManagementScope(ownerSessionId) ? undefined : desktopTicketOwnerScope(ownerSessionId);
      if (scope && !scope.sessionIds.length) return { tickets: [], nextOffset: null };
      const rows = database.listTickets({ ...(scope ? { ownerSessionIds: scope.sessionIds, ownerThreadId: scope.threadId } : {}), status, projectId, limit: limit + 1, offset, newestFirst: true });
      return {
        tickets: rows.slice(0, limit).map(ticket => ({
          id: ticket.id, title: normalizeTicketTitle(ticket.title, ticket.target), status: ticket.status,
          liveSummary: conciseTicketSummary(ticket),
          result: ticket.resultVersion > 0 ? { ticketId: ticket.id, version: ticket.resultVersion } : null,
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
