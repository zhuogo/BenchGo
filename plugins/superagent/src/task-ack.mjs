import { randomUUID } from 'node:crypto';
import { taskExecutionBlocked } from './task-lifecycle.mjs';

const validReply = text => typeof text === 'string' && text.trim().length > 0 && text.length <= 6000;

/** Old host-authored acknowledgements must not be replayed after switching to Router replies. */
export function isRouterTaskAck(event) {
  return event?.type === 'task.accepted' && event.origin === 'router'
    && typeof event.taskId === 'string' && !!event.taskId
    && typeof event.requestId === 'string' && !!event.requestId && validReply(event.text);
}

/** Called inside the same transaction that creates an explicitly requested Task. */
export function enqueueTaskAck({ db, task, trigger, text, now = Date.now() }) {
  if (text === undefined) return false;
  if (!validReply(text)) throw new Error('任务受理回复缺少有效正文');
  if (!task || task.status !== 'running' || taskExecutionBlocked(task) || task.resultVersion > 0 || !trigger || trigger.actor?.kind !== 'human') return false;
  const source = task.mandate?.source;
  if (!source?.channel || JSON.stringify(source) !== JSON.stringify(trigger.source)) return false;
  const payload = { type: 'task.accepted', origin: 'router', taskId: task.id, source,
    requestId: trigger.id, sourceEventId: source.eventId ?? null, text: text.trim() };
  const at = new Date(now).toISOString();
  const inserted = db.prepare("INSERT OR IGNORE INTO sa_outbox(id,unique_key,task_id,payload,state,attempts,next_at,created_at,updated_at) VALUES (?,?,?,?,'queued',0,?,?,?)")
    .run(randomUUID(), `task-accepted:${task.id}`, task.id, JSON.stringify(payload), now, at, at);
  return inserted.changes === 1;
}
