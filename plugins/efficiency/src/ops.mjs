export const OPS_PRESETS = Object.freeze(['standard', 'ptc', 'cordis']);

/** Use the upstream public preset integration; never replace a CLI's own tools. */
export async function mountOps(ctx, _config = {}, { load = () => import('dsh-ops/integration') } = {}) {
  const module = await load();
  if (typeof module.integration !== 'function' || typeof module.diagnose !== 'function') throw new Error('执行工具集成接口不可用');
  const fibers = [];
  let disposed = false;
  try {
    for (const preset of OPS_PRESETS) {
      const plugin = module.integration({
        preset, profile: preset === 'ptc' ? 'ptc' : 'native',
        files: true, residentTools: true, discovery: true,
        shell: false, replaceOfficial: false, hidePwsh: false,
        promptPolicy: true, required: true, allowSystemShellFallback: false,
      });
      const fiber = ctx.plugin(plugin);
      fibers.push(fiber);
      await fiber;
    }
  } catch (error) {
    await Promise.allSettled(fibers.reverse().map(fiber => fiber.dispose()));
    throw error;
  }
  return {
    async diagnose(agent) {
      if (disposed) return { state: 'disabled', tools: [], issues: [] };
      return module.diagnose(ctx, agent);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const results = await Promise.allSettled(fibers.reverse().map(fiber => fiber.dispose()));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, '执行工具作用域清理失败');
    },
  };
}
