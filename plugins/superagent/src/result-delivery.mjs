import { isRouterTicketAck } from './ticket-ack.mjs';

const systemStates = new Set(['delivery_wait', 'continuation_wait', 'action_verified']);
export function systemStateDelivery({ state = 'continuation_wait', code = 'EXECUTION_UNAVAILABLE', stage = 'execution' } = {}) {
  if (!systemStates.has(state)) throw new Error('Invalid system state');
  const text = code === 'EXECUTION_EFFECTS_UNKNOWN' ? '外部动作效果待核实，确认前不会重复执行。'
    : state === 'action_verified' ? '操作回执已核实。' : state === 'delivery_wait' ? '结果已保存，等待原来源交付。' : '执行记录已保留，等待恢复条件。';
  return { action: 'deliver', origin: 'system', systemState: { state, code, stage }, text: `系统状态：${text}` };
}

/** Protocol checks only; Router expression does not accept or re-run Worker work. */
export function validateDelivery(value) {
  if (!value || !['deliver', 'ask'].includes(value.action) || typeof value.text !== 'string' || !value.text.trim()) throw new Error('Delivery requires text');
  if (value.options !== undefined && (!Array.isArray(value.options) || value.options.length > 6 || value.options.some(x => typeof x !== 'string' || !x.trim() || x.length > 500))) throw new Error('Invalid delivery options');
  let provenance;
  if (value.origin === 'system') {
    if (value.action !== 'deliver' || !systemStates.has(value.systemState?.state)
      || typeof value.systemState.code !== 'string' || !/^[A-Z0-9_:-]{1,100}$/.test(value.systemState.code)
      || typeof value.systemState.stage !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(value.systemState.stage)) throw new Error('Invalid system publication');
    provenance = { origin: 'system', systemState: { state: value.systemState.state, code: value.systemState.code, stage: value.systemState.stage } };
  } else {
    if (value.systemState !== undefined) throw new Error('System state requires a system publication');
    if (value.origin !== undefined && !['worker', 'router'].includes(value.origin)) throw new Error('Invalid publication origin');
    if (value.origin === 'router' && (value.action !== 'deliver' || value.options !== undefined)) throw new Error('Router reply requires natural text');
    provenance = value.origin ? { origin: value.origin } : {};
  }
  return { action: value.action, text: value.text, ...(value.options?.length ? { options: value.options } : {}), ...provenance };
}
export function resultDelivery({ result }) {
  const body = result.finalSummary ?? result.summary;
  if (typeof body !== 'string' || !body.trim()) throw new Error('Result requires its original body');
  return { action: 'deliver', origin: 'worker', text: body };
}
export function resultOutbox({ ticket, result, delivery }) {
  const envelope = { type: 'ticket.result', source: ticket.mandate.source, ticketId: ticket.id, title: ticket.title,
    instructionRevision: ticket.instructionRevision, resultVersion: ticket.resultVersion + 1, evidenceRefs: result.evidenceRefs };
  // Synchronous Router actions already answer in their original tool turn.
  // Their audit row is not another Worker completion awaiting expression.
  if (delivery?.origin === 'system' && delivery.systemState?.state === 'action_verified')
    return { ...envelope, replyState: 'suppressed', suppressionReason: 'router-action-already-replied' };
  return { ...envelope, outcome: result.outcome || 'completed', replyState: 'pending' };
}

export function deliverySuppression(database, row) {
  const payload = row.payload;
  if (payload.type === 'ticket.accepted') {
    if (!isRouterTicketAck(payload)) return 'legacy-or-invalid-ack';
    const ticket = database.getTicket(row.ticketId);
    if (!ticket || !['open', 'waiting'].includes(ticket.status) || ticket.resultVersion > 0) return 'ack-superseded';
    if (payload.ticketId !== ticket.id || JSON.stringify(payload.source) !== JSON.stringify(ticket.mandate.source)) return 'source-mismatch';
    return null;
  }
  if (!['ticket.result', 'ticket.attention'].includes(payload.type)) return null;
  const ticket = database.getTicket(row.ticketId);
  if (!ticket || ['cancelled', 'cancelling'].includes(ticket.status)) return 'ticket-inactive';
  if (payload.ticketId !== undefined && payload.ticketId !== ticket.id) return 'ticket-mismatch';
  if (payload.type === 'ticket.attention' && ['completed', 'failed', 'closed'].includes(ticket.status)) return 'ticket-inactive';
  if (payload.instructionRevision !== undefined && payload.instructionRevision !== ticket.instructionRevision) return 'superseded-instruction';
  if (payload.resultVersion !== undefined && payload.resultVersion !== ticket.resultVersion) return 'superseded-result';
  if (JSON.stringify(payload.source) !== JSON.stringify(ticket.mandate.source)) return 'source-mismatch';
  if (payload.replyState === 'suppressed' && payload.suppressionReason === 'router-action-already-replied') return payload.suppressionReason;
  const state = payload.stateSignal || (payload.publication?.origin === 'system' ? payload.publication.systemState : null);
  if (state?.state === 'continuation_wait') {
    const current = database.assignments?.(ticket.id)?.some(row => row.state === 'uncertain'
      && row.lastFailure?.code === state.code && row.lastFailure?.stage === state.stage
      && (!payload.assignmentId || row.id === payload.assignmentId && row.fence === payload.fence));
    if (!current) return 'state-superseded';
  }
  if (payload.type === 'ticket.attention') {
    const attention = database.attentions?.(ticket.id)?.find(entry => entry.id === payload.attentionId);
    if (attention?.answerTriggerId) return 'attention-resolved';
  }
  return null;
}
