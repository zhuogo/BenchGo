import { fileAddressFor, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path';
import { openRemoteExecutionFile } from './execution-session-navigation.mjs';

/** Reuse the official Sidebar file address, resolving the session cwd at click time. */
export function createReplyFileOpener(ctx, sessionId, { api, threadId } = {}) {
  if (!sessionId || typeof ctx?.sidebarRight?.openResource !== 'function' || typeof ctx?.sessions?.binding !== 'function') return undefined;
  return async (path, options) => {
    const isCurrent = () => {
      const mounted = ctx.sidebarRight.mounted;
      return typeof mounted?.getSnapshot !== 'function' || mounted.getSnapshot() === sessionId;
    };
    const assertCurrent = () => {
      if (!isCurrent()) throw new Error('当前聊天的文件工作区尚未就绪，请回到该聊天后重试。');
    };
    assertCurrent();
    if (options?.requestId !== undefined) {
      if (typeof api !== 'function' || !threadId || typeof options.requestId !== 'string' || !options.requestId) throw new Error('文件所属回复尚未核实，请回到原聊天后重试。');
      const source = await api('replyFileSource', { threadId, sessionId, requestId: options.requestId });
      assertCurrent();
      if (!source || typeof source.remote !== 'boolean') throw new Error('文件所属回复无法核实，请刷新原聊天后重试。');
      if (source.remote) {
        if (source.available !== true || ![source.deviceId, source.hostId, source.authorizationId, source.sessionId, source.ownerHostId, source.taskId, source.executionId].every(value => typeof value === 'string' && value)) throw new Error(source.reason || '文件所属远端执行暂不可用，请返回原任务核验。');
        await openRemoteExecutionFile(source, path, { line: options.line, isCurrent });
        return;
      }
    }
    const binding = ctx.sessions.binding(sessionId);
    if (!binding) throw new Error('当前会话尚未连接，请刷新后重试。');
    const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd;
    const current = binding.session.projections.faceOf('workingDirectory').getSnapshot();
    const address = fileAddressFor(sessionId, cwd, resolveWorkspacePath(current ?? undefined, path));
    if (options?.line === undefined) ctx.sidebarRight.openResource(address);
    else ctx.sidebarRight.openResource(address, { params: { line: options.line } });
  };
}
