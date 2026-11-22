import { mountLink } from '../lib/link.mjs';
import { registerOrdinaryServerSshTool } from '../shared/server-ssh-tool.mjs';

export const name = 'benchgo-link';
export const inject = [
  'benchgo',
  'connection',
  'credentials',
  'workspaceRegistry',
  'typertGateway',
  'sessionController',
  'webServer',
  'clientModules',
];

export async function apply(ctx, config = {}) {
  const link = await mountLink(ctx, {
    ...ctx.get('benchgo').config.link,
    ...config,
    webRoot: new URL('../lib/link-web/', import.meta.url),
  });
  ctx.provide('benchgoLink', link);
  registerOrdinaryServerSshTool(ctx, link);
}
