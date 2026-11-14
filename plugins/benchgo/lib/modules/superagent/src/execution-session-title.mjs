import { basename } from 'node:path';
import { normalizeTaskTitle } from './task-title.mjs';
import { taskPresentationKey } from './task-archive.mjs';

/** Task labels own only the exact title revisions written by this service. */
export function createExecutionSessionTitles({ ctx, database, metadata }) {
  const titles = ctx.get('sessionTitle'), sessions = ctx.get('sessions');
  const persistence = ctx.get('sessionPersistence'), cache = ctx.get('sessionProjectionCache');
  const pending = new Map();
  let disposed = false;
  const warn = error => ctx.logger?.warn?.(`SuperAgent 执行会话名称同步失败：${error.code || error.name}`);
  const markerKey = id => `execution-session-title:${id}`;

  function desired(sessionId, header, current) {
    if (disposed || header.id !== sessionId || header.origin === 'subagent') return null;
    const binding = database.getExecutionBinding(sessionId);
    if (!binding) return null;
    const task = database.getTask(binding.taskId);
    const run = database.runs(binding.assignmentId).find(row => row.id === binding.runId && row.sessionId === sessionId);
    if (!task || !run) return null;
    const marker = metadata.meta(markerKey(sessionId));
    const managed = marker?.taskId === task.id && current?.source.kind === 'user'
      && current.eventSeq === marker.eventSeq && current.updatedAt === marker.updatedAt && current.title === marker.title;
    // A real user rename always wins, even when its text equals our last label.
    const legacy = current && ['fallback', 'provider'].includes(current.source.kind)
      && header.cwd === run.directory && basename(run.directory) === encodeURIComponent(binding.assignmentId)
      && current.title === basename(run.directory);
    if (current && !managed && !legacy) return null;
    const presentation = metadata.meta(taskPresentationKey(task.id));
    return { taskId: task.id, title: normalizeTaskTitle(presentation?.title ?? task.title, task.target) };
  }

  function remember(sessionId, label, snapshot) {
    metadata.setMeta(markerKey(sessionId), { taskId: label.taskId, title: snapshot.title,
      eventSeq: snapshot.eventSeq, updatedAt: snapshot.updatedAt });
  }

  async function syncLive(session) {
    const current = titles.get(session), label = desired(session.id, session.header, current);
    if (!label) return;
    if (current?.title !== label.title) remember(session.id, label, titles.rename(session, label.title));
    // Retry durability after an earlier flush failure without another rename.
    if (!await sessions.flush(session)) throw new Error('执行会话名称尚未持久化');
  }

  async function syncNow(sessionId) {
    if (disposed) return;
    let live = sessions.get(sessionId);
    if (live) return syncLive(live);
    if (!await persistence.stat(sessionId) || disposed) return;
    live = sessions.get(sessionId);
    if (live) return syncLive(live);
    // Retain official single-writer ownership across read/compare/write. Never
    // resume an Agent or publish a temporary live Session for a label change.
    const handle = await persistence.open(sessionId, 'write');
    try {
      const { events } = await handle.read();
      const last = events.findLast(event => event.type === 'session/title');
      const current = last && { ...last.data, eventSeq: last.seq, updatedAt: last.time };
      const label = desired(sessionId, handle.header, current);
      if (!label) return;
      let updated = events;
      if (current?.title !== label.title) {
        const entry = { seq: events.length, time: Date.now(), type: 'session/title',
          data: { title: label.title, messageSeqs: [], source: { kind: 'user' } } };
        await handle.append([entry]);
        remember(sessionId, label, { ...entry.data, eventSeq: entry.seq, updatedAt: entry.time });
        updated = [...events, entry];
      }
      // Keep ownership of an accepted append even if its flush fails, so a
      // later retry can finish durability instead of mistaking it for a user edit.
      await handle.flush();
      if (disposed) return;
      // Cold list rows read cached projections. Await their checkpoint without
      // announcing the replay or disturbing the execution lifecycle.
      const replay = sessions.prepare(sessionId, { seed: updated, meta: handle.header,
        inheritedEventCount: handle.inheritedEventCount, eventState: 'shared-frozen' });
      await cache.write(replay);
    } finally { await handle.close(); }
  }

  function syncSession(sessionId) {
    if (disposed) return Promise.resolve();
    const previous = pending.get(sessionId);
    const operation = (previous ? previous.then(() => syncNow(sessionId)) : syncNow(sessionId))
      .catch(warn).finally(() => { if (pending.get(sessionId) === operation) pending.delete(sessionId); });
    pending.set(sessionId, operation);
    return operation;
  }

  const stop = ctx.on('agent/created', ({ agent }) => {
    if (database.getExecutionBinding(agent.id)) return syncSession(agent.id);
  }, { global: true });
  const ready = Promise.resolve().then(async () => {
    for (const { sessionId } of database.executionBindings()) {
      if (disposed) break;
      await syncSession(sessionId);
    }
  });
  ready.catch(warn);
  return { ready,
    async syncTask(taskId) {
      if (disposed) return;
      try {
        const sessionIds = new Set(database.assignments(taskId).flatMap(assignment => database.runs(assignment.id).map(run => run.sessionId)).filter(Boolean));
        for (const sessionId of sessionIds) await syncSession(sessionId);
      } catch (error) { warn(error); }
    },
    async dispose() {
      disposed = true;
      stop();
      await Promise.allSettled([ready, ...pending.values()]);
    },
  };
}
