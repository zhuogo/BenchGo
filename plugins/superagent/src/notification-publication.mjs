import { validateDelivery } from './result-delivery.mjs';
import { isRouterTaskAck } from './task-ack.mjs';
import { scheduleLifecyclePublication } from './schedule-lifecycle.mjs';

/** Only a Router-authored result is publishable in conversation history. */
export function notificationPublication(event) {
  if (event?.type === 'schedule.lifecycle') return scheduleLifecyclePublication(event);
  if (!event || !['task.result', 'task.attention', 'task.accepted'].includes(event.type)) return null;
  if (event.type === 'task.accepted' && !isRouterTaskAck(event)) return null;
  let publication;
  if (event.type === 'task.result') {
    try { publication = validateDelivery(event.publication); } catch { return null; }
    if (publication.origin !== 'router') return null;
  } else if (typeof event.text !== 'string' || !event.text.trim()) return null;
  const value = {};
  for (const key of ['id', 'eventId', 'taskId', 'requestId', 'sourceEventId', 'taskStateEventKey', 'threadId', 'createdAt', 'title', 'status', 'attentionId', 'instructionRevision', 'resultVersion', 'seq', 'readAt']) {
    if (typeof event[key] === 'string' || typeof event[key] === 'number' || event[key] === null) value[key] = event[key];
  }
  return { ...value, type: event.type, threadRefs: [value.threadId || 'main'],
    ...(event.type === 'task.accepted' ? { origin: 'router' } : {}),
    ...(publication?.origin === 'router' ? { origin: 'router' } : {}),
    text: publication?.text || event.text,
    ...(publication ? { publication, ...(publication.options ? { options: publication.options } : {}) } : {}),
  };
}
