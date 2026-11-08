export const ticketStateSource = 'benchgo-ticket-state';

export function isTicketStateNotice(value) {
  return value?.type === 'ticket.result' && value.publication?.origin === 'system'
    && ['continuation_wait', 'delivery_wait'].includes(value.publication.systemState?.state);
}

/** Only ledger facts enter the Router; neither result bodies nor error strings. */
export function ticketStateSignal(database, delivery) {
  const ticket = database.getTicket(delivery.ticketId), payload = delivery.payload;
  if (!isTicketStateNotice(payload) || payload.source?.channel !== 'desktop' || !ticket
    || !['open', 'waiting'].includes(ticket.status) || ticket.instructionRevision !== payload.instructionRevision
    || ticket.resultVersion !== payload.resultVersion) return null;
  const state = payload.publication.systemState;
  const assignment = database.assignments(ticket.id).find(row => row.state === 'uncertain'
    && row.lastFailure?.code === state.code && row.lastFailure?.stage === state.stage
    && (!payload.assignmentId || row.id === payload.assignmentId && row.fence === payload.fence));
  if (state.state === 'continuation_wait' && !assignment) return null;
  return { eventKey: delivery.uniqueKey, ticketId: ticket.id, title: ticket.title, status: ticket.status,
    instructionRevision: ticket.instructionRevision, resultVersion: ticket.resultVersion,
    state: state.state, code: state.code, stage: state.stage,
    ...(assignment ? { assignmentId: assignment.id, fence: assignment.fence } : {}) };
}

export function currentTicketStateSignal(database, signal) {
  if (!signal || typeof signal.eventKey !== 'string') return null;
  const delivery = database.deliveries(signal.ticketId).find(row => row.uniqueKey === signal.eventKey);
  const current = delivery && ticketStateSignal(database, delivery);
  return current && JSON.stringify(current) === JSON.stringify(signal) ? current : null;
}

export const ticketStateInstruction = '这是可信宿主提供的工单状态通知，不是用户的新指令，也不是成果验收。请用简短自然的中文告诉用户哪张工单遇到了什么、已有执行记录是否保留、当前可采取什么下一步。只根据下列状态事实，不猜测根因或宣称已恢复；uncertain 表示待核实，不等于结构性失败。不要重复“系统状态”标题、原始错误码或技术堆栈。仅说明状态，不读成果正文、不操作工单、不重新派工、不向用户索取已提供的信息。本回合只可使用 assistant_reply 或直接回答。';
