/** Normal session admission: no composer overwrite and no approval bypass. */
export async function sendInteractive(sessions, sessionId, text, request) {
  if (!sessionId || !sessions?.using) throw new Error('当前会话尚未连接，请稍后重试');
  return sessions.using(sessionId, { source: 'workspaceOperation' }, async reference => {
    const session = reference.binding.session;
    const snapshot = session.getSnapshot();
    if (snapshot.running || snapshot.openState === 'error') throw new Error('请等待当前回复结束或重新连接后再提交');
    if (!request.handle) request.handle = session.beginSubmission({ text, mode: 'queue', attachments: [] });
    const result = await session.prompt([{ type: 'text', text }], 'queue', undefined, request.handle.requestId);
    if (!result.ok) throw new Error(result.error?.message || '答复未被接收，请重试');
  });
}
