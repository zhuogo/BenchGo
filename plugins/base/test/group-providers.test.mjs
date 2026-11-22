import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroupProviders } from '../src/group-providers.mjs';

const groupId = 'sha256:g/+roup=';
const personal = 'routergo-' + '1'.repeat(32);
const work = 'routergo-' + '2'.repeat(32);

function host(hostId) {
  let revision = 1;
  let failNextWrite = false;
  let failNextUnset = false;
  const rows = {};
  const secrets = new Map();
  const records = new Map();
  const identity = { groupId, hostId };
  const ctx = {
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', revision, user: { providers: structuredClone(rows) } }],
      async mutate(_namespace, operations, expectedRevision) {
        assert.equal(expectedRevision, revision);
        if (failNextWrite) {
          failNextWrite = false;
          throw Error('settings write failed');
        }
        for (const { op, path, value } of operations) {
          const [, route] = path;
          if (op === 'unset') delete rows[route];
          else rows[route] = structuredClone(value);
        }
        revision++;
      },
    },
    credentials: {
      resolve: async ref => secrets.get(ref),
      set: async (ref, value) => secrets.set(ref, { value, source: 'file' }),
      async unset(ref) {
        if (failNextUnset) {
          failNextUnset = false;
          throw Error('credential cleanup failed');
        }
        secrets.delete(ref);
      },
      readRecord: async key => records.get(key),
      modifyRecord: async (key, update) => records.set(key, structuredClone(update(records.get(key)))),
    },
  };
  let service = createGroupProviders(ctx);
  return {
    rows,
    secrets,
    revise: () => { revision++; },
    failNextWrite: () => { failNextWrite = true; },
    failNextUnset: () => { failNextUnset = true; },
    restart: () => { service = createGroupProviders(ctx); },
    snapshot: () => service.snapshot(identity),
    exchange: entries => service.exchange({ ...identity, entries }),
    leave: () => service.leave({ groupId }),
    seedRecord: payload => records.set('benchgo-plugin/group-providers', { kind: 'grant', payload }),
    record: () => records.get('benchgo-plugin/group-providers')?.payload,
    create(route, name, key, source = 'file') {
      const ref = name.toUpperCase().replaceAll(' ', '_') + '_KEY';
      rows[route] = { displayName: name, baseURL: 'https://routergo.cn/api/v1',
        api: 'openai-responses', apiKeyEnv: ref, models: [{ id: 'Model/Opaque:v1' }] };
      secrets.set(ref, { value: key, source });
      revision++;
    },
  };
}

test('offline provider edits cannot restore a deleted shared connection', async () => {
  const a = host('sha256:a=');
  const b = host('sha256:b+');
  const c = host('sha256:c/');
  a.create(personal, 'Personal', 'personal-key');
  b.create(work, 'Work', 'work-key');
  const combined = await b.exchange(await a.snapshot());
  await Promise.all([a.exchange(combined), c.exchange(combined)]);
  assert.deepEqual(Object.keys(c.rows).sort(), [personal, work]);
  assert.equal(c.secrets.get(c.rows[personal].apiKeyEnv).value, 'personal-key');
  const cachedRef = c.rows[work].apiKeyEnv;
  c.rows[work].displayName = 'Offline Rename';
  c.revise();
  await c.snapshot();
  delete a.rows[work];
  a.revise();
  const removed = await a.snapshot();
  assert.equal(removed.find(entry => entry.id === work).deleted, true);
  assert.equal('key' in removed.find(entry => entry.id === work), false);
  c.restart();
  const rejected = await c.exchange(removed);
  assert.equal(rejected.find(entry => entry.id === work).deleted, true);
  assert.equal(c.rows[work], undefined);
  assert.equal(c.secrets.has(cachedRef), false);
  await a.exchange(rejected);
  assert.equal(a.rows[work], undefined);
});

test('device-group deletion clears RouterGo authorization on its source device', async () => {
  const a = host('a');
  const b = host('b');
  const keyRef = 'BENCHGO_ROUTERGO_KEY_' + '3'.repeat(32);
  const tokenRef = 'BENCHGO_ROUTERGO_ACCOUNT_' + '3'.repeat(32);
  a.create(personal, 'Personal', 'account-key');
  a.rows[personal].apiKeyEnv = keyRef;
  a.secrets.set(keyRef, { value: 'account-key', source: 'file' });
  a.secrets.set(tokenRef, { value: 'local-only-token', source: 'file' });
  await b.exchange(await a.snapshot());
  assert.equal([...b.secrets.values()].some(credential => credential.value === 'local-only-token'), false);
  const replicaRef = b.rows[personal].apiKeyEnv;
  delete b.rows[personal];
  b.revise();
  a.restart();
  await a.exchange(await b.snapshot());
  assert.equal(a.rows[personal], undefined);
  assert.equal(a.secrets.has(keyRef), false);
  assert.equal(a.secrets.has(tokenRef), false);
  assert.equal(b.secrets.has(replicaRef), false);
});

test('device-group deletion preserves a RouterGo key still used by another connection', async () => {
  const a = host('a');
  const b = host('b');
  const keyRef = 'BENCHGO_ROUTERGO_KEY_' + '4'.repeat(32);
  const tokenRef = 'BENCHGO_ROUTERGO_ACCOUNT_' + '4'.repeat(32);
  a.create(personal, 'Personal', 'account-key');
  a.rows[personal].apiKeyEnv = keyRef;
  a.rows[work] = { ...a.rows[personal], displayName: 'Work' };
  a.secrets.set(keyRef, { value: 'account-key', source: 'file' });
  a.secrets.set(tokenRef, { value: 'local-only-token', source: 'file' });
  await b.exchange(await a.snapshot());
  delete b.rows[personal];
  b.revise();
  await a.exchange(await b.snapshot());
  assert.equal(a.rows[personal], undefined);
  assert.equal(a.rows[work].apiKeyEnv, keyRef);
  assert.equal(a.secrets.has(keyRef), true);
  assert.equal(a.secrets.has(tokenRef), true);
});

test('all managed connections share automatically while environment credentials stay on their host', async () => {
  const a = host('a');
  const b = host('b');
  a.create(personal, 'Personal', 'personal-key');
  a.create(work, 'Work', 'work-key');
  a.create('environment', 'Env', 'external-key', 'env');
  await b.exchange(await a.snapshot());
  assert.deepEqual(Object.keys(b.rows).sort(), [personal, work]);
  a.rows[personal].displayName = 'My key';
  a.secrets.get(a.rows[personal].apiKeyEnv).value = 'rotated-key';
  a.revise();
  await b.exchange(await a.snapshot());
  assert.equal(b.rows[personal].displayName, 'My key');
  assert.equal(b.rows[personal].models[0].id, 'Model/Opaque:v1');
  assert.equal(b.secrets.get(b.rows[personal].apiKeyEnv).value, 'rotated-key');
  await b.leave();
  assert.deepEqual(b.rows, {});
  assert.equal(b.secrets.size, 0);
});

test('a formerly local connection gets a new shared ID without reviving its tombstone', async () => {
  const a = host('a');
  const b = host('b');
  a.create(work, 'Work', 'work-key');
  const tombstone = { id: work, route: work, revision: 2, writer: 'a', deleted: true };
  a.seedRecord({ localOnly: [work], shareAgain: {}, groups: { [groupId]: {
    revision: 2, entries: { [work]: tombstone }, bindings: {},
  } } });
  const entries = await a.snapshot();
  assert.deepEqual(entries.find(entry => entry.id === work), tombstone);
  const live = entries.find(entry => !entry.deleted);
  assert.notEqual(live.id, work);
  assert.deepEqual(Object.keys(a.record()), ['groups']);
  await b.exchange(entries);
  assert.equal(b.secrets.get(b.rows[work].apiKeyEnv).value, 'work-key');
  a.restart();
  assert.equal((await a.snapshot()).find(entry => !entry.deleted).id, live.id);
});

test('a failed settings write never changes the credential of a committed provider', async () => {
  const a = host('a');
  const b = host('b');
  a.create(personal, 'Personal', 'old-key');
  await b.exchange(await a.snapshot());
  const oldRef = b.rows[personal].apiKeyEnv;
  a.create(personal, 'New endpoint', 'rotated-key');
  a.rows[personal].baseURL = 'https://example.com/v1';
  b.failNextWrite();
  await assert.rejects(b.exchange(await a.snapshot()), /settings write failed/);
  assert.equal(b.rows[personal].baseURL, 'https://routergo.cn/api/v1');
  assert.equal(b.secrets.get(oldRef).value, 'old-key');
  b.restart();
  await b.snapshot();
  assert.equal(b.rows[personal].baseURL, 'https://example.com/v1');
  assert.equal(b.secrets.get(b.rows[personal].apiKeyEnv).value, 'rotated-key');
  assert.equal(b.secrets.has(oldRef), false);
});

test('old credentials are cleaned up after a restart following a committed sync', async () => {
  const a = host('a');
  const b = host('b');
  a.create(personal, 'Personal', 'old-key');
  await b.exchange(await a.snapshot());
  const oldRef = b.rows[personal].apiKeyEnv;
  a.create(personal, 'Personal', 'rotated-key');
  b.failNextUnset();
  await assert.rejects(b.exchange(await a.snapshot()), /credential cleanup failed/);
  const newRef = b.rows[personal].apiKeyEnv;
  assert.notEqual(newRef, oldRef);
  assert.equal(b.secrets.get(newRef).value, 'rotated-key');
  assert.equal(b.secrets.has(oldRef), true);
  b.restart();
  await b.snapshot();
  assert.equal(b.rows[personal].apiKeyEnv, newRef);
  assert.equal(b.secrets.has(oldRef), false);
});
