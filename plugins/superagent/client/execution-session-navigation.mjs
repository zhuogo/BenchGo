async function refreshExecutionCatalog(sessions, sessionIds, signal) {
  signal?.throwIfAborted();
  await sessions.refresh();
  signal?.throwIfAborted();
  // refresh() can join a pull started before the removal frame. Its mutation
  // log still applies that removal, so allow one fresh pull after it settles.
  const ids = sessions.list.getSnapshot().ids;
  if (sessionIds.some(id => !ids.includes(id))) await sessions.refresh();
}

let selectedExecution = null;
const listeners = new Set();
export const executionSessionNavigation = {
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  getSnapshot: () => selectedExecution,
  select(execution) { selectedExecution = execution; for (const listener of listeners) listener(); },
  close() { if (selectedExecution) { selectedExecution = null; for (const listener of listeners) listener(); } },
};

/** Open the same persisted execution Session in the official workspace. */
export async function openExecutionSession(ctx, execution) {
  if (!execution?.available || !execution.sessionId) throw new Error('无法定位执行会话');
  if (!ctx.uiWorkspace?.openSession) throw new Error('工作台会话入口不可用');
  try {
    await refreshExecutionCatalog(ctx.sessions, [execution.sessionId]);
    executionSessionNavigation.close();
    await ctx.uiWorkspace.openSession(execution.sessionId);
  }
  catch (cause) { throw new Error(`无法打开执行会话：${cause.message || '请稍后重试'}`, { cause }); }
}

/** Agent teardown removes the live catalog row, but its durable Session remains.
 * Reconcile through the official catalog, with one request and one merged batch
 * waiting at a time. Completed Tasks remain in the catalog. */
export function registerExecutionSessionDiscovery(ctx, loadSessions) {
  const controller = new AbortController(), removed = new Set();
  let pending;
  const refresh = () => {
    if (pending || controller.signal.aborted) return pending;
    pending = Promise.resolve().then(async () => {
      const batch = new Set(removed);
      removed.clear();
      const entries = await loadSessions(controller.signal);
      const sessionIds = entries.filter(entry => batch.has(entry.sessionId)).map(entry => entry.sessionId);
      if (!controller.signal.aborted && sessionIds.length) await refreshExecutionCatalog(ctx.sessions, sessionIds, controller.signal);
    }).catch(error => {
      if (!controller.signal.aborted) console.warn('[BenchGo] 执行会话目录刷新失败', error);
    }).finally(() => {
      pending = null;
      if (removed.size && !controller.signal.aborted) refresh();
    });
    return pending;
  };
  ctx.remote.$on('api-session/removed', sessionId => {
    if (controller.signal.aborted) return;
    removed.add(sessionId);
    return refresh();
  });
  ctx.effect(() => () => { controller.abort(); removed.clear(); });
}
