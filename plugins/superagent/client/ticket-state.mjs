import { executionStatusText } from '../src/ticket-lifecycle.mjs';

export const terminalTicketStates = new Set(['completed']);
export const ticketLabels = Object.freeze({ running: '进行', waiting: '等待', completed: '完成' });
export const shortTicketText = (value, max = 240) => Array.from(String(value || '').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
export function ticketResultSummary(result) {
  return shortTicketText(result?.summary || result?.delivery?.text);
}
const safetyWaitCodes = new Set(['EXECUTION_EFFECTS_UNKNOWN', 'EXECUTION_NOT_VERIFIED', 'EXECUTION_STOP_UNCONFIRMED']);

export function attentionMatchesTicket(attention, ticket) {
  const revision = ticket.instructionRevision ?? 1;
  const assignment = ticket.assignments?.find(row => row.id === attention.assignmentId);
  const applied = assignment?.appliedSnapshot?.instructionRevision ?? assignment?.instructionRevision ?? revision;
  return (attention.instructionRevision ?? applied) === applied;
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

/** Recovery is explicit: only a real user action resumes a waiting Ticket. */
export function continuationRecovery(ticket) {
  const { status, continuationWait } = ticketSnapshot(ticket);
  if (status !== 'waiting' || !continuationWait || continuationWait.stage === 'scheduling' || continuationWait.code === 'EXECUTION_FAILED' || safetyWaitCodes.has(continuationWait.code)
    || Object.values(ticket.executionControl || {}).some(Boolean)
    || !Number.isSafeInteger(ticket.resultVersion) || ticket.resultVersion < 0) return null;
  return { label: '恢复原单', input: { ticketId: ticket.id, expectedResultVersion: ticket.resultVersion } };
}

/** Server facts only: the client never infers a timeout or claims executor exit. */
export function ticketExecutionNotice(ticket) {
  if (terminalTicketStates.has(ticket.status)) return null;
  const execution = ticket.execution || {};
  const raw = execution.uncertainty;
  const uncertainty = raw && (raw.instructionRevision == null || raw.instructionRevision === (ticket.instructionRevision ?? 1)) ? raw : null;
  const stopping = ticket.executionControl?.stopRequested === true;
  if (!stopping && !uncertainty) return null;
  const overdue = stopping && execution.stopConfirmationOverdue === true;
  return {
    label: stopping ? overdue ? '停止已生效 · 执行端未确认退出' : '停止已生效 · 正在结束执行'
      : uncertainty.reasonCode === 'saved-result-pending' ? '正在保存结果' : '执行受阻 · 等待处理',
    reason: stopping ? overdue ? '后续动作已拦截，但执行端仍未确认退出。'
      : '后续动作已拦截，正在等待执行端结束当前执行。'
      : executionStatusText(uncertainty.reason) || '执行尚未完整结束，已有记录保留。',
    escalated: uncertainty?.escalated === true || overdue,
    stopRequestedAt: stopping ? execution.stopRequestedAt ?? null : null,
    reasonCode: uncertainty?.reasonCode || null,
    recoveryBlocked: executionStatusText(uncertainty?.recoveryBlocked) || null,
  };
}

/** System-only waiting guidance shared by chat, task details and the activity board. */
export function ticketWaiting(ticket) {
  const snapshot = ticketSnapshot(ticket);
  const { status, result, attention, continuationWait, safetyWait } = snapshot;
  if (status !== 'waiting') return null;
  const control = ticket.executionControl || {};
  const executionNotice = ticketExecutionNotice(ticket);
  const uncertain = !!executionNotice || safetyWait || snapshot.assignment?.state === 'uncertain';
  const failed = continuationWait?.code === 'EXECUTION_FAILED' || result?.outcome === 'failed';
  const failureReason = failed ? [shortTicketText(continuationWait?.reason, 100),
    shortTicketText(continuationWait?.resumeConditions, 100), '调整要求后继续。'].filter(Boolean).join('；') : '';
  const reason = shortTicketText(
    control.stopRequested ? executionNotice?.reason || '停止已生效，正在等待执行端确认退出。'
    : control.stopped ? '已停止，已有成果保留；明确继续要求后再推进。'
    : control.pauseRequested ? '已请求暂停，正在等待执行端确认。'
    : control.paused ? '工单已暂停，已有成果保留。'
    : uncertain ? executionNotice?.reason || '执行或外部操作是否生效尚未确认，核实前不会再次执行。'
    : attention?.question?.question || failureReason || executionStatusText(continuationWait?.reason)
      || (snapshot.assignment?.state === 'blocked' ? '当前授权不满足继续执行的条件，请检查授权与要求。' : '')
      || '等待原因尚未明确，请刷新工单记录。');
  const actions = [];
  const recovery = continuationRecovery(ticket);
  const interrupted = executionNotice?.reasonCode === 'session-interrupted'
    && !Object.values(control).some(Boolean) && !attention;
  if (interrupted) actions.push({ kind: 'resume', label: '继续原工单', input: { ticketId: ticket.id } });
  else if (recovery) actions.push({ kind: 'resume', label: recovery.label, input: recovery.input });
  else if (control.paused && !uncertain && !control.stopRequested && !control.stopped) actions.push({ kind: 'resume', label: '继续工单', input: { ticketId: ticket.id } });
  if (failed || control.stopped || snapshot.assignment?.state === 'blocked') actions.push({ kind: 'tasks', label: '调整要求' });
  actions.push({ kind: 'refresh', label: '刷新记录' });
  return { status, label: ticketLabels.waiting, reason, actions, executionNotice,
    attention: uncertain || control.stopRequested || control.stopped ? null : attention };
}
