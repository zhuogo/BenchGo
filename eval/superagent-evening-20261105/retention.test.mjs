import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { assertNoCredentials, canRemoveState } from './retention.mjs';

test('isolated state is removed only after a verified successful run', () => {
  const passed = { childStopped: true, mainConfigurationUnchanged: true, scenarios: [{ status: 'pass' }] };
  assert.equal(canRemoveState(passed), true);
  for (const change of [
    { childStopped: false }, { mainConfigurationUnchanged: false }, { fatal: 'error' },
    { scenarios: [] }, { scenarios: [{ status: 'fail' }] }, { scenarios: [{ status: 'running' }] },
  ]) assert.equal(canRemoveState({ ...passed, ...change }), false);
});

test('supplier credentials cannot be written to retained configuration', () => {
  assert.doesNotThrow(() => assertNoCredentials({ apiKeyEnv: 'KEY' }, { KEY: 'secret-value' }));
  assert.throws(() => assertNoCredentials({ apiKey: 'secret-value' }, { KEY: 'secret-value' }), /must not be written/);
});
