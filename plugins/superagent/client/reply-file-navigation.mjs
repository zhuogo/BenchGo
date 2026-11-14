import { fileAddressFor, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path';

/** Reuse the official Sidebar file address, resolving the session cwd at click time. */
export function createReplyFileOpener(ctx, sessionId) {
  if (!sessionId || typeof ctx?.sidebarRight?.openResource !== 'function' || typeof ctx?.sessions?.binding !== 'function') return undefined;
  return async (path, options) => {
    const binding = ctx.sessions.binding(sessionId);
    if (!binding) throw new Error('当前会话尚未连接，请刷新后重试。');
    const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd;
    const current = binding.session.projections.faceOf('workingDirectory').getSnapshot();
    const address = fileAddressFor(sessionId, cwd, resolveWorkspacePath(current ?? undefined, path));
    if (options?.line === undefined) ctx.sidebarRight.openResource(address);
    else ctx.sidebarRight.openResource(address, { params: { line: options.line } });
  };
}
