import { VoiceConfig } from './config.mjs';
import { mountWeb } from './web.mjs';
import { createModelProviders } from '../../benchgo/src/model-providers.mjs';
import { createVoiceSettingsAdapter } from './settings-adapter.mjs';

export const name = 'voice';
export const inject = ['benchgo', 'connection', 'settings', 'credentials', 'llm'];

export async function apply(ctx, config = {}) {
  const store = await new VoiceConfig({ ...ctx.get('benchgo').config.voice, ...config }).open();
  ctx.effect(() => () => store.writes);
  mountWeb(ctx, store, { providers: createModelProviders(ctx) });
  ctx.provide('voice', store);
  ctx.inject(['benchgoSettings'], child => { const manager = child.get?.('benchgoSettings'); if (manager) child.effect(() => manager.register(createVoiceSettingsAdapter(store))); });
}
