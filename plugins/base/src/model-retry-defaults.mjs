const namespaces = new Set(['llm-pi-ai', 'llm-deepseek', 'llm-deepseek-account']);

function retryOperation(path, user, base) {
  if (base?.mode === 'always') {
    return user?.mode === 'normal' && Object.keys(user).length === 1
      ? undefined : { op: 'set', path, value: { mode: 'normal' } };
  }
  return user === undefined ? undefined : { op: 'unset', path };
}

function retryOperations({ ns, user, base }) {
  if (ns !== 'llm-pi-ai') {
    return [retryOperation(['retryPolicy'], user?.retryPolicy, base?.retryPolicy)].filter(Boolean);
  }
  const providers = new Set([...Object.keys(user?.providers ?? {}), ...Object.keys(base?.providers ?? {})]);
  return [...providers].map(id => retryOperation(['providers', id, 'retryPolicy'],
    user?.providers?.[id]?.retryPolicy, base?.providers?.[id]?.retryPolicy)).filter(Boolean);
}

/** Drop per-provider overrides written by the former BenchGo retry editor. */
export function mountModelRetryDefaults(ctx) {
  let active = true;
  const pending = new Set();
  const reconcile = ns => {
    if (!active || !namespaces.has(ns) || pending.has(ns)) return;
    pending.add(ns);
    queueMicrotask(async () => {
      try {
        for (let attempt = 0; active && attempt < 2; attempt++) {
          const view = ctx.settings.describe().find(view => view.ns === ns);
          const operations = view ? retryOperations(view) : [];
          if (!operations.length) return;
          try {
            await ctx.settings.mutate(ns, operations, view.revision);
            return;
          } catch (error) {
            if (error?.code !== 'SETTINGS_CONFLICT' || attempt > 0) throw error;
          }
        }
      } catch (error) {
        ctx.logger?.warn?.('无法恢复模型的默认重试策略', error);
      } finally {
        pending.delete(ns);
      }
    });
  };
  ctx.on('settings/document-updated', reconcile);
  for (const ns of namespaces) reconcile(ns);
  return () => { active = false; };
}
