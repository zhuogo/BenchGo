// Read-only ledger facts. These thresholds change presentation, never execution gates.
export const stopConfirmationNoticeMs = 30_000;
export const verificationEscalationAttempts = 6;
const terminal = new Set(['completed', 'failed', 'closed', 'cancelled']);
const iso = value => Number.isFinite(Number(value)) && value > 0 ? new Date(value).toISOString() : null;

export function executionUncertainty(database, ticket, { now = Date.now() } = {}) {
  if (!ticket || terminal.has(ticket.status) || ticket.status === 'cancelling') return null;
  const assignments = database.assignments(ticket.id);
  const assignment = [...assignments].reverse().find(row => row.state === 'uncertain'
    || ticket.status === 'pausing' && ['claimed', 'uncertain'].includes(row.state) && row.leaseUntil <= now);
  if (!assignment) return null;
  const run = database.runs(assignment.id).find(row => row.fence === assignment.fence);
  const code = assignment.lastFailure?.code, evidence = run?.evidence;
  const pause = ticket.status === 'pausing' || code === 'EXECUTION_PAUSE_UNVERIFIED';
  const external = code === 'EXECUTION_EFFECTS_UNKNOWN' || evidence?.executionEffects?.effectsVerified === false;
  const mismatch = ['RUN_CONFLICT', 'CHECKPOINT_CONFLICT', 'EVIDENCE_MISMATCH'].includes(assignment.verificationError);
  const reasonCode = external ? 'external-effects-unknown' : pause ? 'pause-unconfirmed'
    : mismatch ? 'evidence-mismatch' : code === 'WORKER_TURN_INCOMPLETE' ? 'worker-incomplete' : 'session-interrupted';
  const reason = { 'external-effects-unknown': '外部动作的实际效果尚未核清', 'pause-unconfirmed': '执行端尚未确认安全暂停',
    'evidence-mismatch': '保存的执行证据与当前记录不一致', 'worker-incomplete': '执行尚未完整结束',
    'session-interrupted': '执行会话中断或重启，正在核对已保存的记录' }[reasonCode];
  const attempts = (pause ? assignment.pauseRecoveryAttempts : assignment.verificationInspectionAttempts) || 0;
  const scheduled = pause ? assignment.pauseRecoveryAfter : assignment.verificationAfter;
  const recoverable = !!run && !!evidence && (pause ? evidence.waitingPause === true
    : typeof evidence.summary === 'string' && typeof evidence.transcript?.hash === 'string'
      && (!run.environment || typeof evidence.checkpoint?.manifestHash === 'string'));
  return { reasonCode, reason, attempts, nextCheckAt: recoverable ? iso(scheduled) : null,
    escalated: attempts >= verificationEscalationAttempts, automatic: recoverable,
    ...(!recoverable ? { recoveryBlocked: '尚无可供现有恢复接缝核对的完整结束证据；不得据此重跑' } : {}),
    assignmentId: assignment.id, runId: run?.id || null, fence: assignment.fence,
    instructionRevision: ticket.instructionRevision };
}

export function executionStopConfirmation(database, ticket, { now = Date.now() } = {}) {
  if (ticket?.status !== 'cancelling') return { stopRequestedAt: null, stopConfirmationOverdue: false };
  const pending = database.assignments(ticket.id).filter(row => row.stopRequest
    && row.stopRequest.fence === row.fence && !(row.executionStopped?.fence === row.fence
      && row.executionStopped?.owner === row.stopRequest.owner));
  const requestedAt = pending.map(row => row.stopRequest.at).filter(value => Number.isFinite(Date.parse(value))).sort()[0] || null;
  return { stopRequestedAt: requestedAt,
    stopConfirmationOverdue: !!requestedAt && now - Date.parse(requestedAt) >= stopConfirmationNoticeMs };
}

export function executionRecoverySignal(database, ticket, { now = Date.now(), previous } = {}) {
  const uncertainty = executionUncertainty(database, ticket, { now });
  if (uncertainty) {
    const phase = uncertainty.escalated ? 'escalated' : 'entered';
    return { kind: 'recovery', eventKey: `execution-recovery:${uncertainty.assignmentId}:${uncertainty.fence}:${ticket.instructionRevision}:${phase}`,
      ticketId: ticket.id, title: ticket.title, target: ticket.target, source: ticket.mandate.source,
      instructionRevision: ticket.instructionRevision, resultVersion: ticket.resultVersion, phase, ...uncertainty };
  }
  // Only a previously signalled execution can produce a recovery follow-up.
  if (!previous || previous.kind !== 'recovery' || previous.phase === 'resolved' || previous.ticketId !== ticket?.id
    || previous.instructionRevision !== ticket.instructionRevision || terminal.has(ticket.status) || ticket.status === 'cancelling') return null;
  const assignment = database.assignments(ticket.id).find(row => row.id === previous.assignmentId && row.fence === previous.fence);
  if (!assignment || !['queued', 'claimed', 'paused', 'waiting', 'completed'].includes(assignment.state)) return null;
  return { kind: 'recovery', eventKey: `execution-recovery:${assignment.id}:${assignment.fence}:${ticket.instructionRevision}:resolved`,
    ticketId: ticket.id, title: ticket.title, target: ticket.target, source: ticket.mandate.source,
    instructionRevision: ticket.instructionRevision, resultVersion: ticket.resultVersion,
    phase: 'resolved', assignmentId: assignment.id, runId: previous.runId, fence: assignment.fence,
    disposition: assignment.verificationOnly ? 'verified-result-finalization'
      : assignment.contextContinuation ? 'verified-context-continuation'
        : ticket.status === 'paused' ? 'verified-paused' : 'execution-reconciled' };
}

export const recoverySignalIdentity = value => JSON.stringify({ ...value, title: undefined, target: undefined,
  reason: undefined, attempts: undefined, nextCheckAt: undefined, automatic: undefined,
  recoveryBlocked: undefined, resultVersion: undefined });

export function currentExecutionRecoverySignal(database, signal, { now = Date.now() } = {}) {
  const ticket = database.getTicket(signal?.ticketId);
  const current = ticket && executionRecoverySignal(database, ticket, { now, previous: signal.phase === 'resolved' ? { ...signal, phase: 'entered' } : undefined });
  return current && recoverySignalIdentity(current) === recoverySignalIdentity(signal) ? current : null;
}
