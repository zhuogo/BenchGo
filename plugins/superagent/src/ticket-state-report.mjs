import { ticketExecutionBlocked } from './ticket-lifecycle.mjs';

export function isTicketStateNotice(value) {
  return value?.type === 'ticket.result' && value.publication?.origin === 'system'
    && ['continuation_wait', 'delivery_wait'].includes(value.publication.systemState?.state);
}

/** Failure facts come from the execution ledger, never inferred by the Router. */
export function ticketStateSignal(database, delivery) {
  const ticket = database.getTicket(delivery.ticketId), payload = delivery.payload;
  if (!isTicketStateNotice(payload) || !ticket
    || ticketExecutionBlocked(ticket) || ticket.instructionRevision !== payload.instructionRevision
    || ticket.resultVersion !== payload.resultVersion) return null;
  const state = payload.publication.systemState;
  const assignment = database.assignments(ticket.id).find(row => ['uncertain', 'failed'].includes(row.state)
    && row.lastFailure?.code === state.code && row.lastFailure?.stage === state.stage
    && (!payload.assignmentId || row.id === payload.assignmentId && row.fence === payload.fence));
  if (state.state === 'continuation_wait' && !assignment) return null;
  return { eventKey: delivery.uniqueKey, ticketId: ticket.id, title: ticket.title, status: ticket.status,
    instructionRevision: ticket.instructionRevision, resultVersion: ticket.resultVersion,
    state: state.state, code: state.code, stage: state.stage,
    ...(assignment ? { assignmentId: assignment.id, fence: assignment.fence, executionState: assignment.state,
      ...(assignment.firstFailure ? { failure: assignment.firstFailure } : {}) } : {}) };
}
