import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { openDeviceRegistry, normalizeRoutes } from '../src/devices/registry.mjs';
import { orderRoutes, selectRoute } from '../src/devices/routes.mjs';
import { probeRemote, remoteAgent, remoteJson } from '../src/devices/remote.mjs';
import { loadIdentity } from '../src/transport/tls.mjs';

const pin = Buffer.alloc(32, 1).toString('base64');
const direct = { kind: 'direct', url: 'https://direct.test:17770', pin };
const relay = { kind: 'relay', url: 'https://relay.test' };
const target = { url: relay.url, pin: '', token: 'private-token', routes: [relay, direct] };

test('pairing routes are bounded, strict HTTPS trust records without extra secrets', () => {
  assert.deepEqual(normalizeRoutes([direct, relay]), [direct, relay]);
  assert.deepEqual(normalizeRoutes([{ ...direct, url: direct.url + '/' }])[0], direct);
  for (const value of [null, {}, Array(17).fill(direct), [{ ...direct, pin: '' }], [{ ...relay, pin }], [{ ...relay, pin: '' }], [{ ...direct, token: 'secret' }], [{ ...relay, password: 'secret' }], [{ ...relay, url: 'http://relay.test' }], [{ ...relay, url: 'https://u:p@relay.test' }], [{ ...relay, url: 'https://relay.test/path' }], [{ ...direct, kind: 'unknown' }]]) assert.throws(() => normalizeRoutes(value));
});

test('relay metadata normalizes IDs, priority and health while preserving legacy routes', () => {
  const routes = normalizeRoutes([
    { kind: 'relay', id: 'backup', url: 'https://backup.test', priority: 20, health: 'degraded', cooldownUntil: 10, lastError: 'timeout' },
    { kind: 'relay', relayId: 'primary', url: 'https://primary.test', priority: 1, health: 'healthy' },
    relay,
  ]);
  assert.deepEqual(routes[0], { kind: 'relay', url: 'https://backup.test', relayId: 'backup', priority: 20, health: 'degraded', cooldownUntil: 10, lastError: 'timeout' });
  assert.deepEqual(routes[1], { kind: 'relay', url: 'https://primary.test', relayId: 'primary', priority: 1, health: 'healthy' });
  assert.deepEqual(routes[2], relay);
  for (const value of [{ ...relay, relayId: 'bad id' }, { ...relay, priority: -1 }, { ...relay, health: 'dead' }, { ...relay, cooldownUntil: -1 }, { ...relay, lastError: 'x'.repeat(201) }, { ...relay, id: 'a', relayId: 'b' }]) assert.throws(() => normalizeRoutes([value]));
});

test('relay order honors priority and skips active cooldowns without changing legacy order', () => {
  const now = Date.now();
  const routes = normalizeRoutes([
    { kind: 'relay', relayId: 'third', url: 'https://third.test', priority: 30 },
    { kind: 'relay', relayId: 'primary', url: 'https://primary.test', priority: 1, cooldownUntil: now + 60_000 },
    { kind: 'relay', relayId: 'backup', url: 'https://backup.test', priority: 10 },
  ]);
  assert.deepEqual(orderRoutes(routes, now).map(route => route.relayId), ['backup', 'third']);
  assert.deepEqual(orderRoutes(normalizeRoutes([relay, { ...relay, url: 'https://relay-2.test' }]), now).map(route => route.url), [relay.url, 'https://relay-2.test']);
});

test('registry persists approved route records without leaking them to the device list', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-routes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = await openDeviceRegistry(directory);
  const device = await registry.upsert({ ...target, name: '电脑' });
  assert.deepEqual(registry.get(device.id).routes, target.routes);
  assert.equal(JSON.stringify(registry.list()).includes(pin), false);
  assert.equal(JSON.stringify(registry.list()).includes('private-token'), false);
  const restored = await openDeviceRegistry(directory);
  assert.deepEqual(restored.get(device.id).routes, target.routes);
  await assert.rejects(registry.upsert({ ...target, routes: [{ ...relay, token: 'forged' }] }));
  assert.equal((JSON.parse(await readFile(join(directory, 'connections.json'), 'utf8'))).devices.length, 1);
});

test('registry updates relay health and cooldown without exposing route metadata publicly', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-health-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = await openDeviceRegistry(directory);
  const device = await registry.upsert({ ...target, routes: [{ ...relay, relayId: 'primary', priority: 1 }], name: '电脑' });
  const cooldownUntil = Date.now() + 30_000;
  await registry.markRouteHealth(device.id, 'primary', 'unhealthy', { cooldownUntil, lastError: 'timeout' });
  assert.equal(registry.get(device.id).routes[0].health, 'unhealthy');
  assert.equal(registry.get(device.id).routes[0].cooldownUntil, cooldownUntil);
  assert.equal(JSON.stringify(registry.list()).includes('unhealthy'), false);
  const restored = await openDeviceRegistry(directory);
  assert.equal(restored.get(device.id).routes[0].relayId, 'primary');
  await assert.rejects(registry.markRouteHealth(device.id, 'missing', 'healthy'), /中继路线不存在/);
});

test('route selection prioritizes fixed-pin direct and only falls back for unreachable networks', async () => {
  const calls = [];
  const selected = await selectRoute(target, { probe: async candidate => calls.push(candidate) });
  assert.equal(selected.url, direct.url); assert.equal(selected.token, target.token);
  assert.deepEqual(calls, [{ url: direct.url, pin }]);
  for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET']) {
    const calls = [];
    const selected = await selectRoute(target, { probe: async candidate => { calls.push(candidate); if (candidate.pin) throw Object.assign(new Error(code), { code }); } });
    assert.equal(selected.url, relay.url); assert.equal(selected.pin, '');
    assert.deepEqual(calls, [{ url: direct.url, pin }, { url: relay.url, pin: '' }]);
  }
});

test('an admitted public pairing endpoint remains usable after alternate routes fail', async () => {
  const url = 'https://paired.example.test', calls = [], accepted = [];
  const selected = await selectRoute({ ...target, url, pairedEndpointFallback: true }, {
    probe: async candidate => {
      calls.push(candidate.url);
      if (candidate.url !== url) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
    },
    accept: async (candidate, route) => accepted.push([candidate.url, route]),
  });
  assert.equal(selected.url, url);
  assert.deepEqual(calls, [direct.url, relay.url, url]);
  assert.deepEqual(accepted, [[url, undefined]]);
});

test('remote pairing never interprets the host loopback as a client-side direct route', async () => {
  for (const url of ['https://127.0.0.1:46117', 'https://127.12.0.1:46117', 'https://localhost:46117', 'https://[::1]:46117']) {
    const calls = [];
    const selected = await selectRoute({ ...target, routes: [{ kind: 'direct', url, pin }, relay] }, { probe: async candidate => calls.push(candidate.url) });
    assert.equal(selected.url, relay.url);
    assert.deepEqual(calls, [relay.url]);
  }
});

test('only the explicitly admitted local endpoint is allowed for local and SSH pairing', async () => {
  const url = 'https://127.0.0.1:46117', other = 'https://127.0.0.1:46118', calls = [];
  const selected = await selectRoute({ ...target, url, pin, routes: [{ kind: 'direct', url: other, pin }, { kind: 'direct', url, pin }, relay] }, { probe: async candidate => calls.push(candidate.url) });
  assert.equal(selected.url, url); assert.deepEqual(calls, [url]);
});

test('cooling remote relay reports recovery without probing or blaming another host loopback', async () => {
  const cooldownUntil = Date.now() + 60_000;
  await assert.rejects(selectRoute({ ...target, routes: [{ kind: 'direct', url: 'https://127.0.0.1:46117', pin }, { ...relay, cooldownUntil }] }, { probe: async () => assert.fail('must not probe a remote loopback or cooling relay') }), error => error.code === 'ROUTES_COOLDOWN' && error.retryAt === cooldownUntil && /连接正在恢复/.test(error.message));
  await assert.rejects(selectRoute({ ...target, routes: [{ kind: 'direct', url: 'https://127.0.0.1:46117', pin }] }, { probe: async () => assert.fail('must not probe a remote loopback') }), { code: 'OFFLINE' });
});

test('route selection fails over relays in configured priority order and stops after success', async () => {
  const relayOne = { kind: 'relay', url: 'https://relay-one.test' };
  const relayTwo = { kind: 'relay', url: 'https://relay-two.test' };
  const calls = [];
  const selected = await selectRoute({ ...target, routes: [direct, relayOne, relayTwo] }, {
    probe: async candidate => {
      calls.push(candidate.url);
      if (candidate.url !== relayTwo.url) throw Object.assign(new Error('unreachable'), { code: 'ETIMEDOUT' });
    },
  });
  assert.equal(selected.url, relayTwo.url);
  assert.deepEqual(calls, [direct.url, relayOne.url, relayTwo.url]);
});

test('route probes overlap but admission stays ordered and unused probes are cancelled', { timeout: 3000 }, async () => {
  const first = { ...relay, url: 'https://priority.test', relayId: 'priority', priority: 0 };
  const second = { ...relay, url: 'https://backup.test', relayId: 'backup', priority: 1 };
  const third = { ...relay, url: 'https://reserve.test', relayId: 'reserve', priority: 2 };
  const started = Promise.withResolvers(), cancelled = Promise.withResolvers(), release = Promise.withResolvers();
  const admitted = [];
  const selected = selectRoute({ ...target, routes: [first, second, third] }, {
    async probe(candidate, { signal }) {
      assert.deepEqual(Object.keys(candidate).sort(), ['pin', 'url']);
      if (candidate.url === first.url) await release.promise;
      if (candidate.url === third.url) {
        started.resolve();
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        cancelled.resolve();
      }
    },
    accept: async candidate => { admitted.push(candidate.url); },
  });
  await started.promise;
  assert.deepEqual(admitted, []);
  release.resolve();
  assert.equal((await selected).url, first.url);
  await cancelled.promise;
  assert.deepEqual(admitted, [first.url]);
});

test('route selection reports cooldown when every relay is cooling down', async () => {
  await assert.rejects(selectRoute({ ...target, routes: [{ ...relay, relayId: 'primary', cooldownUntil: Date.now() + 60_000 }] }, { probe: async () => assert.fail('cooling route must not be probed') }), error => error.code === 'ROUTES_COOLDOWN' && error.retryAt > Date.now());
});

test('one transient relay TLS failure gets one bounded retry after other routes', async () => {
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']) {
    const calls = [], health = [];
    const selected = await selectRoute({ ...target, routes: [relay] }, {
      probe: async candidate => { calls.push(candidate); if (calls.length === 1) throw Object.assign(new Error('transient'), { code }); },
      onHealth: async (_route, state, details) => health.push({ state, cooldownUntil: details.cooldownUntil }),
    });
    assert.equal(selected.url, relay.url);
    assert.deepEqual(calls, [{ url: relay.url, pin: '' }, { url: relay.url, pin: '' }], 'TLS retry never receives bearer credentials');
    assert.deepEqual(health.map(row => row.state), ['healthy'], 'one transient preflight does not put concurrent connections into cooldown');
    assert.equal(health.at(-1).cooldownUntil, 0);
  }
  let calls = 0;
  await assert.rejects(selectRoute({ ...target, routes: [relay] }, { probe: async () => { calls++; throw Object.assign(new Error('still unavailable'), { code: 'ETIMEDOUT' }); } }), { code: 'ETIMEDOUT' });
  assert.equal(calls, 2, 'a selection never loops indefinitely');
  calls = 0;
  await assert.rejects(selectRoute({ ...target, routes: [relay] }, { probe: async () => { calls++; throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); } }), { code: 'ECONNREFUSED' });
  assert.equal(calls, 1, 'a refused endpoint is not retried');
});

test('a failed admitted SSH tunnel cannot mask a cooling relay as an offline device', async () => {
  const url = 'https://127.0.0.1:46117', cooldownUntil = Date.now() + 60_000, calls = [];
  await assert.rejects(selectRoute({ ...target, url, pin, routes: [{ kind: 'direct', url, pin }, { ...relay, cooldownUntil }] }, {
    probe: async candidate => { calls.push(candidate.url); throw Object.assign(new Error('old tunnel closed'), { code: 'ECONNREFUSED' }); },
  }), error => error.code === 'ROUTES_COOLDOWN' && error.status === 503 && error.retryAt === cooldownUntil);
  assert.deepEqual(calls, [url]);
});

test('relay probe retries stop immediately for cancellation and trust failures', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(selectRoute({ ...target, routes: [relay] }, { signal: controller.signal, probe: async () => { calls++; controller.abort(); throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); } }), { name: 'AbortError' });
  assert.equal(calls, 1);
  for (const error of [Object.assign(new Error('untrusted'), { code: 'ERR_LINK_CERTIFICATE' }), Object.assign(new Error('denied'), { code: 'ECONNRESET', status: 403 })]) {
    calls = 0;
    await assert.rejects(selectRoute({ ...target, routes: [relay] }, { probe: async () => { calls++; throw error; } }), value => value === error);
    assert.equal(calls, 1);
  }
});

test('route selection reports relay health transitions for runtime cooldowns', async () => {
  const events = [];
  const selected = await selectRoute({ ...target, routes: [{ ...relay, relayId: 'primary' }] }, {
    probe: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); },
    onHealth: async (route, health, details) => events.push({ id: route.relayId, health, cooldown: details.cooldownUntil > Date.now(), error: details.lastError }),
  }).catch(error => error);
  assert.equal(selected.code, 'ETIMEDOUT');
  assert.deepEqual(events.map(event => event.id), ['primary']);
  assert.equal(events[0].health, 'unhealthy');
  assert.equal(events[0].cooldown, true);
  assert.equal(events[0].error, 'timeout');
});

test('active path is public runtime state, never persisted and cleared at restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-route-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = await openDeviceRegistry(directory);
  const device = await registry.upsert({ ...target, name: '电脑', currentPath: 'relay' });
  assert.equal(device.currentPath, null, 'input cannot claim an active connection');
  registry.markRoute(device.id, { kind: 'direct' });
  assert.equal(registry.publicDevice(registry.get(device.id)).currentPath, 'direct');
  registry.markRoute(device.id, { ...relay, relayId: 'backup' });
  assert.equal(registry.list().devices[1].currentPath, 'relay');
  assert.equal(registry.list().devices[1].currentRelayId, 'backup');
  assert.throws(() => registry.markRoute(device.id, { kind: 'unknown' }));
  await registry.rename(device.id, '改名');
  const file = join(directory, 'connections.json'), persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(Object.hasOwn(persisted.devices[0], 'currentPath'), false);
  persisted.devices[0].currentPath = 'relay';
  await writeFile(file, JSON.stringify(persisted));
  const restored = await openDeviceRegistry(directory);
  assert.equal(restored.list().devices[1].currentPath, null);
  await restored.rename(device.id, '再次改名');
  assert.equal((await readFile(file, 'utf8')).includes('currentPath'), false);
});

test('workbench admission falls back on service unavailability but stops on authorization failures', async () => {
  const first = { ...relay, relayId: 'primary', priority: 0 };
  const second = { ...relay, url: 'https://backup.test', relayId: 'backup', priority: 1 };
  const saved = { ...target, routes: [first, second] };
  const checked = [];
  const selected = await selectRoute(saved, { probe: async () => {}, accept: async (_, route) => {
    checked.push(route.relayId);
    if (route === undefined || route.relayId === 'primary') throw Object.assign(new Error('bad gateway'), { status: 502 });
  } });
  assert.equal(selected.url, second.url);
  assert.deepEqual(checked, ['primary', 'backup']);
  checked.length = 0;
  await assert.rejects(selectRoute(saved, { probe: async () => {}, accept: async (_, route) => {
    checked.push(route.relayId);
    throw Object.assign(new Error('expired authorization'), { status: 401 });
  } }), { status: 401 });
  assert.deepEqual(checked, ['primary']);
});

test('trust errors, HTTP authorization errors and cancellation never downgrade routes', async () => {
  for (const error of [Object.assign(new Error('pin mismatch'), { code: 'ERR_LINK_CERTIFICATE' }), Object.assign(new Error('bad cert'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), ...[401, 403].map(statusCode => Object.assign(new Error('denied'), { code: 'ECONNRESET', statusCode })), new Error('unknown')]) {
    let count = 0;
    await assert.rejects(selectRoute(target, { probe: async () => { count++; throw error; } }), value => value === error);
    assert.equal(count, 1);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(selectRoute(target, { signal: controller.signal, probe: async () => assert.fail('must not probe') }), { name: 'AbortError' });
  assert.equal((await selectRoute({ url: relay.url, token: 'legacy' }, { probe: async () => assert.fail('legacy is unchanged') })).token, 'legacy');
});

test('TLS-only selection verifies pins, rejects an untrusted relay and never sends HTTP credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-route-tls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identity = await loadIdentity(directory);
  let requests = 0;
  const server = createServer({ key: identity.key, cert: identity.cert }, (req, res) => { requests++; res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"denied"}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = 'https://127.0.0.1:' + server.address().port;
  await probeRemote({ url, pin: identity.pin });
  assert.equal(requests, 0);
  const selected = await selectRoute({ ...target, url, pin: identity.pin, routes: [{ kind: 'direct', url, pin: identity.pin }, relay] });
  assert.equal(selected.url, url); assert.equal(requests, 0);
  await assert.rejects(selectRoute({ ...target, url, routes: [{ kind: 'direct', url, pin }, relay] }), { code: 'ERR_LINK_CERTIFICATE' });
  await assert.rejects(selectRoute({ ...target, routes: [{ kind: 'relay', url }] }), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  assert.equal(requests, 0);
  await assert.rejects(remoteJson(selected, '/link/api/rpc', { action: 'write' }), { statusCode: 403 });
  assert.equal(requests, 1, 'denied business requests are never replayed');
});

test('new Link certificates tolerate small clock skew and still enforce their validity period', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-route-clock-'));
  const generatedAt = Date.now();
  const identity = await loadIdentity(directory);
  const certificate = new X509Certificate(identity.cert);
  let requests = 0;
  const server = createServer({ key: identity.key, cert: identity.cert }, (_req, res) => {
    requests++;
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const target = { url: 'https://127.0.0.1:' + server.address().port, pin: identity.pin };
  const clock = t.mock.method(Date, 'now', () => generatedAt - 30_000);
  await probeRemote(target);
  await remoteJson(target, '/link/api/rpc', {}, { token: 'fixture-token' });
  assert.equal(requests, 1);
  clock.mock.mockImplementation(() => Date.parse(certificate.validFrom) - 1);
  await assert.rejects(remoteJson(target, '/link/api/rpc', {}, { token: 'fixture-token' }),
    { code: 'ERR_LINK_CERTIFICATE', message: /尚未生效.*系统时间/ });
  clock.mock.mockImplementation(() => Date.parse(certificate.validTo));
  await assert.rejects(probeRemote(target), { code: 'ERR_LINK_CERTIFICATE', message: /已过期/ });
  assert.equal(requests, 1);
});

test('Link JSON deadlines include a stalled pinned TLS handshake', async t => {
  const sockets = new Set();
  let connected;
  const server = createTcpServer(socket => {
    sockets.add(socket);
    socket.resume();
    socket.on('close', () => sockets.delete(socket));
    connected?.(socket);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const target = { url: `https://127.0.0.1:${server.address().port}`, pin };
  const agent = remoteAgent(target, { maxSockets: 1 });
  t.after(() => {
    agent.destroy();
    for (const socket of sockets) socket.destroy();
    return new Promise(resolve => server.close(resolve));
  });
  let watchdog;
  try {
    await Promise.race([
      assert.rejects(remoteJson(target, '/link/api/info', undefined, { agent, timeout: 50 }), { code: 'ETIMEDOUT' }),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('TLS handshake outlived the JSON deadline')), 1000); }),
    ]);
  } finally { clearTimeout(watchdog); }

  for (const cancel of [controller => controller.abort(), () => agent.destroy()]) {
    const accepted = new Promise(resolve => { connected = resolve; });
    const controller = new AbortController();
    const result = remoteJson(target, '/link/api/info', undefined, { agent, signal: controller.signal, timeout: 1000 });
    const socket = await accepted;
    const closed = new Promise(resolve => socket.once('close', resolve));
    const rejected = assert.rejects(result, error => ['ABORT_ERR', 'ECONNRESET', 20].includes(error.code));
    cancel(controller);
    await Promise.all([rejected, closed]);
  }
});
