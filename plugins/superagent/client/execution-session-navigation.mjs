/** Open the original Session without changing its membership or archival choice. */
export async function openExecutionSession(ctx, execution) {
  if (!execution?.available || !execution.sessionId) throw new Error('无法定位执行会话');
  if (!ctx.uiWorkspace?.openSession) throw new Error('官方会话入口不可用');
  try { ctx.uiWorkspace.openSession(execution.sessionId); }
  catch (cause) { throw new Error(`无法打开执行会话：${cause.message || '请稍后重试'}`, { cause }); }
}
