import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceResources, projectResources, deviceConnectionFailure } from '../src/devices/resources.mjs';
import { openDeviceRegistry } from '../src/devices/registry.mjs';
import { hash, openStore } from '../src/pairing/store.mjs';
import { loadIdentity } from '../src/transport/tls.mjs';
import { createServer } from 'node:https';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const registry = { list: () => ({ activeId: 'local', devices: [{ id: 'local' }, { id: 'a' }, { id: 'b' }] }), get: id => ({ id, token: 'never-return', url: 'https://example.test', hostId: 'host' }), mark() {} };
function mutableRegistry() {
  return {
    device: { id: 'a', url: 'https://example.test', pin: '', token: 'test-token', hostId: 'host', authorizationId: 'grant', status: 'offline' }, marks: [],
    get(id) { if (id !== this.device?.id) throw new Error('设备不存在'); return this.device; },
    list() { return { activeId: 'local', devices: [{ id: 'local', status: 'online' }, ...(this.device ? [{ ...this.device, token: undefined }] : [])] }; },
    mark(id, status, lastError) { Object.assign(this.get(id), { status, lastError }); this.marks.push(status); },
  };
}
const resourceResult = () => ({ value: { available: true, hostId: 'host', items: [{ resourceId: 'project' }] } });

test('legacy records recover both identities using the saved pair and retain their directory ID', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-identity-'));
  const registry = await openDeviceRegistry(directory);
  const pin = Buffer.alloc(32, 1).toString('base64'), hostId = 'sha256:' + pin;
  const record = await registry.upsert({ name: 'B', url: 'https://example.test', pin, token: 'existing-token' });
  const paths = [];
  const service = createDeviceResources({ registry, route: async target => target, request: async (target, path, input) => {
    assert.equal(target.token, 'existing-token');
    paths.push(path);
    if (path === '/link/api/info') return { value: { hostId } };
    assert.equal(input.operation, 'catalog');
    return { value: { hostId, authorizationId: 'paired-a' } };
  } });
  t.after(async () => { service.clear(); await rm(directory, { recursive: true, force: true }); });
  const resolve = () => service.resolveDeviceIdentity({ deviceId: record.id });
  const [first, second] = await Promise.all([resolve(), resolve()]);
  assert.equal(first.hostId, hostId);
  assert.equal(first.authorizationId, 'paired-a');
  assert.equal(first.id, record.id);
  assert.equal(first.token, undefined);
  assert.deepEqual(first, second);
  assert.deepEqual(paths, ['/link/api/info', '/link/api/rpc']);
  const reopened = await openDeviceRegistry(directory);
  assert.equal(reopened.get(record.id).authorizationId, 'paired-a');
  assert.equal(deviceConnectionFailure({ code: 'EXECUTION_OWNER_CHANGED', status: 403 }).status, 'online');
});
test('session writes require the displayed identity and reject re-pairing before probing or sending', async t => {
  const saved = mutableRegistry(), calls = [];
  const service = createDeviceResources({ registry: saved, route: async value => { calls.push('route'); return value; }, request: async (_target, _path, input) => { calls.push(input); return { value: { accepted: true } }; } });
  t.after(() => service.clear());
  const input = { action: 'sessionAction', id: 'session', native: false, operation: 'pin', requestId: `sa:${Date.now()}:request` };
  const call = extra => service.callDevice({ deviceId: 'a', input, ...extra });
  await assert.rejects(call({}), { code: 'INVALID_SESSION_ACTION' });
  await assert.rejects(call({ expectedHostId: null, expectedAuthorizationId: null }), { code: 'IDENTITY_CHANGED' });
  const expected = { expectedHostId: 'host', expectedAuthorizationId: 'grant' };
  saved.device.authorizationId = 'new-grant';
  await assert.rejects(call(expected), { code: 'IDENTITY_CHANGED' }); assert.deepEqual(calls, []);
  assert.equal((await call({ ...expected, expectedAuthorizationId: 'new-grant' })).accepted, true);
  assert.deepEqual(calls, ['route', input]); assert.equal(calls[1].expectedHostId, undefined);
  saved.device.hostId = 'other-host';
  await assert.rejects(call({ ...expected, expectedAuthorizationId: 'new-grant' }), { code: 'IDENTITY_CHANGED' });
  assert.equal(calls.length, 2);
});

test('identity changes while selecting a route stop a session write before transmission', async t => {
  const saved = mutableRegistry(), calls = [];
  const service = createDeviceResources({ registry: saved, route: async value => { saved.device.authorizationId = 'replaced-during-route'; return value; }, request: async () => { calls.push('sent'); return { value: {} }; } });
  t.after(() => service.clear());
  await assert.rejects(service.callDevice({ deviceId: 'a', expectedHostId: 'host', expectedAuthorizationId: 'grant', input: { action: 'sessionAction', id: 'session', native: false, operation: 'pin', requestId: `sa:${Date.now()}:request` } }), { code: 'IDENTITY_CHANGED' });
  assert.deepEqual(calls, []);
});
test('resource pages preserve opaque identities, ownership and bounded filtered coverage', () => {
  const result = projectResources({ sessions: [{ id: 'same', projectId: 'p', title: 'x', token: 'secret' }, { id: 'same', projectId: 'q' }] }, { kind: 'sessions', projectId: 'p', limit: 1 }, 'a');
  assert.equal(result.items[0].resourceId, 'same'); assert.equal(result.items[0].deviceId, 'a');
  assert.equal(result.items[0].token, undefined); assert.equal(result.total, 1); assert.equal(result.hasMore, false);
  assert.throws(() => projectResources({}, { limit: 101 }, 'a'));
});

test('recent pages rank all native and official candidates by source activity before pagination', () => {
  const sessions = [{ id: 'official-old', updatedAt: 10 }, { id: 'native-new', native: true, updatedAt: 30 }, { id: 'middle', updatedAt: 20 }, { id: 'invalid', updatedAt: 'bad' }];
  const first = projectResources({ sessions }, { kind: 'recent', limit: 2 }, 'a');
  assert.deepEqual(first.items.map(row => row.id), ['native-new', 'middle']);
  assert.equal(first.hasMore, true);
  assert.deepEqual(projectResources({ sessions }, { kind: 'recent', offset: 2, limit: 2 }, 'a').items.map(row => row.id), ['official-old', 'invalid']);
  assert.equal(sessions[0].id, 'official-old');
});
test('session and recent pages filter archives and sort pins across the full candidate set before slicing', () => {
  const sessions = [
    ...Array.from({ length: 35 }, (_, i) => ({ id: `archived-${i}`, projectId: 'p', archived: true, updatedAt: 100 + i })),
    { id: 'old', projectId: 'p', updatedAt: 10 },
    { id: 'new', projectId: 'p', updatedAt: 30, provider: 'opaque/Provider', model: 'Opaque:model@1', status: 'waiting', token: 'secret' },
    { id: 'other', projectId: 'q', pinned: true, updatedAt: 1000 },
    { id: 'pin', projectId: 'p', native: true, pinned: true, updatedAt: 1 },
    { id: 'middle', projectId: 'p', updatedAt: 20 },
  ];
  for (const kind of ['sessions', 'recent']) {
    const input = { kind, projectId: 'p', archived: false, limit: 2 };
    const first = projectResources({ sessions }, input, 'a'), second = projectResources({ sessions }, { ...input, offset: 2 }, 'a');
    assert.deepEqual(first.items.map(row => row.id), ['pin', 'new']);
    assert.deepEqual(second.items.map(row => row.id), ['middle', 'old']);
    assert.equal(first.total, 4); assert.equal(first.hasMore, true); assert.equal(second.hasMore, false);
    assert.equal(first.items[1].provider, 'opaque/Provider'); assert.equal(first.items[1].model, 'Opaque:model@1');
    assert.equal(first.items[1].status, 'waiting'); assert.equal(first.items[1].token, undefined);
    const archived = projectResources({ sessions }, { ...input, archived: true, limit: 30 }, 'a');
    assert.equal(archived.total, 35); assert.equal(archived.items.length, 30); assert.equal(archived.hasMore, true);
  }
  assert.equal(sessions[0].id, 'archived-0', 'sorting does not mutate the source');
  assert.throws(() => projectResources({ sessions }, { kind: 'sessions', archived: 'false' }, 'a'), { code: 'INVALID_RESOURCE_QUERY' });
});
test('resource RPC forwards archive selection and isolates stale pages by archive filter', async t => {
  const saved = mutableRegistry(), calls = [];
  const sessions = [{ id: 'visible', projectId: 'p', provider: 'tool/Exact', model: 'M@1', status: 'failed', updatedAt: 2 }, { id: 'hidden', projectId: 'p', archived: true, updatedAt: 1 }];
  let offline = false;
  const service = createDeviceResources({ registry: saved, route: async value => value, request: async (_target, _path, input) => {
    calls.push(input);
    if (offline) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
    return { value: projectResources({ sessions }, input, 'local') };
  } });
  t.after(() => service.clear());
  const query = { deviceId: 'a', kind: 'sessions', projectId: 'p', limit: 1 };
  const visible = (await service.resources({ ...query, archived: false })).devices[0];
  const hidden = (await service.resources({ ...query, archived: true })).devices[0];
  assert.deepEqual(calls.map(row => row.archived), [false, true]);
  assert.equal(calls[0].projectId, 'p');
  assert.equal(visible.items[0].provider, 'tool/Exact'); assert.equal(visible.items[0].model, 'M@1'); assert.equal(visible.items[0].status, 'failed');
  assert.equal(hidden.items[0].id, 'hidden');
  offline = true;
  const staleVisible = (await service.resources({ ...query, archived: false })).devices[0];
  const staleHidden = (await service.resources({ ...query, archived: true })).devices[0];
  assert.equal(staleVisible.freshness, 'stale'); assert.equal(staleHidden.freshness, 'stale');
  assert.deepEqual(staleVisible.items.map(row => row.id), ['visible']); assert.deepEqual(staleHidden.items.map(row => row.id), ['hidden']);
});
test('legacy state fallback applies project and archive filters before pagination', async t => {
  const calls = [], saved = mutableRegistry();
  const sessions = [{ id: 'old', projectId: 'p', updatedAt: 1 }, { id: 'archive', projectId: 'p', archived: true, updatedAt: 100 }, { id: 'new', projectId: 'p', updatedAt: 2 }, { id: 'other', projectId: 'q' }];
  const service = createDeviceResources({ registry: saved, route: async value => value, request: async (_target, _path, input) => {
    calls.push(input);
    if (input.action === 'resources') throw Object.assign(new Error('Unsupported Link action'), { statusCode: 400 });
    return { value: { sessions } };
  } });
  t.after(() => service.clear());
  const page = (await service.resources({ deviceId: 'a', kind: 'sessions', projectId: 'p', archived: false, limit: 1, offset: 1 })).devices[0];
  assert.deepEqual(calls.map(row => row.action), ['resources', 'state']);
  assert.equal(page.total, 2); assert.equal(page.hasMore, false); assert.deepEqual(page.items.map(row => row.id), ['old']);
});
test('queries isolate unavailable devices and retain stale bounded summaries', async () => {
  let offline = false;
  const service = createDeviceResources({ registry, route: async value => value, request: async target => {
    if (target.id === 'b' || offline) throw Object.assign(new Error('private diagnostic'), { code: 'ECONNREFUSED' });
    return { value: { available: true, items: [{ resourceId: 'same' }], hostId: 'host' } };
  }, local: () => projectResources({ projects: [] }, { kind: 'projects' }, 'local') });
  let result = await service.resources({ kind: 'projects' });
  assert.equal(result.partial, true); assert.equal(result.devices[0].available, true);
  assert.equal(result.devices[1].items[0].deviceId, 'a'); assert.equal(result.devices[2].freshness, 'unknown');
  offline = true; result = await service.resources({ deviceId: 'a' });
  assert.equal(result.devices[0].freshness, 'stale'); assert.equal(result.devices[0].items.length, 1);
  assert.equal(JSON.stringify(result).includes('private diagnostic'), false);
});
test('untrusted identity changes clear cached rows and cancellation propagates', async () => {
  const service = createDeviceResources({ registry, route: async value => value, request: async () => ({ value: { available: true, items: [{}], hostId: 'other-host' } }) });
  const result = await service.resources({ deviceId: 'a' });
  assert.equal(result.devices[0].code, 'IDENTITY_CHANGED'); assert.deepEqual(result.devices[0].items, []);
  await assert.rejects(service.resources({ signal: AbortSignal.abort() }));
  await assert.rejects(service.callDevice({ deviceId: 'a', input: { action: 'arbitrary-admin' } }), { code: 'UNSUPPORTED' });
});
test('resource success restores online while business errors and authorization failures stay distinct', async t => {
  const saved = mutableRegistry(); let failure;
  const service = createDeviceResources({ registry: saved, route: async value => value, request: async () => { if (failure) throw failure; return resourceResult(); } });
  t.after(() => service.clear());
  assert.equal((await service.resources({ deviceId: 'a' })).devices[0].available, true);
  assert.equal(saved.device.status, 'online'); assert.equal(saved.device.lastError, null);
  failure = Object.assign(new Error('private'), { statusCode: 422 });
  assert.equal((await service.resources({ deviceId: 'a' })).devices[0].code, 'UNSUPPORTED');
  assert.equal(saved.device.status, 'online');
  failure = Object.assign(new Error('private'), { statusCode: 500 });
  assert.equal((await service.resources({ deviceId: 'a' })).devices[0].code, 'QUERY_FAILED');
  assert.equal(saved.device.status, 'online');
  failure = Object.assign(new Error('private'), { code: 'ECONNREFUSED' });
  const offline = (await service.resources({ deviceId: 'a' })).devices[0];
  assert.equal(offline.code, 'OFFLINE'); assert.equal(offline.freshness, 'stale'); assert.equal(saved.device.status, 'offline');
  failure = null; await service.resources({ deviceId: 'a' }); assert.equal(saved.device.status, 'online');
  failure = Object.assign(new Error('private'), { statusCode: 403 });
  const unauthorized = (await service.resources({ deviceId: 'a' })).devices[0];
  assert.equal(unauthorized.code, 'UNAUTHORIZED'); assert.deepEqual(unauthorized.items, []); assert.equal(saved.device.status, 'failed');
  assert.deepEqual(deviceConnectionFailure({ code: 'ROUTES_COOLDOWN', status: 503 }), { code: 'ROUTES_COOLDOWN', status: 'connecting', reason: '中继连接正在恢复，请稍后重试或在设备中心检查连接' });
  assert.equal(deviceConnectionFailure({ code: 'ERR_LINK_CERTIFICATE' }).status, 'failed');
  assert.equal(deviceConnectionFailure(new Error('query failed')).status, null);
});
test('concurrent queries share selection and the bounded agent, and network failure does not replay RPCs', async t => {
  const saved = mutableRegistry(), agents = []; let selections = 0, calls = 0, release;
  const selection = new Promise(resolve => { release = resolve; });
  const service = createDeviceResources({ registry: saved, route: async value => { selections++; await selection; return value; }, request: async (_target, _path, _input, options) => { calls++; agents.push(options.agent); return resourceResult(); } });
  t.after(() => service.clear());
  const projects = service.resources({ deviceId: 'a', kind: 'projects' }), recent = service.resources({ deviceId: 'a', kind: 'recent' });
  release(); await Promise.all([projects, recent]); await service.resources({ deviceId: 'a' });
  assert.equal(selections, 1); assert.equal(calls, 3); assert.equal(new Set(agents).size, 1);
  assert.equal(agents[0].maxSockets, 4); assert.equal(agents[0].maxFreeSockets, 2);
  service.invalidate('a'); await service.resources({ deviceId: 'a' });
  assert.equal(selections, 2); assert.notEqual(agents[0], agents.at(-1));
  let sent = 0;
  const writes = createDeviceResources({ registry: saved, route: async value => value, request: async () => { sent++; throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); } });
  t.after(() => writes.clear());
  await assert.rejects(writes.callDevice({ deviceId: 'a', input: { action: 'send', text: 'once' } }), { code: 'ECONNRESET' });
  assert.equal(sent, 1);
});
test('caller cancellation leaves a shared route alive and never marks the device offline', async t => {
  const saved = mutableRegistry(); let release;
  const selection = new Promise(resolve => { release = resolve; });
  const service = createDeviceResources({ registry: saved, route: async value => { await selection; return value; }, request: async () => resourceResult() });
  t.after(() => service.clear());
  const controller = new AbortController();
  const canceled = service.resources({ deviceId: 'a', signal: controller.signal });
  const healthy = service.resources({ deviceId: 'a', kind: 'recent' });
  controller.abort(); await assert.rejects(canceled, { name: 'AbortError' });
  assert.deepEqual(saved.marks, []);
  release(); assert.equal((await healthy).devices[0].available, true); assert.deepEqual(saved.marks, ['online']);
});
test('late failures cannot overwrite a newer success, and replaced or removed identities cannot receive old data', async t => {
  const saved = mutableRegistry(); let rejectOld, resolveOld, pending = 'fail';
  const service = createDeviceResources({ registry: saved, route: async value => value, request: async () => {
    if (pending) { pending = null; return new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }); }
    return resourceResult();
  } });
  t.after(() => service.clear());
  const old = service.resources({ deviceId: 'a' });
  while (!rejectOld) await new Promise(resolve => setImmediate(resolve));
  await service.resources({ deviceId: 'a', kind: 'recent' });
  rejectOld(Object.assign(new Error('late reset'), { code: 'ECONNRESET' })); await old;
  assert.equal(saved.device.status, 'online');
  pending = 'replace'; resolveOld = null;
  const replaced = service.resources({ deviceId: 'a' });
  while (!resolveOld) await new Promise(resolve => setImmediate(resolve));
  saved.device = { ...saved.device, token: 'new-token', authorizationId: 'new-grant', status: 'unknown' };
  await service.resources({ deviceId: 'a', kind: 'recent' }); const marks = saved.marks.length;
  resolveOld(resourceResult()); const stale = (await replaced).devices[0];
  assert.equal(stale.code, 'IDENTITY_CHANGED'); assert.deepEqual(stale.items, []); assert.equal(saved.marks.length, marks);
  pending = 'remove'; resolveOld = null;
  const removed = service.resources({ deviceId: 'a' });
  while (!resolveOld) await new Promise(resolve => setImmediate(resolve));
  saved.device = null; service.invalidate('a'); resolveOld(resourceResult());
  assert.equal((await removed).devices[0].code, 'NOT_FOUND');
});
test('clear cancels late results and real TLS queries reuse a socket until explicitly released', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'link-resource-pool-'));
  const identity = await loadIdentity(directory), saved = mutableRegistry(); let handshakes = 0;
  const server = createServer({ key: identity.key, cert: identity.cert }, (req, res) => { req.resume(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(resourceResult().value)); });
  server.on('secureConnection', () => handshakes++);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  Object.assign(saved.device, { url: 'https://127.0.0.1:' + server.address().port, pin: identity.pin });
  const service = createDeviceResources({ registry: saved, route: async value => value });
  t.after(async () => { service.clear(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  assert.equal((await service.resources({ deviceId: 'a' })).devices[0].available, true);
  assert.equal((await service.resources({ deviceId: 'a', kind: 'recent' })).devices[0].available, true);
  assert.equal(handshakes, 1);
  service.clear(); await service.resources({ deviceId: 'a' }); assert.equal(handshakes, 2);
  let release; const waiting = createDeviceResources({ registry: saved, route: async value => value, request: async () => new Promise(resolve => { release = resolve; }) });
  const late = waiting.resources({ deviceId: 'a' });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const marks = saved.marks.length; waiting.clear(); release(resourceResult());
  await assert.rejects(late, { name: 'AbortError' }); assert.equal(saved.marks.length, marks);
});
test('pairing approval uniformly enables collaboration and management while token revocation denies access', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'link-grants-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const pair = store.begin();
  const pending = store.request(pair.code, 'new');
  assert.deepEqual(store.pending()[0].capabilities, ['collaboration','management']);
  assert.equal(store.state.devices.length, 0, 'generating and requesting pairing does not authorize the new device');
  assert.equal(store.authenticate('unpaired-token'),undefined);
  await store.decide(pending.requestId, true);
  const approved = store.poll(pending.requestId, pending.pollToken);
  assert.deepEqual(store.authenticate(approved.token).capabilities, ['collaboration','management']);
  const restored = await openStore(directory);
  assert.deepEqual(restored.authenticate(approved.token).capabilities, ['collaboration','management']);
  assert.equal(Object.hasOwn(restored.state.devices[0],'capabilities'),false,'capabilities are protocol projection, not a second persisted permission switch');
  await restored.revoke(approved.deviceId);
  assert.equal(restored.authenticate(approved.token),undefined);
  assert.equal((await openStore(directory)).authenticate(approved.token),undefined);
});

test('old approved devices converge to the paired permission boundary and obsolete grant fields are retired', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'link-legacy-grants-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const devices = [{ id: 'empty', tokenHash: hash('legacy-empty'), capabilities: [] }, { id: 'missing', tokenHash: hash('legacy-missing') }, { id: 'limited', tokenHash: hash('legacy-limited'), capabilities: ['collaboration'] }];
  const expected=devices.map(({capabilities,...device})=>device);
  await writeFile(join(directory, 'devices.json'), JSON.stringify({ devices }));
  const store = await openStore(directory);
  assert.deepEqual(store.state.devices, expected);
  assert.deepEqual((await openStore(directory)).state.devices, expected,'retired permission fields are removed by the ordinary durable store');
  for (const id of ['empty', 'missing', 'limited']) {
    assert.deepEqual(store.authenticate(`legacy-${id}`).capabilities, ['collaboration', 'management']);
  }
  assert.equal(store.authenticate('legacy-wrong'), undefined);
  await store.revoke('empty');
  assert.equal(store.authenticate('legacy-empty'), undefined);
  const restored = await openStore(directory);
  assert.equal(restored.authenticate('legacy-empty'), undefined);
  assert.deepEqual(restored.authenticate('legacy-missing').capabilities, ['collaboration', 'management']);
});
