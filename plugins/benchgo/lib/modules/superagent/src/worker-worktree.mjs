/** Reuse a host service, otherwise mount the official service in this worker only. */
export async function workerWorktrees(scope) {
  const inherited = scope.get('worktrees');
  if (inherited) return inherited;
  for (const name of ['workingDirectory', 'fs', 'subprocess', 'sandbox', 'sandboxPolicy']) {
    if (!scope.get(name)) throw new Error(`Official worktree prerequisite unavailable: ${name}`);
  }
  const { default: WorktreeService } = await import('@deepseek-ai/dsh-experimental-worktree');
  const local = scope.isolate('worktrees');
  await local.plugin(WorktreeService);
  const service = local.get('worktrees');
  if (!service) throw new Error('Official worktree service unavailable; project execution was not submitted');
  return service;
}
