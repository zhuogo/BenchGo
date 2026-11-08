async function refreshExecutionCatalog(sessions, sessionIds, signal) {
  signal?.throwIfAborted();
  await sessions.refresh();
  signal?.throwIfAborted();
  // refresh() can join a pull started before the removal frame. Its mutation
  // log still applies that removal, so allow one fresh pull after it settles.
  const ids = sessions.list.getSnapshot().ids;
  if (sessionIds.some(id => !ids.includes(id))) await sessions.refresh();
}

/** Restoring a closed Session's display does not reopen its Ticket or Worker. */
export async function openExecutionSession(ctx, execution) {
  if (!execution?.available || !execution.sessionId) throw new Error('无法定位执行会话');
  if (!ctx.uiWorkspace?.openSession) throw new Error('官方会话入口不可用');
  if (execution.closed) {
    if (!ctx.uiWorkspace.unarchiveSession) throw new Error('官方执行记录恢复入口不可用');
    try { await ctx.uiWorkspace.unarchiveSession(execution.sessionId); }
    catch (cause) { throw new Error(`无法恢复执行记录：${cause.message || '请稍后重试'}`, { cause }); }
  }
  try {
    await refreshExecutionCatalog(ctx.sessions, [execution.sessionId]);
    ctx.uiWorkspace.openSession(execution.sessionId);
  }
  catch (cause) { throw new Error(`无法打开执行会话：${cause.message || '请稍后重试'}`, { cause }); }
}

/** Agent teardown removes the live catalog row, but its durable Session remains.
 * Reconcile through the official catalog, with one request and one merged batch
 * waiting at a time. Closed Tickets stay under the official archive policy. */
export function registerExecutionSessionDiscovery(ctx, loadSessions) {
  const controller = new AbortController(), removed = new Set();
  let pending;
  const refresh = () => {
    if (pending || controller.signal.aborted) return pending;
    pending = Promise.resolve().then(async () => {
      const batch = new Set(removed);
      removed.clear();
      const entries = await loadSessions(controller.signal);
      const sessionIds = entries.filter(entry => !entry.closed && batch.has(entry.sessionId)).map(entry => entry.sessionId);
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
