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
  const assignment = current(ticket.assignments);
  const result = current(ticket.results?.filter(row => ticket.resultVersion == null || row.version === ticket.resultVersion));
  const attention = ticket.attentions?.find(row => row.state === 'waiting' && attentionMatchesTicket(row, ticket));
  const delivery = ticket.deliveries?.filter(value => {
    const payload = value.payload;
    return (!payload?.type || payload.type === 'ticket.result')
      && (payload?.instructionRevision ?? payload?.result?.instructionRevision ?? 1) === revision
      && (!result || (payload?.resultVersion ?? payload?.result?.version) === result.version);
  }).at(-1);
  const continuationWait = ticket.continuationWait && Number.isSafeInteger(ticket.resultVersion)
    && ticket.continuationWait.sourceResultVersion === ticket.resultVersion
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
  if (status !== 'continuation_wait' || safetyWaitCodes.has(continuationWait?.code)
    || !Number.isSafeInteger(ticket.resultVersion) || ticket.resultVersion < 0) return null;
  const goalBudget = continuationWait?.code === 'GOAL_BUDGET_EXHAUSTED';
  return { goalBudget, label: goalBudget ? '管理持续目标额度' : continuationWait?.code === 'EXECUTION_BUDGET_EXHAUSTED' ? '增加10分钟并继续' : '恢复原单',
    input: { ticketId: ticket.id, expectedResultVersion: ticket.resultVersion,
      ...(continuationWait?.code === 'EXECUTION_BUDGET_EXHAUSTED' ? { additionalExecutionMs: 600000 } : {}) } };
}

/** System-only waiting guidance shared by chat, task details and the activity board. */
export function ticketWaiting(ticket) {
  const snapshot = ticketSnapshot(ticket);
  const { status, result, attention, continuationWait, safetyWait } = snapshot;
  const labels = { queued: '等待执行', waiting: '等待处理', awaiting_user: '等待你的答复', review_wait: '等待系统核验',
    continuation_wait: safetyWait ? '等待核实外部效果' : '等待续做资源', paused: '已暂停', pausing: '正在暂停',
    cancelling: '正在停止', uncertain: '执行状态待核实', blocked: '授权已变更' };
  if (!labels[status]) return null;
  const fallback = {
    queued: '工单已排队，等待可用执行容量。', awaiting_user: '需要补充这条工单的问题后继续受影响的工作。',
    review_wait: '验收服务尚未给出有效结论，原工单与成果已保留。',
    continuation_wait: '原工单已保留，恢复所需条件满足后可继续。', paused: '工单已暂停，已有成果保留。',
    pausing: '已请求暂停，正在等待执行端确认。', cancelling: '已请求停止，正在等待执行端确认。',
    uncertain: '执行是否完成尚未确认，请先核实状态。', blocked: '当前授权不满足继续执行的条件。',
  };
  const goalBudget = ticket.pauseReason?.kind === 'budget';
  const pauseReason = goalBudget ? `持续目标的${({ requests: '请求次数', tokens: 'Token', cost: '费用', deadline: '截止时间' })[ticket.pauseReason.reason] || '执行'}额度已用尽，请调整额度后继续。`
    : ticket.pauseReason?.kind === 'manual' ? '你已请求暂停，已有成果保留。' : null;
  const reason = safetyWait ? '外部操作是否生效尚未确认，核实前不会再次执行。'
    : attention?.question?.question || continuationWait?.reason || pauseReason
      || result?.review?.reason || fallback[status] || '系统正在核实等待原因。';
  const actions = [];
  const recovery = continuationRecovery(ticket);
  if (recovery) actions.push(recovery.goalBudget ? { kind: 'goals', label: recovery.label }
    : { kind: 'resume', label: recovery.label, input: recovery.input });
  else if (status === 'paused' && !safetyWait) actions.push(goalBudget ? { kind: 'goals', label: '管理持续目标额度' }
    : { kind: 'resume', label: '继续工单', input: { ticketId: ticket.id } });
  else if (status === 'review_wait' && !safetyWait && result?.review?.verdict === 'wait'
    && [undefined, 'review_wait'].includes(result.review.waitKind)
    && Number.isSafeInteger(ticket.resultVersion) && ticket.resultVersion > 0) {
    actions.push({ kind: 'review', label: '重试核验', input: { ticketId: ticket.id, expectedResultVersion: ticket.resultVersion } });
  }
  if (status === 'blocked') actions.push({ kind: 'tasks', label: '查看授权与要求' });
  actions.push({ kind: 'refresh', label: safetyWait || status === 'uncertain' ? '核实当前状态' : '刷新状态' });
  if (status !== 'cancelling') actions.push({ kind: 'stop', label: '停止工单', input: { ticketId: ticket.id } });
  return { status, label: safetyWait ? '等待核实外部效果' : labels[status], reason, actions,
    attention: safetyWait || status === 'uncertain' ? null : attention, retryAt: result?.review?.retryAt };
}
