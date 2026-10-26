import { mountLink } from '../lib/link.mjs';

export const name = 'benchgo-link';
export const inject = [
  'commander',
  'commanderLinkConfig',
  'connection',
  'workspaceRegistry',
  'typertGateway',
  'sessionController',
  'webServer',
  'clientModules',
];

export async function apply(ctx, config = {}) {
  await mountLink(ctx, {
    ...ctx.get('commanderLinkConfig'),
    ...config,
    webRoot: new URL('../lib/link-web/', import.meta.url),
  });
}
