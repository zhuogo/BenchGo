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
import { mountRouterGoAccount } from './routergo-account.mjs';
import { mountSkills } from './skills.mjs';
import { mountEfficiency } from '../lib/modules/efficiency/src/plugin.mjs';
import { mountInteractivePrompt } from '../lib/modules/interactive/src/prompt.mjs';
import { mountWorkbench } from '../lib/modules/workbench/src/plugin.mjs';
import { createSettingsManagement } from './settings-management.mjs';
import { createOfficialSettingsAdapter } from './settings-official.mjs';
import { hostScope } from '../shared/host-scope.mjs';
import { createProfileIntegrityGuard } from '../shared/profile-integrity.mjs';
import { mountLiveReasoning } from '../shared/live-reasoning.mjs';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { join, resolve } from 'node:path';

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
  hostScope(ctx);
  const directory = config.dataDir ?? await prepareDefaultDataDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  ctx.provide('benchgo', { config, directory });
  ctx.inject(['agents', 'llm'], mountLiveReasoning);
  const management = createSettingsManagement({ directory });
  ctx.provide('benchgoSettings', management);
  ctx.effect(() => () => management.close());
  // Native Settings and profile configuration remain the source of truth.
  // Optional modules register their own existing stores through this registry.
  ctx.inject(['settings', 'configEditor', 'profileContext', 'loader'], child => {
    const unregister = management.register(createOfficialSettingsAdapter(child));
    child.effect(() => unregister);
  });
  ctx.inject(['tools', 'profileContext'], child => {
    const profile = child.profileContext;
    const paths = [profile.patchPath, join(profile.home, 'cordis.patch.yml')];
    const ready = createProfileIntegrityGuard({ paths, directory: join(profile.home, '.benchgo', 'profile-integrity'), withFileLock, writeFileAtomic });
    ready.catch(error => child.logger?.error?.('BenchGo profile integrity could not initialize', error));
    const blocked = execution => {
      const name = execution.name;
      const writeTool = ['write', 'edit', 'apply_patch', 'str_replace_editor', 'pwsh', 'bash'].includes(name);
      if (!writeTool) return false;
      const args = typeof execution.arguments === 'string'
        ? execution.arguments
        : JSON.stringify(execution.arguments ?? {});
      const normalizedArgs = args.replaceAll('\\', '/').toLowerCase();
      const candidates = [execution.arguments?.file_path, execution.arguments?.path, execution.arguments?.file];
      const targets = paths.map(path => path.replaceAll('\\', '/').toLowerCase());
      return candidates.some(path => typeof path === 'string' && paths.some(target => resolve(path).toLowerCase() === target.toLowerCase()))
        || targets.some(path => normalizedArgs.includes(path));
    };
    child.on('tools/pre-execute', async (execution, next) => {
      if (!blocked(execution)) return next();
      throw Object.assign(new Error('桌面配置文件由 assistant_settings 管理；请让总助手通过官方配置事务提交。'), { code: 'PROFILE_CONFIG_DIRECT_WRITE' });
    });
    child.on('tools/execute', async (execution, next) => {
      if (execution.name === 'assistant_settings') return next();
      const current = await ready;
      return current.run(() => next(), { source: `tool:${execution.name}` });
    });
    child.on('app-boot/config-reload', () => {
      void ready.then(current => current.check({ source: 'official-config-reload' }))
        .catch(error => child.logger?.error?.('BenchGo profile integrity check failed', error));
    });
    child.on('agent/pre-step', async (_payload, next) => {
      const current = await ready;
      try { await current.check({ source: 'agent-step', rejectRecovered: true }); }
      catch (error) { child.logger?.error?.('BenchGo rejected a step after profile recovery', error); throw error; }
      return next();
    });
  });
  // The optional observer runs in its own official profile; it needs no
  // commander/assistant instance and adds no installed plugin entry.
  if (config.watchdog !== undefined) ctx.inject(['agents', 'sessions', 'sessionPersistence', 'agentPresets', 'permissionPresets', 'agentDefaultModel', 'schedule'], async child => {
    const { mountWatchdog } = await import('../lib/modules/superagent/src/watchdog-plugin.mjs');
    await mountWatchdog(child, { directory, config: config.watchdog });
  });
  mountInteractivePrompt(ctx);
  ctx.inject(['connection', 'webServer'], async child => { await mountWorkbench(child, { directory }); });
  ctx.inject(['connection'], async child => { await mountEfficiency(child, { directory }); });
  ctx.inject(['connection'], child => {
    child.effect(() => child.connection.fetch.register({
      path: '/api/benchgo/modules', methods: ['GET'], requestBody: 'buffered',
      async fetch(request) {
        try { assertSameOrigin(request); return Response.json(moduleAvailability(child), { headers: { 'cache-control': 'no-store' } }); }
        catch (error) { return Response.json({ error: error.message }, { status: error.status ?? 400 }); }
      },
    }));
  });
  ctx.inject(['connection'], async child => {
    mountSkills(child);
    await mountPreviewAssets(child);
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
    mountRouterGoAccount(child, { directory });
    const tooling = await mountTooling(child, undefined, providers, { directory });
    child.provide('benchgoTooling', tooling);
  });
}
