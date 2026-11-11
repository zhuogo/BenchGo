import { VoiceConfig } from './config.mjs';
import { mountWeb } from './web.mjs';
import { createModelProviders } from '../../../../src/model-providers.mjs';
import { createVoiceSettingsAdapter } from './settings-adapter.mjs';
import { createConversationBridge } from './conversation-bridge.mjs';
import { registerVoiceSessionProjection } from './session-projection.mjs';

export const name = 'voice';
export const inject = ['benchgo', 'connection', 'settings', 'credentials', 'llm'];

export async function apply(ctx, config = {}) {
  ctx.inject(['sessionProjections'], async child => { await registerVoiceSessionProjection(child); });
  const store = await new VoiceConfig({ ...ctx.get('benchgo').config.voice, ...config }).open();
  ctx.effect(() => () => store.writes);
  mountWeb(ctx, store, { providers: createModelProviders(ctx), llm: ctx.get('llm'), conversationBridge: createConversationBridge(ctx) });
  ctx.provide('voice', store);
  ctx.inject(['benchgoSettings'], child => { const manager = child.get?.('benchgoSettings'); if (manager) child.effect(() => manager.register(createVoiceSettingsAdapter(store))); });
}
