import { readJsonResponse } from './http-response.mjs';
import { startSidebarPolling } from './sidebar-refresh.mjs';

const names = ['base', 'harness', 'superagent', 'voice', 'link'];
const unavailable = () => Object.fromEntries(names.map(name => [name, false]));
export function createModuleSource() {
  let snapshot = unavailable();
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    update(next) {
      if (names.every(name => snapshot[name] === next[name])) return;
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}
export const moduleSource = createModuleSource();

/** One availability feed owns optional client fibers and their existing effects. */
export function startModuleLifecycle(ctx, entries, { source = moduleSource, read = async signal => {
  const url = new URL('api/benchgo/modules', document.baseURI);
  return readJsonResponse(await fetch(url, { credentials: 'same-origin', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }), url);
}, poll = startSidebarPolling, onError = error => console.warn('[BenchGo] 模块状态同步失败', error) } = {}) {
  const fibers = new Map();
  let disposed = false;
  const disable = async () => {
    source.update(unavailable());
    const active = [...fibers.values()];
    fibers.clear();
    await Promise.all(active.map(fiber => fiber.dispose()));
  };
  const refresh = async signal => {
    let result;
    try { result = await read(signal); }
    catch (error) {
      // A failed probe cannot establish that a module stopped. Keep the last
      // confirmed UI during transport/host hiccups; an absent owner endpoint
      // or an explicit unavailable response still releases the real fibers.
      if (!disposed && !signal?.aborted && [401, 403, 404, 410].includes(error.status)) await disable();
      throw error;
    }
    if (disposed || signal?.aborted) return;
    const next = Object.fromEntries(names.map(name => [name, result.modules?.base?.available === true && result.modules?.[name]?.available === true]));
    // Hide entries immediately when the backing module stops, then release its resources.
    source.update(Object.fromEntries(names.map(name => [name, source.getSnapshot()[name] && next[name]])));
    for (const [name, fiber] of fibers) {
      if (!next[name]) { fibers.delete(name); await fiber.dispose(); }
    }
    for (const [name, apply] of Object.entries(entries)) {
      if (disposed || signal?.aborted) return;
      if (!next[name] || fibers.has(name)) continue;
      const fiber = ctx.plugin({ apply });
      fibers.set(name, fiber);
      try { await fiber.await(); }
      catch (error) { fibers.delete(name); await fiber.dispose(); next[name] = false; onError(error); }
    }
    if (!disposed && !signal?.aborted) source.update(next);
  };
  const stop = poll({ refresh, isActive: () => true, onError });
  return async () => {
    disposed = true;
    stop();
    await disable();
  };
}
