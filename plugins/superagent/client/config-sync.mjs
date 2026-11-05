// One config snapshot for sidebar, editors and polling. Request order breaks ties
// when IDENTITY.md changes the display name without changing config.revision.
export function createConfigSync() {
  let snapshot = null, sequence = 0, acceptedOrder = 0;
  const listeners = new Set();
  return {
    begin: () => ++sequence,
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    accept(config, order) {
      if (!config || !Number.isSafeInteger(config.revision)) return snapshot;
      if (snapshot && (config.revision < snapshot.revision || (config.revision === snapshot.revision && order < acceptedOrder))) return snapshot;
      acceptedOrder = order;
      if (JSON.stringify(snapshot) !== JSON.stringify(config)) {
        snapshot = config;
        for (const listener of listeners) listener();
      }
      return snapshot;
    },
  };
}

export const assistantConfigSync = createConfigSync();

// Retry one stale revision only when the fields being edited are unchanged.
// Other settings may advance the shared revision while an editor stays open.
export async function saveConfigPatch(api, base, patch) {
  try { return await api('config', { revision: base.revision, patch }); }
  catch (error) {
    if (error.status !== 409) throw error;
    const { config: latest } = await api('state');
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (Object.keys(patch).some(key => !same(latest[key], base[key]) && !same(latest[key], patch[key]))) {
      throw new Error('这项设置已在其他位置修改。你的修改已保留，请载入最新配置后核对。', { cause: error });
    }
    if (Object.keys(patch).every(key => same(latest[key], patch[key]))) return latest;
    return api('config', { revision: latest.revision, patch });
  }
}
