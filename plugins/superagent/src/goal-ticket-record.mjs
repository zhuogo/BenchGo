/** Read-only bridge: a Goal observes the existing Ticket execution and never replays it. */
export function ticketGoalRecord(database, ticketId) {
  const ticket = database?.getTicket(ticketId);
  if (!ticket) return null;
  const latest = database.results(ticketId).at(-1);
  // Only the current committed result may satisfy a Goal. Do not search older
  // successful versions after a newer review or requirements change.
  const current = latest?.ticketId === ticket.id
    && latest.version === ticket.resultVersion
    && latest.instructionRevision === ticket.instructionRevision ? latest : null;
  const assignment = database.assignments(ticketId).at(-1);
  const blocked = ticket.status === 'open' && ['uncertain', 'blocked'].includes(assignment?.state);
  const budgetWaiting = (['pausing', 'paused'].includes(ticket.status) && ticket.pauseReason?.kind === 'budget')
    || (ticket.status === 'waiting' && !!current?.review?.budgetWait);
  return {
    id: ticket.id,
    kind: 'ticket',
    status: blocked || budgetWaiting ? 'waiting' : ticket.status === 'open' ? 'running' : ticket.status,
    instructionRevision: ticket.instructionRevision,
    result: current ? { ...current, acceptanceVerdict: current.review?.verdict } : null,
    waitReason: budgetWaiting ? 'budget' : ticket.status === 'cancelling' ? 'cancellation' : blocked || ticket.status === 'waiting' ? 'external' : undefined,
  };
}

/** Bind a newly approved Goal only to the exact work accepted for its owner. */
export function assertGoalTicketBinding(database, ticketId, goal) {
  const ticket = typeof ticketId === 'string' && ticketId ? database?.getTicket(ticketId) : null;
  const source = ticket?.mandate?.source;
  if (!ticket || !goal?.ownerSessionId || source?.channel !== 'desktop'
    || source.sessionId !== goal.ownerSessionId
    || ticket.mandate.actorId !== 'desktop-owner'
    || ticket.mandate.admission !== 'desktop-approved-delegation'
    || ticket.mandate.project?.id !== goal.projectId
    || ticket.target !== goal.text
    || ticket.acceptance !== (goal.acceptance ?? '')) throw new Error('目标工单绑定与已批准任务不一致');
  const assignments = database.assignments(ticketId);
  if (!goal.provider || !goal.model || !assignments.some(assignment =>
    assignment.instructionRevision === ticket.instructionRevision
    && assignment.model?.providerId === goal.provider
    && assignment.model?.modelId === goal.model)) throw new Error('目标工单缺少一致的显式模型与需求版本');
  return ticket;
}
