import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelCredentials } from '../src/channel-credentials.mjs';
import { parseCredentialKey } from '../../../deepseek-harness/packages/credentials/credentials/src/index.ts';

test('channel secrets are encrypted, independently referenced and survive service reload', async () => {
  const records = new Map();
  const credentials = { readRecord: async ref => records.get(ref), modifyRecord: async (ref, mutate) => records.set(ref, await mutate(records.get(ref))), resolve: async ref => ref === 'EXISTING' ? { value: 'legacy' } : undefined };
  const service = createChannelCredentials({ credentials });
  const a = await service.save({ channel: 'telegram', field: 'tokenRef', secret: 'private-token-first' });
  const b = await service.save({ channel: 'discord', field: 'tokenRef', secret: 'private-token-second' });
  assert.notEqual(a.ref, b.ref);
  for (const key of records.keys()) assert.doesNotThrow(() => parseCredentialKey(key));
  assert.doesNotMatch(JSON.stringify([...records]), /private-token/);
  assert.deepEqual(Object.keys(a), ['ref']);
  const reloaded = createChannelCredentials({ credentials });
  assert.equal((await reloaded.resolve(a.ref)).value, 'private-token-first');
  assert.equal((await reloaded.resolve(b.ref)).value, 'private-token-second');
  assert.equal((await reloaded.resolve('EXISTING')).value, 'legacy');
  const storageKey = ref => `benchgo-plugin/channel-${ref.slice('benchgo-channel:'.length).replaceAll(':', '-')}`;
  records.get(storageKey(a.ref)).payload.ciphertext = records.get(storageKey(b.ref)).payload.ciphertext;
  await assert.rejects(reloaded.resolve(a.ref), /凭据不可用/);
  service.dispose(); await assert.rejects(service.resolve(b.ref), /凭据不可用/);
});

test('channel credential validation never echoes secrets', async () => {
  const service = createChannelCredentials({ credentials: {} });
  for (const input of [{ channel: 'unknown', field: 'tokenRef', secret: 'private' }, { channel: 'discord', field: '__proto__', secret: 'private' }, { channel: 'discord', field: 'tokenRef', secret: '' }]) {
    await assert.rejects(service.save(input), error => error.status === 400 && !error.message.includes('private'));
  }
});
