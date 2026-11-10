/** Read-only bridge: a Goal observes the existing Ticket execution and never replays it. */
export function ticketGoalRecord(database, ticketId) {
  const ticket = database?.getTicket(ticketId);
  if (!ticket) return null;
  const latest = database.results(ticketId).at(-1);
  // Only the current committed result may satisfy a Goal. Do not search older
  // successful versions after a requirements change.
  const current = latest?.ticketId === ticket.id
    && latest.version === ticket.resultVersion
    && latest.instructionRevision === ticket.instructionRevision ? latest : null;
  return {
    id: ticket.id,
    kind: 'ticket',
    status: ticket.status,
    executionControl: ticket.executionControl,
    instructionRevision: ticket.instructionRevision,
    result: current,
    waitReason: ticket.executionControl?.stopRequested || ticket.executionControl?.stopped ? 'cancellation' : ticket.status === 'waiting' ? 'external' : undefined,
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
  // Persisted legacy provider/model fields are historical binding evidence only;
  // all public creation paths reject them before this read-only check.
  const model = goal.workerModel || (goal.provider && goal.model ? { providerId: goal.provider, modelId: goal.model } : null);
  if (!assignments.some(assignment => assignment.instructionRevision === ticket.instructionRevision
    && assignment.model?.providerId && assignment.model?.modelId
    && (!model || assignment.model.providerId === model.providerId && assignment.model.modelId === model.modelId))) throw new Error('目标工单缺少一致的工作角色模型审计与需求版本');
  return ticket;
}
