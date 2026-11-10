import test from 'node:test';
import assert from 'node:assert/strict';
import { validateModelSettings } from '../client/model-settings.mjs';

test('collapsed model validation identifies the affected role and preserves opaque IDs', () => {
  const model = { providerId: 'Provider/@Exact', modelId: 'DeepSeek-V4.1:Flash/Exact' };
  const config = { models: [model], workerModels: [], auxiliary: null };
  assert.equal(validateModelSettings(config), null);
  assert.deepEqual(config.models, [model]);
  for (const [role, patch] of [
    ['router', { models: [{ providerId: '', modelId: '' }] }],
    ['worker', { workerModels: [{ providerId: model.providerId, modelId: '' }] }],
    ['auxiliary', { auxiliary: { models: [model, model] } }],
  ]) assert.equal(validateModelSettings({ ...config, ...patch }).role, role);
  for (const modelId of [' leading', 'trailing ', 'line\nbreak', 'x'.repeat(513)])
    assert.equal(validateModelSettings({ ...config, workerModels: [{ ...model, modelId }] }).role, 'worker');
  assert.equal(validateModelSettings({ ...config, models: Array.from({ length: 33 }, (_, i) => ({ ...model, modelId: String(i) })) }).role, 'router');
  assert.equal(validateModelSettings({ ...config, workerModels: [model], auxiliary: { models: [model] } }), null);
});
