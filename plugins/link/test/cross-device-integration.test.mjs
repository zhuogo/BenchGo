import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountLink } from '../src/index.mjs';
import { mountWeb } from '../../base/src/web.mjs';

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
  const link = await mountLink(ctx, { directory, env: {}, testRelayConnection: async () => ({ ok: true }) });
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

async function pair(source, target) {
  const invitation = await target.link.admin({ action: 'pairing', mode: 'lan' });
  const pending = await source.deviceApi({ action: 'pair', uri: invitation.uri });
  const requests = target.link.status().pending;
  assert.equal(requests.length, 1);
  await target.link.admin({ action: 'confirm', id: requests[0].id });
  const result = await source.deviceApi({ action: 'pairStatus', requestId: pending.requestId });
  assert.equal(result.status, 'approved');
  const saved = JSON.parse(await readFile(join(source.directory, 'outgoing', 'connections.json'), 'utf8')).devices.find(row => row.id === result.device.id);
  assert.equal(saved.routes.some(route => route.kind === 'direct' && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.url).hostname)), false, 'remote route advertisements must not include the host loopback');
  assert.equal(new URL(saved.url).hostname, '127.0.0.1', 'explicit local pairing endpoint remains usable independently of advertised routes');
  return result.device;
}

async function sessionHost(t, name) {
  const project = { id: 'same-project', title: `${name} project`, path: `/${name}/work`, sessionIds: ['same-session'] };
  const hidden = new Set(), hostValue = await host(t, name, [project], { sidebarPrivateSessionIds: async () => [...hidden] });
  const calls = [], rows = [{ sessionId: 'same-session', updatedAt: 10, projections: { values: { title: `${name} session` } } }];
  const nativeRows = new Map([['same-native', { id: 'same-native', projectId: project.id, cwd: project.path, ownerSessionId: 'commander-web:detached:owner', provider: 'codex', status: 'idle' }]]);
  const commander = {
    list: () => [...nativeRows.values()],
    async archive(id, archived) { calls.push(['native', archived ? 'archive' : 'unarchive', id]); nativeRows.get(id).archived = archived; },
    async remove(id) { calls.push(['native', 'delete', id]); nativeRows.delete(id); },
  };
  const services = { commander, benchgo: { directory: join(hostValue.directory, '..') }, sessionTitle: {}, sessionController: { rename() {} }, workspaceController: Object.fromEntries(['pinSession', 'unpinSession', 'archiveSession', 'unarchiveSession'].map(method => [method, () => {}])) };
  const get = hostValue.ctx.get;
  hostValue.ctx.get = name => services[name] ?? get(name);
  hostValue.ctx.connection.createPeer = () => ({ dispose() {} });
  hostValue.ctx.connection.createSharedFetchHandler = () => ({ fetch: request => hostValue.routes.find(route => route.path === new URL(request.url).pathname).fetch(request) });
  hostValue.ctx.typertGateway = {
    async invoke({ namespace, method, args }) {
      if (method === 'list') return { items: rows };
      calls.push([namespace, method, args.request]);
      if (method === 'rename') { rows[0].projections.values.title = args.request.title; return { title: args.request.title }; }
      const key = ['pinSession', 'unpinSession'].includes(method) ? 'pinnedSessionIds' : 'archivedSessionIds';
      const ids = hostValue.ctx.workspaceRegistry[key] ?? [];
      hostValue.ctx.workspaceRegistry[key] = ['pinSession', 'archiveSession'].includes(method) ? [...new Set([...ids, args.request.sessionId])] : ids.filter(id => id !== args.request.sessionId);
      return {};
    },
    wireStream: { open: async (_endpoint, _payload, _uplink, _peer, signal) => (async function* () {
      yield { type: 'ready', clientId: 'client' };
      await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    })() },
  };
  await mountWeb(hostValue.ctx, { directory: services.benchgo.directory, mountFonts: async () => {} });
  const ownerApi = async input => {
    const route = hostValue.routes.find(route => route.path === '/api/commander-devices');
    const response = await route.fetch(new Request('http://127.0.0.1' + route.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }));
    return { status: response.status, value: await response.json() };
  };
  return { ...hostValue, calls, rows, hidden, nativeRows, ownerApi };
}

test('owner session actions cross real TLS to only the resource device with durable intent and live authorization', async t => {
  const a = await sessionHost(t, 'A'), b = await sessionHost(t, 'B');
  const device = await pair(a, b);
  let displayedDevice = (await a.link.devices()).devices.find(row => row.id === device.id);
  const issuedAt = Date.now(), call = input => a.ownerApi({ action: 'sessionAction', deviceId: device.id, expectedHostId: displayedDevice.hostId ?? null, expectedAuthorizationId: displayedDevice.authorizationId ?? null, native: false, id: 'same-session', ...input, requestId: `sa:${issuedAt}:${input.requestId}` });
  const capabilities = (await a.link.resources({ deviceId: device.id, kind: 'capabilities' })).devices[0].items;
  assert.deepEqual(capabilities.find(row => row.id === 'sessionActions').operations, ['pin', 'unpin', 'archive', 'unarchive', 'rename', 'delete']);
  assert.deepEqual(capabilities.find(row => row.id === 'nativeSessionActions').operations, ['archive', 'unarchive', 'delete']);
  assert.equal(capabilities.find(row => row.id === 'management').available, true, 'pairing approval uniformly grants supported BenchGo management');
  const pin = { operation: 'pin', requestId: 'same-pin' };
  assert.equal((await call(pin)).status, 200); assert.equal((await call(pin)).status, 200);
  assert.deepEqual(b.ctx.workspaceRegistry.pinnedSessionIds, ['same-session']); assert.equal(b.calls.length, 1); assert.deepEqual(a.calls, []);
  assert.equal((await call({ ...pin, operation: 'unpin' })).status, 409);
  for (const operation of ['pin', 'unpin', 'archive', 'unarchive']) assert.equal((await call({ operation, requestId: operation + '-next' })).status, 200);
  assert.deepEqual(b.ctx.workspaceRegistry.pinnedSessionIds, []); assert.deepEqual(b.ctx.workspaceRegistry.archivedSessionIds, []);
  const rename = { operation: 'rename', requestId: 'rename-once', title: 'B 新名称', method: 'arbitraryRPC', principal: { kind: 'owner' } };
  assert.equal((await call(rename)).value.title, 'B 新名称'); assert.equal((await call(rename)).status, 200);
  assert.equal(b.rows[0].projections.values.title, 'B 新名称'); assert.equal(a.rows[0].projections.values.title, 'A session');
  assert.equal(b.calls.filter(row => row[1] === 'rename').length, 1);
  let count = b.calls.length;
  b.hidden.add('same-session'); assert.equal((await call(rename)).status, 404); b.hidden.clear();
  for (const input of [{ operation: 'fork' }, { operation: 'arbitraryRPC' }, { id: 'native:same-native', native: true, operation: 'rename', title: 'No' }]) {
    const response = await call({ requestId: 'unsupported-' + input.operation + (input.id ?? ''), ...input });
    assert.equal(response.status, 422); assert.equal(response.value.code, 'UNSUPPORTED');
  }
  assert.equal(b.calls.length, count);
  assert.equal((await a.ownerApi({ action: 'sessionAction', id: 'same-session', operation: 'pin', requestId: 'missing-device' })).status, 400);
  assert.equal((await a.ownerApi({ action: 'sessionAction', deviceId: device.id, id: 'same-session', native: false, operation: 'pin', requestId: `sa:${issuedAt}:missing-identity` })).status, 400);
  assert.equal((await call({ id: 'native:same-native', native: true, operation: 'archive', requestId: 'archive-native' })).status, 200);
  const archived = (await a.link.resources({ deviceId: device.id, kind: 'sessions', archived: true })).devices[0].items;
  assert.deepEqual(archived.map(row => row.id), ['native:same-native']);
  const deleted = { operation: 'delete', requestId: 'delete-once' };
  assert.equal((await call(deleted)).value.deleted, true); assert.equal((await call(deleted)).status, 200);
  assert.equal(b.rows.length, 1, 'official history is retained');
  assert.deepEqual(JSON.parse(await readFile(join(b.directory, '..', 'dismissed-harness.json'), 'utf8')), ['same-session']);
  for (const archived of [false, true]) assert.equal((await a.link.resources({ deviceId: device.id, kind: 'sessions', archived })).devices[0].items.some(row => row.id === 'same-session'), false);
  count = b.calls.length;
  const pairedAgain = await pair(a, b);
  assert.equal(pairedAgain.id, device.id, 're-pairing retains the directory identity while replacing its authorization');
  assert.equal((await call({ id: 'native:same-native', native: true, operation: 'unarchive', requestId: 'stale-ui-grant' })).status, 409);
  assert.equal(b.calls.length, count);
  displayedDevice = (await a.link.devices()).devices.find(row => row.id === device.id);
  assert.equal((await call({ id: 'native:same-native', native: true, operation: 'unarchive', requestId: 'refreshed-ui-grant' })).status, 200);
  count = b.calls.length;
  await b.link.admin({ action: 'revoke', id: displayedDevice.authorizationId });
  const revoked = await call({ id: 'native:same-native', native: true, operation: 'unarchive', requestId: 'after-revoke' });
  assert.equal(revoked.status, 401); assert.match(revoked.value.error, /授权|配对|Unauthorized/i); assert.equal(b.calls.length, count); assert.deepEqual(a.calls, []);
});

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
  assert.deepEqual(a.link.status().devices[0].capabilities, ['collaboration', 'management']);
  assert.deepEqual(b.link.status().devices[0].capabilities, ['collaboration', 'management']);
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
    { id: 'native-default', ownerSessionId: 'commander-web:detached:owner', projectId: 'default', cwd: '/default', provider: 'native-provider', updatedAt: 30 },
    { id: 'native-other', ownerSessionId: 'commander-web:detached:owner', projectId: 'other', cwd: '/other', provider: 'native-provider', updatedAt: 40 },
  ] } : get(name);
  b.ctx.connection.createPeer = () => ({ dispose() {} });
  b.ctx.typertGateway = {
    invoke: async call => {
      calls.push(call.method);
      if (call.method === 'list') return { items: [
        { sessionId: 'first', updatedAt: 10, projections: { values: { modelSelection: { next: { provider: 'Opaque/LLM', model: 'Model@1' } } } } },
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
    ['sessions', ['native:native-other', 'native:native-default', 'second', 'first']],
    ['recent', ['native:native-default', 'first']],
  ]) {
    calls.length = 0; projectReads = 0;
    const result = await a.link.resources({ deviceId: device.id, kind });
    assert.equal(result.devices[0].available, true);
    assert.deepEqual(result.devices[0].items.map(row => row.resourceId), expected);
    assert.equal(projectReads, 1, `${kind} shares its project snapshot with native sessions`);
    assert.deepEqual(calls, ['list']);
  }
  b.ctx.workspaceRegistry.archivedSessionIds = ['first'];
  b.ctx.workspaceRegistry.pinnedSessionIds = ['second'];
  const firstPage = (await a.link.resources({ deviceId: device.id, kind: 'sessions', archived: false, limit: 2 })).devices[0];
  const secondPage = (await a.link.resources({ deviceId: device.id, kind: 'sessions', archived: false, limit: 2, offset: 2 })).devices[0];
  assert.deepEqual(firstPage.items.map(row => row.id), ['second', 'native:native-other']);
  assert.deepEqual(secondPage.items.map(row => row.id), ['native:native-default']);
  assert.equal(firstPage.items[0].pinned, true); assert.equal(firstPage.total, 3); assert.equal(firstPage.hasMore, true); assert.equal(secondPage.hasMore, false);
  const archive = (await a.link.resources({ deviceId: device.id, kind: 'sessions', archived: true, limit: 1 })).devices[0];
  assert.deepEqual(archive.items.map(row => row.id), ['first']); assert.equal(archive.total, 1); assert.equal(archive.hasMore, false);
  assert.equal(archive.items[0].provider, 'deepseek'); assert.equal(archive.items[0].modelProvider, 'Opaque/LLM'); assert.equal(archive.items[0].model, 'Model@1');
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

test('execution works without SuperAgent and binds the real paired principal and target identity', async t => {
  const calls = [];
  const b = await host(t, 'B', []);
  b.ctx.get = name => name === 'benchgoExecution' ? { async dispatch(input, access) { calls.push({ input, access }); return { version: 2, available: true }; } } : undefined;
  const a = await host(t, 'A', []);
  const device = await pair(a, b);
  const input = { action: 'execution', version: 2, operation: 'catalog', principal: { kind: 'owner' } };
  const target = (await a.link.devices()).devices.find(row => row.id === device.id);
  const call = value => a.link.callDevice({ deviceId: device.id, expectedHostId: target.hostId, expectedAuthorizationId: target.authorizationId, input: value });
  const inboundId = b.link.status().devices[0].id;
  await assert.rejects(a.link.callDevice({ deviceId: device.id, input }), { code: 'INVALID_EXECUTION_IDENTITY' });
  const reply = await call(input);
  assert.equal(reply.available, true);
  assert.equal(reply.hostId, target.hostId); assert.equal(reply.authorizationId, target.authorizationId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.principal, undefined);
  assert.equal(calls[0].access.principal.kind, 'device');
  assert.equal(calls[0].access.principal.deviceId, inboundId);
  assert.deepEqual(calls[0].access.principal.capabilities, ['collaboration','management']);
  const capabilities = (await a.link.resources({ deviceId: device.id, kind: 'capabilities' })).devices[0].items;
  assert.equal(capabilities.find(item => item.id === 'execution').version, 2);
  assert.equal(capabilities.some(item => item.id === 'collaboration'), false);
  await assert.rejects(call({ action: 'collaboration', operation: 'delegate' }), { code: 'UNSUPPORTED' });
  assert.equal((await a.link.callDevice({ deviceId: device.id, input: { action: 'management', operation: 'status' } })).enabled,true);
  await b.link.admin({action:'revoke',id:inboundId});
  await assert.rejects(call(input),error=>error.statusCode===401);
  assert.equal(calls.length,1,'revoked pairing cannot invoke execution again');
});

test('remote relay changes require one exact local decision and preserve unrelated configuration', async t => {
  const a = await host(t, 'A', []), b = await host(t, 'B', []);
  for (const node of [
    { id: 'first', url: 'https://relay-one.example', token: 'test-first-secret' },
    { id: 'second', url: 'https://relay-two.example', token: 'test-second-secret' },
  ]) await b.link.admin({ action: 'relay-pool-configure', operation: 'add', expected: { fingerprint: b.link.status().relay.fingerprint }, ...node, enabled: false });
  const device = await pair(a, b);
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
  assert.deepEqual(b.link.status().relay.nodes.map(({ id, priority, enabled }) => ({ id, priority, enabled })), [
    { id: 'second', priority: 1, enabled: false }, { id: 'first', priority: 8, enabled: false },
  ]);
  assert.equal((await b.deviceApi({ action: 'hostManagementDecide', operationId: prepared.operationId, allow: true })).state, 'applied');
  assert.equal(b.link.status().pendingManagement.length, 0);
});

test('remote management rejects changed intent, owner refusal, stale CAS and revoked grants without applying', async t => {
  const a = await host(t, 'A', []), b = await host(t, 'B', []);
  await b.link.admin({ action: 'relay-pool-configure', operation: 'add', expected: { fingerprint: b.link.status().relay.fingerprint },
    id: 'only', url: 'https://relay.example', token: 'private-relay-secret', enabled: false });
  const device = await pair(a, b);
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
  await b.link.admin({ action: 'relay-pool-configure', operation: 'update', expected: { fingerprint: b.link.status().relay.fingerprint },
    id: 'only', token: 'replacement-relay-secret' });
  const failed = await b.deviceApi({ action: 'hostManagementDecide', operationId: conflict.id, allow: true });
  assert.equal(failed.state, 'failed'); assert.equal(failed.error.code, 'REVISION_CONFLICT');
  assert.equal(b.link.status().relay.nodes[0].priority, 0);
  const revoked = await call(await prepare('revoked'));
  await b.link.admin({ action: 'revoke', id: b.link.status().devices[0].id });
  assert.equal((await b.deviceApi({ action: 'hostManagementDecide', operationId: revoked.id, allow: true })).state, 'revoked');
  await assert.rejects(call({ operation: 'operation', operationId: revoked.id }), error=>error.statusCode===401);
  await assert.rejects(a.link.callDevice({ deviceId: device.id, input: { action: 'admin', operation: 'relay-pool-configure' } }), { code: 'UNSUPPORTED' });
  assert.equal(b.link.status().relay.nodes[0].priority, 0);
});

test('completed management receipts do not permanently exhaust the bounded operation queue', async t => {
  const completed = Array.from({ length: 128 }, (_, i) => ({ id: `old-${i}`, requestId: `old-request-${i}`, deviceId: 'retired-device', state: 'applied', createdAt: i, expiresAt: Date.now() + 60000 }));
  const a = await host(t, 'A', []), b = await host(t, 'B', [], undefined, { managementOperations: completed });
  await b.link.admin({ action: 'relay-pool-configure', operation: 'add', expected: { fingerprint: b.link.status().relay.fingerprint },
    id: 'only', url: 'https://relay.example', token: 'private-relay-secret', enabled: false });
  const device = await pair(a, b);
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
