import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mountLink } from '../src/index.mjs';
import { createLinkSettingsAdapter, LINK_TRANSPORT_NAMESPACE, LINK_RELAY_NAMESPACE } from '../src/settings-adapter.mjs';
import { createSettingsManagement } from '../../benchgo/src/settings-management.mjs';

const actor = { kind: 'owner', id: 'link-settings-test', confirm: async plan => ({ outcome: 'allowed-once', digest: plan.digest }) };
const ref = namespace => ({ adapterId: 'benchgo-link', namespace });
const set = (key, value) => ({ op: 'set', path: [key], value });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'link-settings-'));
  await writeFile(join(directory, 'devices.json'), JSON.stringify({ host: '127.0.0.1', port: 0, name: '原设备' }));
  const manager = createSettingsManagement({ directory: join(directory, 'audit') }), routes = [];
  const disposals = [];
  const ctx = {
    get: () => undefined, workspaceRegistry: { list: () => [] },
    connection: { fetch: { register: route => { routes.push(route); return () => {}; } } }, effect: fn => fn(),
    inject(names, callback) {
      assert.deepEqual(names, ['benchgoSettings']);
      callback({ get: name => name === 'benchgoSettings' ? manager : undefined, effect: fn => { const dispose = fn(); disposals.push(dispose); return dispose; } });
    },
  };
  let link = await mountLink(ctx, { directory, env: {}, createRelayHost: async () => ({ close: async () => {}, status: () => ({ connected: true }) }) });
  await manager.flush();
  t.after(async () => { for (const dispose of disposals) dispose(); await manager.close(); await link.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, link, manager, routes, adapter: createLinkSettingsAdapter(link), async reload() {
    for (const dispose of disposals.splice(0)) dispose();
    await link.close(); link = await mountLink(ctx, { directory, env: {} }); await manager.flush(); return link;
  } };
}
async function update(manager, namespace, ops) {
  const current = await manager.read(ref(namespace));
  const plan = await manager.prepare({ ...ref(namespace), expectedRevision: current.revision, ops }, actor);
  return manager.commit({ operationId: plan.operationId }, actor);
}

test('Link registers the real store, native page changes are audited, and managed changes roll back', async t => {
  const { manager, link, routes, directory, reload } = await fixture(t);
  const entries = (await manager.catalog()).entries;
  assert.equal(entries.find(row => row.namespace === LINK_TRANSPORT_NAMESPACE).applies, 'live');
  assert.equal(entries.find(row => row.namespace === 'benchgo-link-launch').applies, 'blocked');
  const before = await manager.read(ref(LINK_TRANSPORT_NAMESPACE));
  assert.equal(before.value.port, 0, 'persisted random-port preference differs from the actual bound port');
  assert.ok(link.status().port > 0);
  const receipt = await update(manager, LINK_TRANSPORT_NAMESPACE, [set('name', '总助手设置')]);
  assert.equal(receipt.application.state, 'applied'); assert.equal(receipt.verified, true);
  assert.equal(link.status().hostName, '总助手设置');
  assert.equal(JSON.parse(await readFile(join(directory, 'devices.json'), 'utf8')).name, '总助手设置');
  const current = await manager.read(ref(LINK_TRANSPORT_NAMESPACE));
  const undo = await manager.rollback({ historyId: receipt.historyId, expectedRevision: current.revision }, actor);
  await manager.commit({ operationId: undo.operationId }, actor);
  assert.equal(link.status().hostName, '原设备');
  const route = routes.find(row => row.path === '/api/commander-link');
  const response = await route.fetch(new Request('http://localhost/api/commander-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'configure', name: '页面设置' }) }));
  assert.equal(response.status, 200); await manager.flush();
  assert.equal((await manager.read(ref(LINK_TRANSPORT_NAMESPACE))).value.name, '页面设置');
  assert.ok(manager.history(ref(LINK_TRANSPORT_NAMESPACE)).some(row => row.source === 'external' && row.diff.some(change => change.path[0] === 'name')));
  assert.equal((await reload()).status().hostName, '页面设置');
});

test('Link checks CAS inside the shared native mutation queue and preserves other configuration', async t => {
  const { manager, link, adapter } = await fixture(t);
  const snapshot = await adapter.read(LINK_TRANSPORT_NAMESPACE);
  const native = link.admin({ action: 'configure', publicUrl: 'https://desk.example', name: '页面先保存' });
  const stale = adapter.apply(LINK_TRANSPORT_NAMESPACE, { ops: [set('name', '过期修改')], expected: { fingerprint: snapshot.fingerprint } });
  await native; await assert.rejects(stale, { code: 'REVISION_CONFLICT' });
  await update(manager, LINK_TRANSPORT_NAMESPACE, [set('name', '只改名称')]);
  assert.equal(link.status().hostName, '只改名称'); assert.equal(link.status().publicUrl, 'https://desk.example');
  const current = await manager.read(ref(LINK_TRANSPORT_NAMESPACE));
  await assert.rejects(manager.prepare({ ...ref(LINK_TRANSPORT_NAMESPACE), expectedRevision: current.revision, ops: [set('enabled', false)] }, actor));
});

test('Link failed listener changes restore the prior configuration and continue serving', async t => {
  const { link, adapter } = await fixture(t);
  const occupied = createServer().listen(0, '127.0.0.1'); await once(occupied, 'listening');
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const snapshot = await adapter.read(LINK_TRANSPORT_NAMESPACE);
  await assert.rejects(adapter.apply(LINK_TRANSPORT_NAMESPACE, { ops: [set('port', occupied.address().port)], expected: { fingerprint: snapshot.fingerprint } }));
  assert.equal((await adapter.read(LINK_TRANSPORT_NAMESPACE)).fingerprint, snapshot.fingerprint);
  assert.equal(link.status().enabled, true);
});

test('Link relay public fields share the native pool and secrets remain blocked and absent from audit', async t => {
  const { manager, link, adapter } = await fixture(t), token = 'private-link-secret-123';
  await link.admin({ action: 'relay-pool-configure', nodes: [{ id: 'primary', url: 'https://relay.example', token, priority: 0, enabled: false }] });
  await manager.flush();
  const current = await manager.read(ref(LINK_RELAY_NAMESPACE));
  assert.equal(JSON.stringify(current).includes(token), false);
  for (const path of [['nodes'], ['nodes', '0'], ['nodes', '0', 'token'], ['nodes', '3', 'token']]) {
    await assert.rejects(manager.prepare({ ...ref(LINK_RELAY_NAMESPACE), expectedRevision: current.revision, ops: [{ op: 'set', path, value: token }] }, actor), { code: 'SETTINGS_SECRET_BLOCKED' });
  }
  await update(manager, LINK_RELAY_NAMESPACE, [{ op: 'set', path: ['nodes', '0', 'priority'], value: 4 }]);
  assert.equal(link.status().relay.nodes[0].priority, 4);
  assert.equal(JSON.stringify(manager.history(ref(LINK_RELAY_NAMESPACE))).includes(token), false);
  const snapshot = await adapter.read(LINK_RELAY_NAMESPACE);
  await assert.rejects(adapter.apply(LINK_RELAY_NAMESPACE, { ops: [{ op: 'set', path: ['nodes', '0', 'token'], value: 'replacement' }], expected: { fingerprint: snapshot.fingerprint } }), { code: 'SETTINGS_PATH_BLOCKED' });
});
