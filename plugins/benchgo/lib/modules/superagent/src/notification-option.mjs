import { ticketStopped } from './ticket-lifecycle.mjs';
/** Options express intent only; approvals retain their independent action-bound protocol. */
export async function replyNotificationOption({ database, orchestration, engine }, { eventId, threadId = 'main', text }) {
  if (typeof eventId !== 'string' || !eventId || eventId.length > 150 || typeof text !== 'string') throw new Error('无效选项回复');
  let after = 0, event;
  do {
    const page = database.notifications({ after, limit: 500, threadId });
    event = page.events.find(row => row.eventId === eventId);
    if (event || !page.hasMore || page.cursor <= after) break;
    after = page.cursor;
  } while (true);
  if (!event || event.threadId !== threadId || !event.options?.includes(text)) throw new Error('选项不存在或不属于当前会话');
  const ticketId = event.taskId || event.ticketId;
  const ticket = orchestration.getTicket(ticketId);
  if (!ticket || (ticket.mandate?.source?.threadId || 'main') !== threadId
    || !Number.isSafeInteger(event.instructionRevision) || event.instructionRevision < 1
    || !Number.isSafeInteger(event.resultVersion) || event.resultVersion < 0
    || ticket.instructionRevision !== event.instructionRevision || ticket.resultVersion !== event.resultVersion
    || ticketStopped(ticket)) throw new Error('这组选项已过期，请重新说明你的决定');
  const requestId = `notification-option:${eventId}`;
  if (event.attentionId) {
    const attention = orchestration.attentions(ticketId).find(entry => entry.id === event.attentionId);
    if (!attention || (attention.resultVersion !== undefined && attention.resultVersion !== event.resultVersion)
      || !(attention.question.options || []).some(option => option.label === text)) throw new Error('这条问题已变化，请刷新后回答');
    // Persist the exact answer against its question. Re-dispatching the bare
    // word "continue" to the Router would lose the Ticket that was selected.
    return orchestration.answerDesktopAttention({ ticketId, attentionId: attention.id,
      instructionRevision: event.instructionRevision, requestId, answer: { selected: [text] } });
  }
  return engine.send({ threadId, text, requestId, replyContext: { eventId, ticketId,
    instructionRevision: event.instructionRevision, resultVersion: event.resultVersion, question: event.text || '' } });
}
