import { isRouterTicketAck } from './ticket-ack.mjs';

const systemStates = new Set(['delivery_wait', 'continuation_wait', 'action_verified']);
export function systemStateDelivery({ state = 'continuation_wait', code = 'EXECUTION_UNAVAILABLE', stage = 'execution' } = {}) {
  if (!systemStates.has(state)) throw new Error('Invalid system state');
  const text = code === 'EXECUTION_EFFECTS_UNKNOWN' ? '外部动作效果待核实，确认前不会重复执行。'
    : state === 'action_verified' ? '操作回执已核实。' : state === 'delivery_wait' ? '结果已保存，等待原来源交付。' : '执行记录已保留，等待恢复条件。';
  return { action: 'deliver', origin: 'system', systemState: { state, code, stage }, text: `系统状态：${text}` };
}

/** Protocol checks only; no second model reads or rewrites the Worker result. */
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
    if (value.origin !== undefined && value.origin !== 'worker') throw new Error('Invalid publication origin');
    provenance = value.origin === 'worker' ? { origin: 'worker' } : {};
  }
  return { action: value.action, text: value.text, ...(value.options?.length ? { options: value.options } : {}), ...provenance };
}
export function resultDelivery({ ticket, result }) {
  const body = result.finalSummary ?? result.summary;
  if (typeof body !== 'string' || !body.trim()) throw new Error('Result requires its original body');
  return { action: 'deliver', origin: 'worker', text: `【${ticket.title || ticket.target}】\n\n${body}` };
}
export function resultOutbox({ ticket, result, delivery }) {
  return { type: 'ticket.result', source: ticket.mandate.source, ticketId: ticket.id, title: ticket.title,
    instructionRevision: ticket.instructionRevision, resultVersion: ticket.resultVersion + 1,
    outcome: result.outcome || 'completed', publication: delivery, text: delivery.text, evidenceRefs: result.evidenceRefs };
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
  if (payload.type === 'ticket.attention' && ['completed', 'failed', 'closed'].includes(ticket.status)) return 'ticket-inactive';
  if (payload.instructionRevision !== undefined && payload.instructionRevision !== ticket.instructionRevision) return 'superseded-instruction';
  if (payload.resultVersion !== undefined && payload.resultVersion !== ticket.resultVersion) return 'superseded-result';
  if (JSON.stringify(payload.source) !== JSON.stringify(ticket.mandate.source)) return 'source-mismatch';
  if (payload.type === 'ticket.attention') {
    const attention = database.attentions?.(ticket.id)?.find(entry => entry.id === payload.attentionId);
    if (attention?.answerTriggerId) return 'attention-resolved';
  }
  return null;
}
