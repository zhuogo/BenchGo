import { isRouterTicketAck } from './ticket-ack.mjs';

const systemStates = new Set(['review_wait', 'delivery_wait', 'budget_wait', 'continuation_wait', 'action_verified']);

/** Host failures are explicit system states, never canned messages attributed to the assistant. */
export function systemStateDelivery({ state = 'review_wait', code = 'REVIEW_UNAVAILABLE', stage = 'review' } = {}) {
  const labels = { review_wait: '结果核验暂不可用', delivery_wait: '交付正文尚未生成', budget_wait: '任务资源暂不足', continuation_wait: '任务续做暂不可用' };
  const conditions = {
    // Legacy codes from budget gates removed on 2026-11-06; parked Tickets resume without added quota.
    EXECUTION_BUDGET_EXHAUSTED: '此前的执行时长限制已取消，可直接继续原工单',
    EXECUTION_EFFECTS_UNKNOWN: '有外部动作的效果尚未核实，核实前不会重放执行',
    NO_PROGRESS: '多次续做未见成果或证据变化，已暂停自动续做，等待恢复决定',
  };
  if (!systemStates.has(state)) throw new Error('Invalid system state');
  return { action: 'deliver', origin: 'system', systemState: { state, code, stage },
    text: state === 'action_verified' ? '系统状态：操作已完成，回执已核实。详情可在工单中查看。'
      : `系统状态：${conditions[code] || labels[state]}。执行记录已保留${conditions[code] ? '。' : '，正在等待恢复所需条件。'}` };
}

/** Only Router-authored delivery may cross the human message boundary. */
export function validateDelivery(value) {
  if (!value || !['deliver', 'ask', 'silent'].includes(value.action)) throw new Error('Invalid Router delivery decision');
  if (value.action !== 'silent' && (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 12000)) throw new Error('Router delivery requires bounded text');
  if (value.options !== undefined && (!Array.isArray(value.options) || value.options.length > 6 || value.options.some(x => typeof x !== 'string' || !x.trim() || x.length > 500))) throw new Error('Invalid delivery options');
  if (value.action === 'silent' && (value.text?.trim() || value.options?.length)) throw new Error('Silent delivery cannot contain a message');
  let system;
  if (value.origin === 'system') {
    if (value.action !== 'deliver' || !systemStates.has(value.systemState?.state)
      || typeof value.systemState.code !== 'string' || !/^[A-Z0-9_:-]{1,100}$/.test(value.systemState.code)
      || typeof value.systemState.stage !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(value.systemState.stage)) throw new Error('Invalid system publication');
    system = { origin: 'system', systemState: { state: value.systemState.state, code: value.systemState.code, stage: value.systemState.stage } };
  } else if (value.systemState !== undefined) throw new Error('System state requires a system publication');
  return { action: value.action, ...(value.action !== 'silent' ? { text: value.text } : {}), ...(value.options?.length ? { options: [...new Set(value.options.map(x => x.trim()))] } : {}), ...system };
}

/** Host evidence of an unchanged successful delivery, never a Worker's claim. */
export function canSilenceResult({ ticket, result, previous, previousDelivered = false }) {
  return !!(previousDelivered && previous?.delivery?.action === 'deliver' && previous.review?.verdict === 'passed'
    && previous.instructionRevision === ticket.instructionRevision && previous.summary === result.summary
    && result.transcript?.hash && previous.transcript?.hash === result.transcript.hash
    && JSON.stringify(previous.checkpoint) === JSON.stringify(result.checkpoint)
    && JSON.stringify(previous.evidenceRefs) === JSON.stringify(result.evidenceRefs));
}

/** Trusted publication facts for Router prompting; system status notices are not task delivery. */
export function publicationContext(database, ticket, result) {
  const version = ticket?.resultVersion;
  const previous = Number.isSafeInteger(version) && version > 0 && typeof database?.results === 'function'
    ? database.results(ticket.id).at(-1) : undefined;
  const hasPreviouslyDelivered = !!(previous && previous.version === version
    && previous.instructionRevision === ticket.instructionRevision
    && previous.review?.verdict === 'passed'
    && previous.delivery?.action === 'deliver' && previous.delivery.origin !== 'system'
    && typeof database?.deliveries === 'function'
    && database.deliveries(ticket.id).some(row => row.state === 'sent'
      && row.payload?.type === 'ticket.result'
      && row.payload.resultVersion === version
      && row.payload.instructionRevision === ticket.instructionRevision
      && row.payload.publication?.action === 'deliver'
      && row.payload.publication.origin !== 'system'
      && JSON.stringify(row.payload.publication) === JSON.stringify(previous.delivery)
      && row.receipt?.status === 'accepted'));
  return { hasPreviouslyDelivered, silentAllowed: canSilenceResult({ ticket, result, previous, previousDelivered: hasPreviouslyDelivered }) };
}

export function resultDelivery({ ticket, result, verdict, previous, previousDelivered = false }) {
  // A missing delivery (old persisted/injected reviewer) must never forward raw Worker prose.
  const fallback = systemStateDelivery({ state: 'delivery_wait', code: 'ROUTER_DELIVERY_MISSING', stage: 'publication' });
  let delivery = verdict.delivery ? validateDelivery(verdict.delivery) : fallback;
  if (delivery.action === 'ask' && (!['permission', 'information', 'scope'].includes(verdict.userDecision?.kind)
    || typeof verdict.userDecision?.question !== 'string' || !verdict.userDecision.question.trim())) delivery = fallback;
  // Silence is permitted only for a provably unchanged, previously delivered result.
  // A model's assertion that a requested task is unimportant is not authorization to hide it.
  if (delivery.action === 'silent') {
    if (verdict.verdict !== 'passed' || !canSilenceResult({ ticket, result, previous, previousDelivered })) delivery = fallback;
  }
  return delivery;
}

export function resultOutbox({ ticket, result, delivery }) {
  return { type: 'ticket.result', source: ticket.mandate.source, ticketId: ticket.id,
    instructionRevision: ticket.instructionRevision, resultVersion: ticket.resultVersion + 1,
    publication: delivery, ...(delivery.text ? { text: delivery.text } : {}), evidenceRefs: result.evidenceRefs };
}

export function previouslyDelivered(database, ticket) {
  return database.deliveries(ticket.id).some(row => row.state === 'sent'
    && row.payload.resultVersion === ticket.resultVersion
    && row.payload.publication?.action === 'deliver' && row.receipt?.status === 'accepted');
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
  if (payload.publication?.action === 'silent') return 'silent';
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
