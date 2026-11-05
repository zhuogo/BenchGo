import { mkdir } from 'node:fs/promises';
import { prepareDefaultDataDirectory } from './data-directory.mjs';
import { createModelProviders } from './model-providers.mjs';
import { mountTooling } from './tooling.mjs';
import { mountUsage } from './usage.mjs';
import { mountUpdates } from './updates.mjs';
import { mountWeb } from './web.mjs';
import { assertSameOrigin } from '../shared/http.mjs';
import { mountPreviewAssets } from './preview-assets.mjs';
import { mountVault } from './vault.mjs';
import { mountSkills } from './skills.mjs';

export const name = 'benchgo';

export function moduleAvailability(ctx) {
  const available = service => ({ available: !!ctx.get(service) });
  return { modules: {
    base: available('benchgo'), harness: available('benchgoHarnessWeb'),
    superagent: available('assistant'), voice: available('voice'), link: available('benchgoLink'),
  } };
}

/** Shared configuration and owner APIs survive optional module disposal. */
export async function apply(ctx, config = {}) {
  const directory = config.dataDir ?? await prepareDefaultDataDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  ctx.provide('benchgo', { config, directory });
  ctx.inject(['connection'], async child => {
    mountSkills(child);
    await mountPreviewAssets(child);
    child.effect(() => child.connection.fetch.register({
      path: '/api/benchgo/modules', methods: ['GET'], requestBody: 'buffered',
      async fetch(request) {
        try { assertSameOrigin(request); return Response.json(moduleAvailability(child), { headers: { 'cache-control': 'no-store' } }); }
        catch (error) { return Response.json({ error: error.message }, { status: error.status ?? 400 }); }
      },
    }));
    await mountUsage(child, undefined, { ...config.usage, directory });
    await mountUpdates(child, undefined, { directory });
  });
  ctx.inject(['connection', 'workspaceRegistry'], child => mountWeb(child, { directory }));
  // Keep the owner route present even while optional credential composition is
  // still settling. The first request resolves the already-registered service;
  // normal Harness startup provides credentials before the UI calls it.
  ctx.inject(['connection'], child => {
    let mounted;
    child.inject(['credentials'], credentialsCtx => {
      mounted = mountVault(credentialsCtx, { registerRoute: false });
      return () => { mounted = undefined; };
    });
    child.effect(() => child.connection.fetch.register({
      path: '/api/benchgo/vault', methods: ['POST'], requestBody: 'buffered',
      fetch: async request => {
        if (!mounted) return Response.json({ error: '保险库服务尚未就绪，请稍后重试', code: 'VAULT_UNAVAILABLE' }, { status: 503, headers: { 'cache-control': 'no-store' } });
        return mounted.fetch(request);
      },
    }));
  });
  ctx.inject(['connection', 'settings', 'credentials', 'llm'], async child => {
    const providers = createModelProviders(child);
    const tooling = await mountTooling(child, undefined, providers, { directory });
    child.provide('benchgoTooling', tooling);
  });
}
