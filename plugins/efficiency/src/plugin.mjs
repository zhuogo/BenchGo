import { mountOps, OPS_PRESETS } from './ops.mjs';
import { mountCompaction } from './compaction.mjs';

// Built-in capabilities share the official tool and permission boundaries.
const features = Object.freeze({
  ops: Object.freeze({ enabled: true, shell: false }),
  compaction: Object.freeze({ enabled: true }),
});
const names = Object.keys(features);
const requirements = { ops: ['tools', 'agentPresets', 'agents', 'sessionProjections', 'systemPrompt', 'sandboxPolicy', 'subprocess'], compaction: ['tools'] };
const mounts = { ops: mountOps, compaction: mountCompaction };
const failureMessage = error => String(error?.message || error).replaceAll('dsh-ops', '执行工具').replaceAll('smart-compaction', '上下文管理');

/** Mounted by BenchGo's base entry; directory remains accepted for callers. */
export async function mountEfficiency(ctx, { adapters = mounts } = {}) {
  let disposed = false, cleanup;
  const handles = new Map(), states = new Map();
  const snapshot = () => ({
    scope: 'official-harness',
    features: Object.fromEntries(names.map(name => [name, {
      ...features[name], installed: false, available: false, state: 'waiting_services',
      ...(name === 'ops' ? { presets: [...OPS_PRESETS] } : { safePointRatio: false }),
      ...states.get(name),
    }])),
  });

  for (const name of names) {
    const state = { generation: 0, adapter: undefined, fiber: undefined };
    handles.set(name, state);
    state.fiber = ctx.inject(requirements[name], async child => {
      if (disposed) return;
      const generation = ++state.generation;
      let live = true, adapter, released = false;
      const release = async () => { if (adapter && !released) { released = true; await adapter.dispose(); } };
      states.set(name, { state: 'loading', installed: false, available: false });
      child.effect(() => async () => {
        live = false;
        await release();
        if (state.generation === generation) state.adapter = undefined;
        if (!disposed && state.generation === generation) states.set(name, { state: 'waiting_services', available: false, error: '官方宿主服务不可用' });
      });
      try {
        adapter = await adapters[name](child, features[name]);
        if (!live || disposed || state.generation !== generation) { await release(); return; }
        state.adapter = adapter;
        states.set(name, { state: 'ready', installed: true, available: true, verification: 'host' });
        child.emit?.('tools/change');
      } catch (error) {
        if (!live || disposed || state.generation !== generation) return;
        const message = failureMessage(error);
        states.set(name, { state: 'unavailable', installed: error.code !== 'ERR_MODULE_NOT_FOUND', available: false, error: message });
        child.logger?.warn?.('BenchGo ' + (name === 'ops' ? '执行工具' : '上下文管理') + ': ' + message);
      }
    });
  }

  const service = {
    snapshot,
    contextTools: () => handles.get('compaction')?.adapter?.contextTools?.() ?? [],
    async diagnose(agent) {
      const result = snapshot();
      for (const name of names) {
        const adapter = handles.get(name)?.adapter;
        if (!adapter) continue;
        try { result.features[name].session = await adapter.diagnose(agent); }
        catch (error) { result.features[name].session = { state: 'unavailable', error: failureMessage(error) }; }
      }
      return result;
    },
    async dispose() {
      if (cleanup) return cleanup;
      disposed = true;
      cleanup = (async () => {
        const results = await Promise.allSettled([...handles.values()].map(handle => handle.fiber.dispose()));
        handles.clear();
        for (const name of names) states.set(name, { state: 'disabled', available: false });
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'BenchGo 执行能力清理失败');
      })();
      return cleanup;
    },
  };
  ctx.provide('benchgoEfficiency', service);
  ctx.effect(() => () => service.dispose());
  return service;
}
