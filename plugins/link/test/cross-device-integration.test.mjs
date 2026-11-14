import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountLink } from '../src/index.mjs';

async function host(t, name, projects, assistant, stored = {}) {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-cross-device-')), directory = join(root, 'link');
  await mkdir(directory);
  await writeFile(join(directory, 'devices.json'), JSON.stringify({ name, host: '127.0.0.1', port: 0, ...stored }));
  const routes = [];
  const ctx = {
    get: key => key === 'assistant' ? assistant : undefined,
    workspaceRegistry: { list: () => projects },
    connection: { fetch: { register: value => { routes.push(value); return () => {}; } } },
    effect: fn => fn(),
  };
  const link = await mountLink(ctx, { directory, env: {} });
  t.after(async () => { await link.close(); await rm(root, { recursive: true, force: true }); });
  const route = routes.find(route => route.path === '/api/commander-devices');
  const launchResponse = await route.fetch(new Request('http://127.0.0.1' + route.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'launch' }) }));
  assert.equal(launchResponse.status, 200);
  const launch = await launchResponse.json();
  const entry = await fetch(launch.url, { redirect: 'manual' });
  assert.equal(entry.status, 303);
  const base = new URL(entry.headers.get('location'), launch.url);
  const deviceApi = async input => {
    const response = await fetch(new URL('api/devices', base), {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base.origin }, body: JSON.stringify(input),
    });
    const value = await response.json();
    assert.equal(response.status, 200, value.error || 'device-center operation');
    return value;
  };
  return { link, ctx, directory, routes, deviceApi };
}

async function pair(source, target, grants = {}) {
  const invitation = await target.link.admin({ action: 'pairing', mode: 'lan', ...grants });
  const pending = await source.deviceApi({ action: 'pair', uri: invitation.uri });
  const requests = target.link.status().pending;
  assert.equal(requests.length, 1);
  await target.link.admin({ action: 'confirm', id: requests[0].id });
  const result = await source.deviceApi({ action: 'pairStatus', requestId: pending.requestId });
  assert.equal(result.status, 'approved');
  return result.device;
}

test('project summaries mark only the durable default workspace for Recent across devices', async t => {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-default-resource-')), directory = join(root, 'link');
  await mkdir(directory);
  await writeFile(join(directory, 'devices.json'), JSON.stringify({ name: 'B', host: '127.0.0.1', port: 0 }));
  const recentFile = join(root, 'recent-workspace.json');
  await writeFile(recentFile, JSON.stringify({ id: 'default-id', path: '/b/default-workspace' }));
  const projects = [{ id: 'default-id', title: 'default-workspace', path: '/b/default-workspace', sessionIds: [] }, { id: 'user-id', title: 'default-workspace', path: '/b/user/default-workspace', sessionIds: [] }];
  const ctx = { workspaceRegistry: { list: () => projects }, get() {}, effect: fn => fn(), connection: { fetch: { register: () => () => {} } } };
  const link = await mountLink(ctx, { directory, env: {} });
  t.after(async () => { await link.close(); await rm(root, { recursive: true, force: true }); });
  const result = await link.resources({ deviceId: 'local', kind: 'projects' });
  assert.deepEqual(result.devices[0].items.map(row => [row.resourceId, row.isDefault]), [['default-id', true], ['user-id', false]]);
  await writeFile(recentFile, JSON.stringify({ id: 'user-id', path: '/b/user/default-workspace' }));
  const changed = await link.resources({ deviceId: 'local', kind: 'projects' });
  assert.deepEqual(changed.devices[0].items.map(row => row.isDefault), [false, true]);
});

test('two actual Link hosts discover their own resources over TLS and preserve device ownership', async t => {
  const a = await host(t, 'A', [{ id: 'same-id', title: 'A project', path: '/a/work', sessionIds: [] }]);
  const b = await host(t, 'B', [
    { id: 'same-id', title: 'B project', path: '/b/work', sessionIds: [] },
    { id: 'b-second', title: 'B second', path: '/b/other', sessionIds: [] },
  ]);
  const bOnA = await pair(a, b);
  const aOnB = await pair(b, a);
  const aggregate = await a.link.resources({ deviceIds: ['local', bOnA.id], kind: 'projects', limit: 1 });
  assert.equal(aggregate.partial, false);
  assert.equal(aggregate.devices[0].items[0].name, 'A project');
  assert.equal(aggregate.devices[1].items[0].name, 'B project');
  assert.equal(aggregate.devices[1].items[0].deviceId, bOnA.id);
  assert.equal(aggregate.devices[1].items[0].resourceId, 'same-id');
  assert.equal(aggregate.devices[1].hasMore, true);
  const second = await a.link.resources({ deviceId: bOnA.id, kind: 'projects', limit: 1, offset: 1 });
  assert.equal(second.devices[0].items[0].resourceId, 'b-second');
  const reverse = await b.link.resources({ deviceId: aOnB.id, kind: 'projects' });
  assert.equal(reverse.devices[0].items[0].path, '/a/work');
  assert.equal(reverse.devices[0].items[0].deviceId, aOnB.id);
  assert.ok((await a.link.devices()).devices.some(device => device.id === bOnA.id && device.direction === 'outbound'));
  const empty = await a.link.resources({ deviceId: bOnA.id, kind: 'projects', offset: 10 });
  assert.equal(empty.devices[0].available, true);
  assert.deepEqual(empty.devices[0].items, []);
});

test('session resources share one project snapshot and remain readable over TLS without a model catalog', async t => {
  const a = await host(t, 'A', []);
  const projects = [
    { id: 'default', title: 'Default', path: '/default', sessionIds: ['first', 'private', 'child', 'subagent'] },
    { id: 'other', title: 'Other', path: '/other', sessionIds: ['second'] },
  ];
  const b = await host(t, 'B', projects, { sidebarPrivateSessionIds: async () => ['private'] });
  await writeFile(join(b.directory, '..', 'recent-workspace.json'), JSON.stringify({ id: 'default', path: '/default' }));
  const calls = [];
  let projectReads = 0, catalogAvailable = false;
  b.ctx.workspaceRegistry.list = () => { projectReads++; return projects; };
  const get = b.ctx.get;
  b.ctx.get = name => name === 'commander' ? { list: () => [
    { id: 'native-default', ownerSessionId: 'commander-web:owner', projectId: 'default', cwd: '/default', provider: 'native-provider', updatedAt: 30 },
    { id: 'native-other', ownerSessionId: 'commander-web:owner', projectId: 'other', cwd: '/other', provider: 'native-provider', updatedAt: 40 },
  ] } : get(name);
  b.ctx.connection.createPeer = () => ({ dispose() {} });
  b.ctx.typertGateway = {
    invoke: async call => {
      calls.push(call.method);
      if (call.method === 'list') return { items: [
        { sessionId: 'first', updatedAt: 10 },
        { sessionId: 'second', updatedAt: 20 },
        { sessionId: 'private', updatedAt: 100 },
        { sessionId: 'child', parentSessionId: 'first', updatedAt: 100 },
        { sessionId: 'subagent', origin: 'subagent', updatedAt: 100 },
        { sessionId: 'unregistered', updatedAt: 100 },
      ] };
      assert.equal(call.method, 'modelCatalog');
      if (!catalogAvailable) throw new Error('Catalog unavailable');
      return { groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'model', name: 'Model' }] }] };
    },
    wireStream: { open: async (_endpoint, _payload, _uplink, _peer, signal) => (async function* () {
      yield { type: 'ready', clientId: 'client' };
      await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    })() },
  };
  const device = await pair(a, b);
  for (const [kind, expected] of [
    ['sessions', ['first', 'second', 'native:native-default', 'native:native-other']],
    ['recent', ['native:native-default', 'first']],
  ]) {
    calls.length = 0; projectReads = 0;
    const result = await a.link.resources({ deviceId: device.id, kind });
    assert.equal(result.devices[0].available, true);
    assert.deepEqual(result.devices[0].items.map(row => row.resourceId), expected);
    assert.equal(projectReads, 1, `${kind} shares its project snapshot with native sessions`);
    assert.deepEqual(calls, ['list']);
  }
  await assert.rejects(a.link.callDevice({ deviceId: device.id, input: { action: 'state' } }), /Catalog unavailable/);
  catalogAvailable = true;
  calls.length = 0; projectReads = 0;
  const models = await a.link.resources({ deviceId: device.id, kind: 'models' });
  assert.deepEqual(models.devices[0].items.map(row => row.model), ['model']);
  assert.deepEqual(calls, ['modelCatalog']);
  assert.equal(projectReads, 0);
  const state = await a.link.callDevice({ deviceId: device.id, input: { action: 'state' } });
  assert.deepEqual(state.projects.map(row => row.id), ['default', 'other']);
  assert.deepEqual(state.sessions.map(row => row.id), ['first', 'second', 'native:native-default', 'native:native-other']);
  assert.deepEqual(state.models, [{ provider: 'provider', model: 'model', label: 'Provider · Model' }]);
  assert.deepEqual(await a.link.callDevice({ deviceId: device.id, input: { action: 'models' } }), { models: state.models });
});

test('revocation removes cached remote resources without clearing healthy local results', async t => {
  const a = await host(t, 'A', [{ id: 'a', title: 'local', path: '/a', sessionIds: [] }]);
  const b = await host(t, 'B', [{ id: 'b', title: 'remote', path: '/b', sessionIds: [] }]);
  const device = await pair(a, b);
  assert.equal((await a.link.resources({ deviceId: device.id, kind: 'projects' })).devices[0].available, true);
  await b.link.admin({ action: 'revoke', id: b.link.status().devices[0].id });
  const result = await a.link.resources({ deviceIds: ['local', device.id], kind: 'projects' });
  assert.equal(result.partial, true);
  assert.equal(result.devices[0].available, true);
  assert.equal(result.devices[1].available, false);
  assert.equal(result.devices[1].code, 'UNAUTHORIZED');
  assert.deepEqual(result.devices[1].items, []);
  assert.equal(result.devices[1].freshness, 'unknown');
});

test('collaboration uses an explicit device grant and the TLS-bound principal, not JSON identity', async t => {
  const calls = [];
  const b = await host(t, 'B', [], { async collaboration(input, access) { calls.push({ input, access }); return { accepted: true, requestId: input.requestId }; } });
  const a = await host(t, 'A', []);
  const device = await pair(a, b);
  const input = { action: 'collaboration', operation: 'delegate', requestId: 'stable-request', text: 'Read the project', principal: { kind: 'owner' } };
  await assert.rejects(a.link.callDevice({ deviceId: device.id, input }), error => error.statusCode === 403 || error.status === 403);
  assert.equal(calls.length, 0);
  const inboundId = b.link.status().devices[0].id;
  await b.link.admin({ action: 'grant-device', id: inboundId, collaboration: true });
  const reply = await a.link.callDevice({ deviceId: device.id, input });
  assert.equal(reply.accepted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.principal, undefined);
  assert.equal(calls[0].access.principal.kind, 'device');
  assert.equal(calls[0].access.principal.deviceId, inboundId);
  assert.deepEqual(calls[0].access.principal.capabilities, ['collaboration']);
  await assert.rejects(a.link.callDevice({ deviceId: device.id, input: { action: 'management', operation: 'status' } }), error => error.statusCode === 403 || error.status === 403);
});

test('remote relay changes require one exact local decision and preserve unrelated configuration', async t => {
  const a = await host(t, 'A', []), b = await host(t, 'B', []);
  await b.link.admin({ action: 'relay-pool-configure', nodes: [
    { id: 'first', url: 'https://relay-one.example', token: 'test-first-secret', priority: 0, enabled: false },
    { id: 'second', url: 'https://relay-two.example', token: 'test-second-secret', priority: 1, enabled: false },
  ] });
  const device = await pair(a, b, { management: true });
  const call = input => a.link.callDevice({ deviceId: device.id, input: { action: 'management', ...input } });
  const snapshot = await call({ operation: 'settings-read', namespace: 'benchgo-link-relay' });
  assert.ok(!JSON.stringify(snapshot).includes('test-first-secret'));
  const request = { operation: 'settings-prepare', requestId: 'same-relay-change', namespace: 'benchgo-link-relay', expected: { fingerprint: snapshot.fingerprint }, ops: [{ op: 'set', path: ['nodes', '0', 'priority'], value: 8 }] };
  const prepared = await call(request);
  assert.equal(prepared.state, 'pending');
  assert.equal((await call(request)).operationId, prepared.operationId);
  assert.equal(b.link.status().relay.nodes[0].priority, 0);
  assert.equal(b.link.status().pendingManagement.length, 1);
  const applied = await b.deviceApi({ action: 'hostManagementDecide', operationId: prepared.operationId, allow: true });
  assert.equal(applied.state, 'applied', JSON.stringify(applied.error));
  assert.equal((await call({ operation: 'operation', operationId: prepared.operationId })).state, 'applied');
  assert.equal(b.link.status().relay.nodes[0].priority, 8);
  assert.equal(b.link.status().relay.nodes[1].priority, 1);
  assert.equal(b.link.status().relay.nodes[1].enabled, false);
  assert.equal((await b.deviceApi({ action: 'hostManagementDecide', operationId: prepared.operationId, allow: true })).state, 'applied');
  assert.equal(b.link.status().pendingManagement.length, 0);
});

test('remote management rejects changed intent, owner refusal, stale CAS and revoked grants without applying', async t => {
  const a = await host(t, 'A', []), b = await host(t, 'B', []);
  await b.link.admin({ action: 'relay-pool-configure', nodes: [{ id: 'only', url: 'https://relay.example', token: 'private-relay-secret', priority: 0, enabled: false }] });
  const device = await pair(a, b, { management: true });
  const call = input => a.link.callDevice({ deviceId: device.id, input: { action: 'management', ...input } });
  const prepare = async (requestId, value = 4) => {
    const snapshot = await call({ operation: 'settings-read', namespace: 'benchgo-link-relay' });
    return { operation: 'settings-prepare', requestId, namespace: 'benchgo-link-relay', expected: { fingerprint: snapshot.fingerprint }, ops: [{ op: 'set', path: ['nodes', '0', 'priority'], value }] };
  };
  const request = await prepare('rejected');
  const pending = await call(request);
  await assert.rejects(call({ ...request, ops: [{ ...request.ops[0], value: 9 }] }), { code: 'SETTINGS_IDEMPOTENCY_CONFLICT' });
  const rejected = await b.deviceApi({ action: 'hostManagementDecide', operationId: pending.id, allow: false });
  assert.equal(rejected.state, 'rejected');
  assert.equal((await b.deviceApi({ action: 'hostManagementDecide', operationId: pending.id, allow: true })).state, 'rejected');
  assert.equal((await call(request)).state, 'rejected');
  assert.equal(b.link.status().relay.nodes[0].priority, 0);

  const conflict = await call(await prepare('conflict'));
  await b.link.admin({ action: 'relay-pool-configure', nodes: [{ id: 'only', url: 'https://relay.example', priority: 2, enabled: false }] });
  const failed = await b.deviceApi({ action: 'hostManagementDecide', operationId: conflict.id, allow: true });
  assert.equal(failed.state, 'failed'); assert.equal(failed.error.code, 'REVISION_CONFLICT');
  assert.equal(b.link.status().relay.nodes[0].priority, 2);
  const revoked = await call(await prepare('revoked'));
  await b.link.admin({ action: 'grant-device', id: b.link.status().devices[0].id, management: false });
  assert.equal((await b.deviceApi({ action: 'hostManagementDecide', operationId: revoked.id, allow: true })).state, 'revoked');
  await assert.rejects(call({ operation: 'operation', operationId: revoked.id }), { code: 'UNAUTHORIZED' });
  await assert.rejects(a.link.callDevice({ deviceId: device.id, input: { action: 'admin', operation: 'relay-pool-configure' } }), { code: 'UNSUPPORTED' });
  assert.equal(b.link.status().relay.nodes[0].priority, 2);
});

test('completed management receipts do not permanently exhaust the bounded operation queue', async t => {
  const completed = Array.from({ length: 128 }, (_, i) => ({ id: `old-${i}`, requestId: `old-request-${i}`, deviceId: 'retired-device', state: 'applied', createdAt: i, expiresAt: Date.now() + 60000 }));
  const a = await host(t, 'A', []), b = await host(t, 'B', [], undefined, { managementOperations: completed });
  await b.link.admin({ action: 'relay-pool-configure', nodes: [{ id: 'only', url: 'https://relay.example', token: 'private-relay-secret', priority: 0, enabled: false }] });
  const device = await pair(a, b, { management: true });
  const call = input => a.link.callDevice({ deviceId: device.id, input: { action: 'management', ...input } });
  const snapshot = await call({ operation: 'settings-read', namespace: 'benchgo-link-relay' });
  const request = { operation: 'settings-prepare', requestId: 'next-change', namespace: 'benchgo-link-relay', expected: { fingerprint: snapshot.fingerprint }, ops: [{ op: 'set', path: ['nodes', '0', 'priority'], value: 3 }] };
  const pending = await call(request);
  assert.equal(pending.state, 'pending');
  assert.equal((await call(request)).operationId, pending.operationId);
  assert.equal(b.link.status().pendingManagement.length, 1);
  assert.equal(b.link.status().relay.nodes[0].priority, 0);
  const saved = JSON.parse(await readFile(join(b.directory, 'devices.json'), 'utf8'));
  assert.equal(saved.managementOperations.length, 128);
  assert.equal(saved.managementOperations.some(row => row.id === 'old-0'), false);
  assert.equal(saved.managementOperations.some(row => row.id === 'old-127'), true);
});
