import { createModelProviders } from '../../benchgo/src/model-providers.mjs';
import { mountAssistant } from './service.mjs';

export const name = 'superagent';
export const inject = ['benchgo', 'commander', 'connection', 'settings', 'credentials', 'llm', 'agents', 'sessionQuery', 'sessionProjections', 'workspaceRegistry', 'tokenMeter'];

export async function apply(ctx) {
  // The assistant protocol and persistent workspace keep their existing IDs.
  // This plugin owns only its own routes, sessions and background workers.
  const assistant = await mountAssistant(ctx, ctx.get('commander'), createModelProviders(ctx));
  ctx.provide('assistant', assistant);
}
