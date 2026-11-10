import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
export const loadRolePackage = (directory, name) => import(pathToFileURL(createRequire(new URL(`../../../deepseek-harness/packages/${directory}/package.json`, import.meta.url)).resolve(name)).href);

/** Real upstream services; this fixture intentionally cannot execute an OS shell. */
export async function installRoleHost(ctx, { permissionPresetConfig } = {}) {
  if (!ctx.get('agentPresets')) {
    const Loader = (await loadRolePackage('preset/agent-preset-registry', '@deepseek-ai/cordis-plugin-loader')).default;
    const Group = (await loadRolePackage('preset/agent-preset-registry', '@deepseek-ai/cordis-plugin-group')).default;
    await ctx.plugin(Loader); ctx.loader.builtins.group = Group;
    await ctx.plugin((await loadRolePackage('preset/agent-preset-registry', '@deepseek-ai/dsh-agent-preset-registry')).default, { default: 'standard' });
    await ctx.plugin({ inject: ['agentPresets'], async *apply(scope) {
      yield await scope.agentPresets.register({ id: 'standard', plugins: [] });
      yield await scope.agentPresets.register({ id: 'other', plugins: [] });
    } });
  }
  if (!ctx.get('approval')) await ctx.plugin((await loadRolePackage('interaction/user-approval', '@deepseek-ai/dsh-user-approval')).default, { policy: 'ask' });
  if (!ctx.get('sandboxPolicy')) await ctx.plugin((await loadRolePackage('sandbox/sandbox-policy', '@deepseek-ai/dsh-sandbox-policy')).default, { mode: 'workspace-write', workspaceRoot: process.cwd() });
  if (!ctx.get('shell')) ctx.provide('shell', { sandboxMode: ctx.sandboxPolicy.resolve().mode,
    resolve() { throw new Error('Role fixture cannot execute OS commands'); },
    run() { throw new Error('Role fixture cannot execute OS commands'); },
    start() { throw new Error('Role fixture cannot execute OS commands'); } });
  if (!ctx.get('permissionPresets')) await ctx.plugin((await loadRolePackage('interaction/permission-presets', '@deepseek-ai/dsh-permission-presets')).default, permissionPresetConfig ?? { defaultPreset: 'workspace-write' });
}
