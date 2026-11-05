import { mountLink } from '../lib/link.mjs';

export const name = 'benchgo-link';
export const inject = [
  'benchgo',
  'connection',
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
}
