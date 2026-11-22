import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestContextWindows } from '../shared/model-context-optimization.mjs';

test('uses exact model IDs and connection pricing, preserves smaller windows and output space', () => {
  const models = [
    { id: 'gpt-5.4', maxTokens: 128_000 }, { id: 'gpt-5.4-mini' }, { id: 'Gpt-5.4' },
    { id: 'large', contextWindow: 500_000 }, { id: 'large-output', maxTokens: 450_000 },
    { id: 'large-tts' }, { id: 'unknown', contextWindow: 1_000_000 }, { id: 'large-discovered' },
  ];
  const profiles = new Map([
    ['gpt-5.4', { context: 1_050_000 }], ['gpt-5.4-mini', { context: 400_000 }],
    ['large', { context: 1_000_000 }], ['large-output', { context: 1_000_000 }],
    ['large-tts', { context: 1_000_000, capabilities: ['tts'] }],
  ]);
  const options = { defaultMaxTokens: 128_000, discoveredModels: new Map([['large-discovered', { contextWindow: 1_000_000 }]]) };
  const direct = suggestContextWindows(models, profiles, { ...options, baseURL: 'https://api.openai.com/v1' });
  assert.deepEqual(direct.map(({ id, after, reason }) => [id, after, reason]), [
    ['gpt-5.4', 272_000, 'pricing'], ['large-discovered', 500_000, 'half'],
  ]);
  const gateway = suggestContextWindows(models, profiles, { ...options, baseURL: 'https://gateway.example/v1' });
  assert.deepEqual(gateway.map(({ id, after, reason }) => [id, after, reason]), [
    ['gpt-5.4', 525_000, 'half'], ['large-discovered', 500_000, 'half'],
  ]);
  assert.equal(models[0].maxTokens, 128_000);
});
