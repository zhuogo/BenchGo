import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceResources, projectResources, deviceConnectionFailure } from '../src/devices/resources.mjs';
import { openStore } from '../src/pairing/store.mjs';
import { loadIdentity } from '../src/transport/tls.mjs';
import { createServer } from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
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
test('pairing grants are explicit, visible at approval, durable and independently revocable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'link-grants-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const legacyPair = store.begin(); const legacy = store.request(legacyPair.code, 'old');
  await store.decide(legacy.requestId, true);
  assert.deepEqual(store.poll(legacy.requestId, legacy.pollToken).capabilities, []);
  const pair = store.begin({ collaboration: true, management: true });
  const pending = store.request(pair.code, 'new');
  assert.deepEqual(store.pending()[0].capabilities, ['collaboration','management']);
  await store.decide(pending.requestId, true);
  const approved = store.poll(pending.requestId, pending.pollToken);
  assert.deepEqual(store.authenticate(approved.token).capabilities, ['collaboration','management']);
  await store.grantDevice(approved.deviceId, { management: false });
  const restored = await openStore(directory);
  assert.deepEqual(restored.authenticate(approved.token).capabilities, ['collaboration']);
});
