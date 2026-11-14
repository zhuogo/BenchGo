import { createHash } from 'node:crypto';
import { isScheduledTrigger, scheduleTargetSession } from './schedule-bridge.mjs';

const phases = new Set(['created', 'triggered', 'completed', 'failed']);
const labels = { created: '定时任务已创建', triggered: '定时任务已触发', completed: '定时任务已完成', failed: '定时任务执行失败' };
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A system fact card, never a Router-authored report or an executable instruction. */
export function scheduleLifecyclePublication(event) {
  const schedule = event?.schedule;
  if (event?.type !== 'schedule.lifecycle' || event.origin !== 'system' || !phases.has(schedule?.phase)
    || typeof schedule.id !== 'string' || !schedule.id || typeof schedule.title !== 'string' || !schedule.title.trim()
    || schedule.title.length > 500 || typeof schedule.sourceSessionId !== 'string' || !schedule.sourceSessionId
    || !validTime(schedule.at) || (schedule.phase !== 'created' && !validTime(schedule.occurrenceAt))
    || (['completed', 'failed'].includes(schedule.phase) && (typeof schedule.taskId !== 'string' || !schedule.taskId))) return null;
  const identity = {};
  for (const key of ['id', 'eventId', 'taskId', 'createdAt', 'seq', 'readAt']) {
    if (typeof event[key] === 'string' || typeof event[key] === 'number' || event[key] === null) identity[key] = event[key];
  }
  const fact = { id: schedule.id, title: schedule.title, phase: schedule.phase, sourceSessionId: schedule.sourceSessionId, at: schedule.at,
    ...(schedule.occurrenceAt ? { occurrenceAt: schedule.occurrenceAt } : {}), ...(schedule.taskId ? { taskId: schedule.taskId } : {}) };
  return { ...identity, type: 'schedule.lifecycle', origin: 'system', threadId: 'main', threadRefs: ['main'],
    title: schedule.title, text: `${labels[schedule.phase]}：${schedule.title}`, schedule: fact,
    ...(schedule.taskId ? { taskId: schedule.taskId } : {}) };
}

/** Reads official facts and projects them into the existing durable notification ledger. */
export function createScheduleLifecycle({ ctx, store, database }) {
  let syncing;
  const publish = schedule => {
    const key = `schedule-lifecycle:${digest([schedule.sourceSessionId, schedule.id, schedule.phase, schedule.occurrenceAt || '', schedule.taskId || ''])}`;
    return database.notify({ id: schedule.id, threadId: 'main' }, 'schedule.lifecycle', { origin: 'system', schedule }, key);
  };
  const title = entry => String(entry.title?.trim() || entry.id).slice(0, 500);
  const ownedSessions = async () => {
    const state = await store.getState();
    return new Set([state.mainSessionId, ...(state.threads || []).filter(row => !row.archived).map(row => row.sessionId)].filter(Boolean));
  };
  const recordedOccurrence = (sessionId, scheduleId, occurrenceAt) => {
    if (!sessionId || !scheduleId || !validTime(occurrenceAt)) return false;
    const trigger = store.orchestration.getTrigger(`schedule:${digest([sessionId, scheduleId, occurrenceAt])}`);
    return isScheduledTrigger(trigger) && trigger.source.sessionId === sessionId
      && trigger.source.scheduleId === scheduleId && trigger.source.occurrenceAt === occurrenceAt;
  };
  const projectTask = (task, owned) => {
    const source = task?.mandate?.source;
    if (task?.mandate?.admission !== 'desktop-schedule' || source?.channel !== 'desktop'
      || source.origin !== 'harness-schedule' || !owned.has(source.sessionId)
      || !recordedOccurrence(source.sessionId, source.scheduleId, source.occurrenceAt)) return;
    const fact = { id: source.scheduleId, title: title({ id: source.scheduleId, title: task.title }),
      sourceSessionId: source.sessionId, occurrenceAt: source.occurrenceAt };
    publish({ ...fact, phase: 'triggered', at: source.occurrenceAt });
    if (task.status === 'completed' && validTime(task.updatedAt)) {
      return publish({ ...fact, phase: task.status, at: task.updatedAt, taskId: task.id });
    }
    const result = store.orchestration.results(task.id).findLast(row => row.version === task.resultVersion && row.instructionRevision === task.instructionRevision);
    if (task.status === 'waiting' && result?.outcome === 'failed' && validTime(result.committedAt)) {
      return publish({ ...fact, phase: 'failed', at: result.committedAt, taskId: task.id });
    }
  };
  return {
    async occurrence({ entry, occurrence }) {
      if (!(await ownedSessions()).has(entry.sessionId)
        || !recordedOccurrence(entry.sessionId, entry.id, occurrence.occurrence_at)) return;
      if (validTime(entry.createdAt)) publish({ id: entry.id, title: title(entry), sourceSessionId: entry.sessionId,
        phase: 'created', at: entry.createdAt });
      return publish({ id: entry.id, title: title(entry), sourceSessionId: entry.sessionId, phase: 'triggered',
        at: occurrence.occurrence_at, occurrenceAt: occurrence.occurrence_at });
    },
    async task(task) {
      return projectTask(store.orchestration.getTask(task?.id), await ownedSessions());
    },
    sync() {
      return syncing ||= (async () => {
        const host = ctx.get?.('schedule');
        const owned = await ownedSessions();
        if (!owned.size) return;
        for (const entry of await host?.catalog?.() || []) {
          const sessionId = scheduleTargetSession(entry);
          if (!owned.has(sessionId)) continue;
          if (validTime(entry.createdAt)) publish({ id: entry.id, title: title(entry),
            sourceSessionId: sessionId, phase: 'created', at: entry.createdAt });
          // Read only the Host's latest receipt, matching its recovery bound.
          // Existing admission is mandatory; old deliveries never create Triggers here.
          const receipt = entry.lastDelivery && (await host.history?.({ id: entry.id, limit: 1 }))?.records?.[0];
          if (receipt && (receipt.targetSessionId === sessionId || (!entry.target && receipt.targetSessionId === undefined))
            && recordedOccurrence(sessionId, entry.id, receipt.scheduledAt)) publish({ id: entry.id, title: title(entry),
              sourceSessionId: sessionId, phase: 'triggered', at: receipt.scheduledAt, occurrenceAt: receipt.scheduledAt });
        }
        // Rebuild admitted occurrence and terminal cards even after the Host
        // schedule was removed or no new notification delivery is pending.
        for (let offset = 0;; offset += 1000) {
          const tasks = store.orchestration.listTasks({ ownerSessionIds: [...owned], offset, limit: 1000 });
          for (const task of tasks) projectTask(task, owned);
          if (tasks.length < 1000) break;
        }
      })().finally(() => { syncing = undefined; });
    },
  };
}
