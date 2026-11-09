export const terminalTicketStates = new Set(['completed', 'failed', 'cancelled', 'closed']);
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
  let status = ticket.status;
  if (attention && ['open', 'waiting'].includes(status)) {
    status = 'awaiting_user';
  } else if (status === 'waiting') {
    status = continuationWait ? 'continuation_wait' : result ? 'delivery_pending' : 'waiting';
  } else if (status === 'open') {
    status = assignment?.state || status;
  }
  return { assignment, result, delivery, attention, status, continuationWait, safetyWait: safetyWaitCodes.has(continuationWait?.code) };
}

/** Recovery is explicit and carries no quota: budget gates were removed on 2026-11-06. */
export function continuationRecovery(ticket) {
  const { status, continuationWait } = ticketSnapshot(ticket);
  if (status !== 'continuation_wait' || continuationWait?.code === 'LEGACY_CONTENT_REVIEW_RETIRED' || safetyWaitCodes.has(continuationWait?.code)
    || !Number.isSafeInteger(ticket.resultVersion) || ticket.resultVersion < 0) return null;
  return { label: '恢复原单', input: { ticketId: ticket.id, expectedResultVersion: ticket.resultVersion } };
}

/** Server facts only: the client never infers a timeout or claims executor exit. */
export function ticketExecutionNotice(ticket) {
  if (terminalTicketStates.has(ticket.status)) return null;
  const execution = ticket.execution || {};
  const raw = execution.uncertainty;
  const uncertainty = raw && (raw.instructionRevision == null || raw.instructionRevision === (ticket.instructionRevision ?? 1)) ? raw : null;
  const stopping = ticket.status === 'cancelling';
  if (!stopping && !uncertainty) return null;
  const overdue = stopping && execution.stopConfirmationOverdue === true;
  return {
    label: stopping ? overdue ? '停止已生效 · 执行端未确认退出' : '停止已生效 · 正在结束执行'
      : uncertainty?.escalated ? '执行异常 · 核查仍无结论' : uncertainty?.automatic === false ? '执行状态待恢复证据' : '执行状态自动核查中',
    reason: stopping ? overdue ? '后续动作已拦截，但执行端仍未确认退出。系统会继续核查，由 Router 跟进异常。'
      : '后续动作已拦截，正在等待执行端结束当前执行。'
      : uncertainty.reason || '执行端尚未确认当前状态，系统正在自动核查执行记录。',
    attempts: Number.isSafeInteger(uncertainty?.attempts) && uncertainty.attempts >= 0 ? uncertainty.attempts : null,
    nextCheckAt: uncertainty?.nextCheckAt ?? null,
    escalated: uncertainty?.escalated === true || overdue,
    stopRequestedAt: stopping ? execution.stopRequestedAt ?? null : null,
    reasonCode: uncertainty?.reasonCode || null,
    automatic: uncertainty?.automatic !== false,
    recoveryBlocked: uncertainty?.recoveryBlocked || null,
  };
}

export function executionVerificationSummary(notice) {
  if (!notice) return '';
  const parts = [];
  if (notice.attempts !== null) parts.push(`自动核查已查 ${notice.attempts} 次`);
  const next = new Date(notice.nextCheckAt);
  if (notice.nextCheckAt != null && Number.isFinite(next.getTime())) parts.push(`下次 ${next.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`);
  return parts.join(' · ');
}

/** System-only waiting guidance shared by chat, task details and the activity board. */
export function ticketWaiting(ticket) {
  const snapshot = ticketSnapshot(ticket);
  const { status, result, attention, continuationWait, safetyWait } = snapshot;
  const labels = { queued: '等待执行', waiting: '等待处理', awaiting_user: '等待你的答复', delivery_pending: '等待交付',
    continuation_wait: safetyWait ? '等待核实外部效果' : '等待续做', paused: '已暂停', pausing: '正在暂停',
    cancelling: '停止已生效 · 正在结束执行', uncertain: '执行状态待同步', blocked: '授权已变更' };
  if (!labels[status]) return null;
  const fallback = {
    queued: '工单已排队，等待可用执行容量。', awaiting_user: '需要补充这条工单的问题后继续受影响的工作。',
    delivery_pending: snapshot.delivery?.state === 'uncertain' ? '来源是否收到结果尚未确认，核实前不会重复发送。' : snapshot.delivery?.lastError || '执行已完成，结果已保存，正在交付原来源。',
    continuation_wait: '原工单已保留，恢复所需条件满足后可继续。', paused: '工单已暂停，已有成果保留。',
    pausing: '已请求暂停，正在等待执行端确认。', cancelling: '后续动作已拦截，正在等待执行端结束当前执行。',
    uncertain: '执行端状态尚未确认，正在读取核查记录。', blocked: '当前授权不满足继续执行的条件。',
  };
  const pauseReason = ticket.pauseReason?.kind === 'manual' ? '你已请求暂停，已有成果保留。' : null;
  const executionNotice = ticketExecutionNotice(ticket);
  const reason = executionNotice?.reason || (safetyWait ? '外部操作是否生效尚未确认，核实前不会再次执行。'
    : attention?.question?.question || continuationWait?.reason || pauseReason
      || (continuationWait?.code === 'LEGACY_CONTENT_REVIEW_RETIRED' ? '旧内容核验已停用，历史成果与证据保留。请明确继续要求后再执行。' : '') || fallback[status] || '系统正在核实等待原因。');
  const actions = [];
  const recovery = continuationRecovery(ticket);
  if (recovery) actions.push({ kind: 'resume', label: recovery.label, input: recovery.input });
  else if (status === 'paused' && !safetyWait) actions.push({ kind: 'resume', label: '继续工单', input: { ticketId: ticket.id } });
  if (status === 'blocked') actions.push({ kind: 'tasks', label: '查看授权与要求' });
  actions.push({ kind: 'refresh', label: '刷新记录' });
  if (status !== 'cancelling') actions.push({ kind: 'stop', label: '停止工单', input: { ticketId: ticket.id } });
  return { status, label: executionNotice?.label || (safetyWait ? '等待核实外部效果' : labels[status]), reason, actions, executionNotice, verificationSummary: executionVerificationSummary(executionNotice),
    attention: safetyWait || status === 'uncertain' ? null : attention };
}
