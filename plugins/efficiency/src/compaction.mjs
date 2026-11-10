export const COMPACTION_VERSION = '0.3.15';
export const COMPACTION_TOOLS = Object.freeze(['compact_now', 'context_status']);

const service = (ctx, name) => { try { return ctx.get(name); } catch { return undefined; } };

/** One host registration delegates to the session's existing compaction service. */
export async function mountCompaction(ctx, _config = {}, { load = () => import('smart-compaction') } = {}) {
  const tools = service(ctx, 'tools');
  if (!tools?.get || !tools?.register) throw new Error('官方工具服务尚未就绪');
  const existing = COMPACTION_TOOLS.filter(name => tools.get(name));
  // Do not assume two matching names came from the same implementation.
  if (existing.length) throw new Error(`上下文工具名称冲突：${existing.join(', ')}`);
  const module = await load();
  if (typeof module.apply !== 'function') throw new Error('smart-compaction 入口不可用');
  const fiber = ctx.plugin(module, { safePointRatio: false });
  try { await fiber; } catch (error) { await fiber.dispose(); throw error; }
  const definitions = COMPACTION_TOOLS.map(name => ({ name, definition: tools.get(name) }));
  if (definitions.some(row => !row.definition)) { await fiber.dispose(); throw new Error('上下文工具注册未完成'); }
  let disposed = false;
  return {
    contextTools: () => disposed ? [] : definitions.filter(row => tools.get(row.name) === row.definition),
    diagnose(agent) {
      const compaction = service(ctx, 'compaction') ?? service(ctx, 'agentPresets')?.serviceFor?.(agent, 'compaction');
      return {
        state: disposed ? 'disabled' : !compaction?.compactRegion ? 'unavailable' : 'ready',
        compact: !disposed && typeof compaction?.compactRegion === 'function',
        usage: !disposed && typeof service(ctx, 'sessionProjections')?.stateOf === 'function',
        safePointRatio: false,
        ...(!compaction?.compactRegion ? { error: '当前会话未提供上下文压缩服务' } : {}),
      };
    },
    async dispose() { if (!disposed) { disposed = true; await fiber.dispose(); } },
  };
}
