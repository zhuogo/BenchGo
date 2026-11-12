import { readJsonResponse } from './http-response.mjs';

/** Short-lived successful reads are shared; invalidated in-flight results never win. */
export function createModelCatalogLoader(read, { ttl = 30_000, now = Date.now, scope = () => '' } = {}) {
  let value = null, expires = 0, valueScope, pending, pendingScope, generation = 0;
  const listeners = new Set();
  const peek = () => valueScope === scope() && now() < expires ? value : null;
  const load = () => {
    const cached = peek();
    if (cached !== null) return Promise.resolve(cached);
    const target = scope();
    if (pending && pendingScope === target) return pending;
    const revision = generation;
    const current = () => generation === revision && scope() === target && pending === operation;
    const operation = Promise.resolve().then(() => read(target)).then(next => {
      if (!current()) return load();
      value = next; valueScope = target; expires = now() + ttl;
      return next;
    }, error => {
      if (!current()) return load();
      throw error;
    }).finally(() => { if (pending === operation) pending = undefined; });
    pending = operation; pendingScope = target;
    return operation;
  };
  return {
    load, peek,
    getSnapshot: () => generation,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    invalidate() {
      generation++; value = null; expires = 0; pending = undefined;
      for (const listener of listeners) listener();
    },
  };
}

function catalog(path, action) {
  return createModelCatalogLoader(async url => {
    const response = await fetch(url, { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(18_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
    const value = await readJsonResponse(response, url);
    if (value?.error) throw Error(typeof value.error === 'string' ? value.error : value.error.message || '模型目录加载失败');
    const fields = action === 'pickerCatalog' ? ['tools', 'providers', 'routes'] : ['providers', 'models'];
    if (!fields.every(field => Array.isArray(value?.[field]))) throw Error('模型目录响应格式不完整，请重试');
    return value;
  }, { scope: () => new URL(path, document.baseURI).href });
}

export const pickerCatalog = catalog('api/commander/tooling', 'pickerCatalog');
export const assistantModelCatalog = catalog('api/commander/assistant', 'catalog');
export function invalidateModelCatalogs() { pickerCatalog.invalidate(); assistantModelCatalog.invalidate(); }

/** Mirror the official directory's input lifecycle without replacing its selection authority. */
export function mountModelCatalogs(ctx) {
  ctx.effect(() => { invalidateModelCatalogs(); return invalidateModelCatalogs; });
  ctx.on('connection/reset', invalidateModelCatalogs);
  for (const event of ['llm/adapters-updated', 'llm/models-updated', 'settings/document-updated', 'credentials/record-updated', 'credentials/reference-updated']) ctx.remote.$on(event, invalidateModelCatalogs);
}
