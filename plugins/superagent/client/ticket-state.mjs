export const terminalTicketStates = new Set(['completed']);
export const ticketLabels = Object.freeze({ running: '进行', waiting: '等待', completed: '完成' });
export const shortTicketText = (value, max = 240) => Array.from(String(value || '').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
export function ticketResultSummary(result) {
  return shortTicketText(result?.summary || result?.finalSummary || result?.delivery?.text);
}
const safetyWaitCodes = new Set(['EXECUTION_EFFECTS_UNKNOWN', 'EXECUTION_NOT_VERIFIED', 'EXECUTION_STOP_UNCONFIRMED']);

export function attentionMatchesTicket(attention, ticket) {
  const revision = ticket.instructionRevision ?? 1;
  const assignment = ticket.assignments?.find(row => row.id === attention.assignmentId);
  const applied = assignment?.appliedSnapshot?.instructionRevision ?? assignment?.instructionRevision ?? revision;
  if ((attention.instructionRevision ?? applied) !== applied) return false;
  return attention.origin !== 'review';
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
    ? ticket.continuationWait : null;
  const status = ticket.status;
  return { assignment, result, delivery, attention, status, continuationWait, safetyWait: safetyWaitCodes.has(continuationWait?.code) };
}

/** Recovery is explicit and carries no quota: budget gates were removed on 2026-11-06. */
export function continuationRecovery(ticket) {
  const { status, continuationWait } = ticketSnapshot(ticket);
  if (status !== 'waiting' || !continuationWait || ['LEGACY_CONTENT_REVIEW_RETIRED', 'EXECUTION_FAILED'].includes(continuationWait.code) || safetyWaitCodes.has(continuationWait.code)
    || Object.values(ticket.executionControl || {}).some(Boolean)
    || !Number.isSafeInteger(ticket.resultVersion) || ticket.resultVersion < 0) return null;
  return { label: '恢复原单', input: { ticketId: ticket.id, expectedResultVersion: ticket.resultVersion } };
}

/** System-only waiting guidance shared by chat, task details and the activity board. */
export function ticketWaiting(ticket) {
  const snapshot = ticketSnapshot(ticket);
  const { status, result, attention, continuationWait, safetyWait } = snapshot;
  if (status !== 'waiting') return null;
  const control = ticket.executionControl || {};
  const uncertain = safetyWait || snapshot.assignment?.state === 'uncertain' || snapshot.delivery?.state === 'uncertain';
  const failed = continuationWait?.code === 'EXECUTION_FAILED' || result?.outcome === 'failed';
  const failureReason = failed ? [shortTicketText(result?.failure?.cause || continuationWait?.reason, 100),
    shortTicketText(result?.failure?.resumeConditions || continuationWait?.resumeConditions, 100), '调整要求后继续。'].filter(Boolean).join('；') : '';
  const reason = shortTicketText(
    control.stopRequested ? '已请求停止，正在等待执行端确认。'
    : control.stopped ? '已停止，已有成果保留；明确继续要求后再推进。'
    : control.pauseRequested ? '已请求暂停，正在等待执行端确认。'
    : control.paused ? '工单已暂停，已有成果保留。'
    : uncertain ? '执行或外部操作是否生效尚未确认，核实前不会再次执行。'
    : attention?.question?.question || failureReason || continuationWait?.reason
      || (snapshot.assignment?.state === 'blocked' ? '当前授权不满足继续执行的条件，请检查授权与要求。' : '')
      || (result ? snapshot.delivery?.lastError || '结果已保存，等待交付原来源。' : snapshot.assignment?.state === 'queued' || !snapshot.assignment ? '工单已排队，等待可用执行容量。' : '等待恢复所需条件，已有记录保留。'));
  const actions = [];
  const recovery = continuationRecovery(ticket);
  if (recovery) actions.push({ kind: 'resume', label: recovery.label, input: recovery.input });
  else if (control.paused && !uncertain && !control.stopRequested && !control.stopped) actions.push({ kind: 'resume', label: '继续工单', input: { ticketId: ticket.id } });
  if (failed || control.stopped || snapshot.assignment?.state === 'blocked') actions.push({ kind: 'tasks', label: '调整要求' });
  actions.push({ kind: 'refresh', label: uncertain ? '核实当前状态' : '刷新状态' });
  if (!control.stopRequested && !control.stopped) actions.push({ kind: 'stop', label: '停止工单', input: { ticketId: ticket.id } });
  return { status, label: ticketLabels.waiting, reason, actions,
    attention: uncertain || control.stopRequested || control.stopped ? null : attention };
}
