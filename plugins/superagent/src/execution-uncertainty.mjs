import { ticketStopped } from './ticket-lifecycle.mjs';
// Read-only saved-result and interrupted-execution facts.
export const stopConfirmationNoticeMs = 30_000;

export function hasSavedCompletion(run) {
  const evidence = run?.evidence;
  return !!evidence?.summary && (!evidence.completion || evidence.completion.kind === 'completed')
    && !evidence.interrupted && !evidence.waitingPause && !evidence.waitingAttention;
}

export function executionUncertainty(database, ticket, { now = Date.now() } = {}) {
  if (!ticket || ticket.status === 'completed' || ticketStopped(ticket)) return null;
  const assignments = database.assignments(ticket.id);
  const assignment = [...assignments].reverse().find(row => (row.instructionRevision ?? 1) === ticket.instructionRevision
    && (row.state === 'uncertain' || ticket.executionControl?.pauseRequested && ['claimed', 'uncertain'].includes(row.state) && row.leaseUntil <= now));
  if (!assignment) return null;
  const run = database.runs(assignment.id).find(row => row.fence === assignment.fence);
  const hasCompletedResult = hasSavedCompletion(run);
  const recovery = assignment.savedResultRecovery?.fence === assignment.fence && assignment.savedResultRecovery?.runId === run?.id ? assignment.savedResultRecovery : null;
  const reasonCode = hasCompletedResult ? 'saved-result-pending' : 'session-interrupted';
  const failure = assignment.lastFailure;
  const interruptedReasons = {
    NETWORK: '执行连接中断。', TIMEOUT: '执行请求超时。', RATE_LIMIT: '执行请求受到供应商限流。',
    WORKER_TURN_INCOMPLETE: '原执行会话缺少完整结束记录。', EXECUTION_EFFECTS_UNKNOWN: '原执行缺少完整的工具回执。',
    WORKER_MODEL_ROUTE: '原执行绑定的模型当前不可用。', MANDATE_REVOKED: '原执行授权已失效。',
    FENCING_CONFLICT: '原执行的归属或租约已变化。', ROLE_PRESET_UNAVAILABLE: '执行所需的角色配置不可用。',
    SESSION_ROLE_OWNERSHIP: '无法确认原执行会话的归属。',
  };
  const interruption = interruptedReasons[failure?.code] || '原执行会话已中断，缺少可核对的完整结束记录。';
  const nextStep = failure?.effects?.effectsVerified === false
    ? '尚不能确认工具或外部操作是否结束，请先核实原执行记录和实际结果，再继续原工单。'
    : '请查看原执行记录并排除该阻塞，再继续原工单。';
  return { reasonCode, reason: hasCompletedResult ? '执行原稿已保留，系统正在自动完成保存收尾，无需授权。' : interruption + nextStep,
    ...(hasCompletedResult ? { automatic: true, attempts: recovery?.attempts || 0, nextCheckAt: recovery?.nextAttemptAt ?? now } : {}),
    hasCompletedResult, assignmentId: assignment.id, runId: run?.id || null, sessionId: run?.sessionId || null,
    fence: assignment.fence, instructionRevision: ticket.instructionRevision };

}

export function executionStopConfirmation(database, ticket, { now = Date.now() } = {}) {
  if (!ticket?.executionControl?.stopRequested || ticket.executionControl?.stopped) return { stopRequestedAt: null, stopConfirmationOverdue: false };
  const pending = database.assignments(ticket.id).filter(row => row.stopRequest
    && row.stopRequest.fence === row.fence && !(row.executionStopped?.fence === row.fence
      && row.executionStopped?.owner === row.stopRequest.owner));
  const requestedAt = pending.map(row => row.stopRequest.at).filter(value => Number.isFinite(Date.parse(value))).sort()[0] || null;
  return { stopRequestedAt: requestedAt,
    stopConfirmationOverdue: !!requestedAt && now - Date.parse(requestedAt) >= stopConfirmationNoticeMs };
}
