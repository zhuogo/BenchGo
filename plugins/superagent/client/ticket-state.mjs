export const terminalTicketStates = new Set(['completed', 'failed', 'cancelled', 'closed']);
const safetyWaitCodes = new Set(['EXECUTION_EFFECTS_UNKNOWN', 'EXECUTION_NOT_VERIFIED', 'EXECUTION_STOP_UNCONFIRMED']);

export function attentionMatchesTicket(attention, ticket) {
  const revision = ticket.instructionRevision ?? 1;
  const assignment = ticket.assignments?.find(row => row.id === attention.assignmentId);
  if ((attention.instructionRevision ?? assignment?.instructionRevision ?? 1) !== revision) return false;
  return attention.origin !== 'review' || attention.resultVersion === ticket.resultVersion;
}

/** Read only the current Mandate version; old reports must not drive live actions. */
export function ticketSnapshot(ticket) {
  const revision = ticket.instructionRevision ?? 1;
  const current = values => values?.filter(value => (value.instructionRevision ?? 1) === revision).at(-1);
  const assignment = current(ticket.assignments), result = current(ticket.results);
  const attention = ticket.attentions?.find(row => row.state === 'waiting' && attentionMatchesTicket(row, ticket));
  const delivery = ticket.deliveries?.filter(value => {
    const payload = value.payload;
    return (!payload?.type || payload.type === 'ticket.result')
      && (payload?.instructionRevision ?? payload?.result?.instructionRevision ?? 1) === revision
      && (!result || (payload?.resultVersion ?? payload?.result?.version) === result.version);
  }).at(-1);
  const continuationWait = ticket.continuationWait?.sourceResultVersion === ticket.resultVersion
    ? ticket.continuationWait : result?.review?.waitKind === 'continuation_wait' ? result.review.continuationWait || {} : null;
  let status = ticket.status;
  if (attention && ['open', 'waiting'].includes(status)) {
    status = 'awaiting_user';
  } else if (status === 'waiting') {
    status = continuationWait ? 'continuation_wait' : 'review_wait';
  } else if (status === 'open') {
    status = assignment?.reviewContinuation && ['queued', 'claimed'].includes(assignment.state) ? 'reworking' : assignment?.state || status;
  }
  return { assignment, result, delivery, attention, status, continuationWait, safetyWait: safetyWaitCodes.has(continuationWait?.code) };
}

/** Recovery is explicit: a user click may add execution time, never Goal quota. */
export function continuationRecovery(ticket) {
  const { status, continuationWait } = ticketSnapshot(ticket);
  if (status !== 'continuation_wait' || safetyWaitCodes.has(continuationWait?.code)) return null;
  const goalBudget = continuationWait?.code === 'GOAL_BUDGET_EXHAUSTED';
  return { goalBudget, label: goalBudget ? '管理持续目标额度' : continuationWait?.code === 'EXECUTION_BUDGET_EXHAUSTED' ? '增加10分钟并继续' : '恢复原单',
    input: { ticketId: ticket.id, expectedResultVersion: ticket.resultVersion,
      ...(continuationWait?.code === 'EXECUTION_BUDGET_EXHAUSTED' ? { additionalExecutionMs: 600000 } : {}) } };
}
