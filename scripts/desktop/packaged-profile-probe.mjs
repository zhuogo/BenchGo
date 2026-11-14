/** Read-only diagnostic plugin used only in an isolated installed-profile smoke. */
export const inject = ['connection', 'loader'];
export const packagedModules = Object.freeze({
  commander: 'benchgo',
  'commander-harness': 'benchgoHarnessWeb',
  'commander-superagent': 'assistant',
  'commander-voice': 'voice',
  'commander-link': 'benchgoLink',
});

const redact = value => String(value).replace(/([?&]token=)[^\s&]+/g, '$1[redacted]').replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]');

export async function inspectPackagedProfile(ctx) {
  const entries = [...ctx.loader.entries()];
  const modules = await Promise.all(Object.entries(packagedModules).map(async ([id, service]) => {
    const entry = entries.find(row => row.options.id === id);
    if (!entry) return { id, service, available: false, state: 'missing' };
    const fiber = entry.fiber;
    const row = { id, service, module: entry.options.name, available: Boolean(ctx.get(service)),
      state: entry.disabled ? 'disabled' : fiber?.state ?? 'import-failed',
      missing: fiber ? Object.keys(fiber.inject).filter(name => fiber.ctx.get(name) === undefined) : [] };
    if (!fiber && !entry.disabled) {
      // Importing a failed entry again reports its actual closure error without applying it.
      try { await entry.parent.tree.import(entry.options.name, () => []); }
      catch (error) { row.error = redact(error?.stack ?? error).slice(0, 2000); }
    }
    return row;
  }));
  return { modules };
}

export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/benchgo-packaging-probe', methods: ['POST'], requestBody: 'buffered',
    fetch: async () => Response.json(await inspectPackagedProfile(ctx), { headers: { 'cache-control': 'no-store' } }),
  }));
}
