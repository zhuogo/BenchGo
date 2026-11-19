import { VoiceConfig } from './config.mjs';
import { mountWeb } from './web.mjs';
import { createModelProviders } from '../../base/src/model-providers.mjs';
import { createVoiceSettingsAdapter } from './settings-adapter.mjs';
import { createConversationBridge } from './conversation-bridge.mjs';
import { registerVoiceSessionProjection } from './session-projection.mjs';
import { createMediaGeneration } from './generation.mjs';
import { createMediaGenerationSettingsAdapter } from './generation-settings-adapter.mjs';
import { mountMediaGenerationWeb } from './generation-web.mjs';
import { createNativeMediaTools, mediaToolDefinitions } from './generation-tools.mjs';
import { join } from 'node:path';

export const name = 'voice';
export const inject = ['benchgo', 'connection', 'settings', 'credentials', 'llm'];

export async function apply(ctx, config = {}) {
  ctx.inject(['sessionProjections'], async child => { await registerVoiceSessionProjection(child); });
  const benchgo = ctx.get('benchgo');
  const store = await new VoiceConfig({ ...benchgo.config.voice, ...config }).open();
  const providers = createModelProviders(ctx);
  const shutdown = new AbortController();
  const generation = await createMediaGeneration({
    directory: join(benchgo.directory, 'media'), providers, credentials: ctx.credentials, shutdown: shutdown.signal,
  });
  ctx.effect(() => () => { shutdown.abort(); return generation.dispose(); });
  ctx.provide('mediaGeneration', { ...generation, ...createNativeMediaTools(generation) });
  mountMediaGenerationWeb(ctx, generation);
  ctx.inject(['tools'], child => {
    for (const { when, ...definition } of mediaToolDefinitions({ generation, attachments: () => child.get('attachments') })) {
      child.effect(() => child.tools.register(definition, { when }));
    }
  });
  ctx.effect(() => () => store.writes);
  mountWeb(ctx, store, { providers, llm: ctx.get('llm'), conversationBridge: createConversationBridge(ctx), getAssistant: () => ctx.get?.('assistant') });
  ctx.provide('voice', store);
  ctx.inject(['benchgoSettings'], child => {
    const manager = child.get('benchgoSettings');
    child.effect(() => manager.register(createVoiceSettingsAdapter(store)));
    child.effect(() => manager.register(createMediaGenerationSettingsAdapter(generation)));
  });
}
