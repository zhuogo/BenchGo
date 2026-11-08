/** Restoring a closed Session's display does not reopen its Ticket or Worker. */
export async function openExecutionSession(ctx, execution) {
  if (!execution?.available || !execution.sessionId) throw new Error('无法定位执行会话');
  if (!ctx.uiWorkspace?.openSession) throw new Error('官方会话入口不可用');
  if (execution.closed) {
    if (!ctx.uiWorkspace.unarchiveSession) throw new Error('官方执行记录恢复入口不可用');
    try { await ctx.uiWorkspace.unarchiveSession(execution.sessionId); }
    catch (cause) { throw new Error(`无法恢复执行记录：${cause.message || '请稍后重试'}`, { cause }); }
  }
  try { ctx.uiWorkspace.openSession(execution.sessionId); }
  catch (cause) { throw new Error(`无法打开执行会话：${cause.message || '请稍后重试'}`, { cause }); }
}
