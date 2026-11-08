import { validateDelivery } from './result-delivery.mjs';
import { isRouterTicketAck } from './ticket-ack.mjs';
import { scheduleLifecyclePublication } from './schedule-lifecycle.mjs';

/** The transport and history share one allowlist for Worker text and system notices. */
export function notificationPublication(event) {
  if (event?.type === 'schedule.lifecycle') return scheduleLifecyclePublication(event);
  if (!event || !['ticket.result', 'ticket.attention', 'ticket.accepted'].includes(event.type)) return null;
  if (event.type === 'ticket.accepted' && !isRouterTicketAck(event)) return null;
  let publication;
  if (event.type === 'ticket.result') {
    try { publication = validateDelivery(event.publication); } catch { return null; }
  } else if (typeof event.text !== 'string' || !event.text.trim()) return null;
  const value = {};
  for (const key of ['id', 'eventId', 'taskId', 'ticketId', 'requestId', 'sourceEventId', 'ticketStateEventKey', 'threadId', 'createdAt', 'title', 'status', 'attentionId', 'instructionRevision', 'resultVersion', 'seq', 'readAt']) {
    if (typeof event[key] === 'string' || typeof event[key] === 'number' || event[key] === null) value[key] = event[key];
  }
  return { ...value, type: event.type, threadRefs: [value.threadId || 'main'],
    ...(event.type === 'ticket.accepted' ? { origin: 'router' } : {}),
    ...(publication?.origin === 'system' ? { origin: 'system', systemState: publication.systemState } : {}),
    text: publication?.text || event.text,
    ...(publication ? { publication, ...(publication.options ? { options: publication.options } : {}) } : {}),
  };
}
