import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { mountLink } from '../src/index.mjs';
import { createServer as createHttpsServer } from 'node:https';
import { once } from 'node:events';
import { loadIdentity } from '../src/transport/tls.mjs';

async function temporaryProfile(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(directory, 'devices.json'), JSON.stringify({ enabled: false, host: '127.0.0.1', port: 0 }));
  return directory;
}

test('Link uses the base data directory and pairs without Harness aggregation or SuperAgent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'link-base-only-'));
  await mkdir(join(directory, 'link'));
  await writeFile(join(directory, 'link', 'devices.json'), JSON.stringify({ host: '127.0.0.1', port: 0 }));
  const routes = [], requested = [];
  const ctx = {
    get(name) { requested.push(name); return name === 'benchgo' ? { directory } : undefined; },
    workspaceRegistry: { list: () => [] },
    connection: { fetch: { register(value) { routes.push(value); return () => {}; } } },
    effect: fn => fn(),
  };
  let link;
  t.after(async () => { await link?.close(); await rm(directory, { recursive: true, force: true }); });
  link = await mountLink(ctx, { env: {} });
  assert.equal(link.status().enabled, true);
  const pair = await link.admin({ action: 'pairing', mode: 'lan' });
  assert.equal(new URL(pair.uri).searchParams.get('url'), `https://127.0.0.1:${link.status().port}`);
  assert.deepEqual(requested, ['benchgo'], 'module services are not needed to start or pair');
  const route = routes.find(value => value.path === '/api/commander-devices');
  const response = await route.fetch(new Request('http://127.0.0.1' + route.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'devices' }) }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).devices[0].status, 'online');
});

test('partial cloud gateway settings keep the local device routes available', async t => {
  const directory = await temporaryProfile('link-partial-cloud-');
  const routes = [];
  const ctx = { get: () => undefined, workspaceRegistry: { list: () => [] }, connection: { fetch: { register: value => { routes.push(value); return () => {}; } } }, effect: fn => fn() };
  const link = await mountLink(ctx, {
    directory,
    env: { DSH_LINK_DEVICE_GATEWAY_PORT: '48723', DSH_LINK_WORKBENCH_ORIGIN: 'https://workbench.example' },
  });
  t.after(async () => { await link.close(); await rm(directory, { recursive: true, force: true }); });
  assert.ok(routes.some(value => value.path === '/api/commander-link'));
  assert.ok(routes.some(value => value.path === '/api/commander-devices'));
});

test('device launch only exposes the local owner entry', async t => {
  const directory = await temporaryProfile('link-device-entry-');
  const routes = [];
  const ctx = { get: () => undefined, workspaceRegistry: { list: () => [] }, connection: { fetch: { register: value => { routes.push(value); return () => {}; } } }, effect: fn => fn() };
  const link = await mountLink(ctx, { directory });
  t.after(async () => { await link.close(); await rm(directory, { recursive: true, force: true }); });
  const route = routes.find(value => value.path === '/api/commander-devices');
  const launch = (origin, parentOrigin = origin) => route.fetch(new Request(origin + route.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'launch', parentOrigin }) }));
  const unsupported = await launch('https://cloud.example');
  assert.equal(unsupported.status, 409);
  assert.equal(unsupported.headers.get('cache-control'), 'no-store');
  assert.match((await unsupported.json()).error, /云端设备网关/);
  assert.equal((await launch('https://cloud.example', 'http://127.0.0.1:8080')).status, 409, 'browser-supplied parent does not disguise the remote origin');
  assert.equal((await launch('https://cloud.example', 'dsh-app://app')).status, 409, 'a Desktop label cannot disguise the remote origin');
  for (const [origin, parent] of [['http://127.0.0.1:8080', undefined], ['http://localhost:8080', undefined], ['http://[::1]:8080', undefined], ['http://127.0.0.1:8080', 'dsh-app://app'], ['http://127.0.0.1:8080', 'dsh-app://localhost']]) {
    const response = await launch(origin, parent);
    assert.equal(response.status, 200);
    const target = new URL((await response.json()).url);
    assert.equal(target.hostname, '127.0.0.1');
    assert.equal(target.pathname, '/enter');
    const entry = await fetch(target, { redirect: 'manual' });
    assert.equal(entry.status, 303);
    assert.equal((await fetch(target, { redirect: 'manual' })).status, 401);
  }
  for (const [headers, parentOrigin, expected] of [
    [{ host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' }, 'http://127.0.0.1:8080', 200],
    [{ host: '127.0.0.1:8080' }, 'dsh-app://app', 200],
    [{ host: 'cloud.example', origin: 'https://cloud.example' }, 'http://localhost:8080', 409],
    [{ host: '127.0.0.1:8080', origin: 'https://cloud.example' }, 'dsh-app://app', 409],
  ]) {
    const response = await route.fetch(new Request('http://dsh.internal' + route.path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'launch', parentOrigin }) }));
    assert.equal(response.status, expected, 'official bridge synthetic URL uses admitted browser Origin or carrier Host');
    if (response.ok) {
      const entry = await fetch((await response.json()).url, { redirect: 'manual' });
      const base = new URL(entry.headers.get('location'), 'http://127.0.0.1');
      const centerUrl = new URL(entry.url);
      const config = await (await fetch(centerUrl.origin + base.pathname + 'device-config.js')).text();
      assert(config.includes(JSON.stringify(parentOrigin)), 'the center trusts the actual parent, never dsh.internal');
      const api = action => fetch(centerUrl.origin + base.pathname + 'api/devices', { method: 'POST', headers: { origin: centerUrl.origin, 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
      assert.equal((await (await api('list')).json()).capabilities.hostAdmin, true);
      assert.equal((await (await api('hostStatus')).json()).enabled, true);
    }
  }
  const summary = await route.fetch(new Request('http://127.0.0.1:8080' + route.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'devices' }) }));
  assert.equal(summary.status, 200);
  assert.deepEqual((await summary.json()).devices, [{ id: 'local', name: link.status().hostName, kind: 'local', status: 'online' }]);
  const cloudSummary = await route.fetch(new Request('https://cloud.example' + route.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'devices' }) }));
  assert.equal(cloudSummary.status, 409);
});

test('plugin admin persists settings, advertises real TLS and separates public pairing trust', async t => {
  const directory = await temporaryProfile('link-admin-');
  let route;
  const ctx = { get: () => undefined, workspaceRegistry: { list: () => [] }, connection: { fetch: { register(value) { route = value; return () => {}; } } }, effect: fn => fn() };
  const link = await mountLink(ctx, { directory });
  t.after(async () => { await link.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(route.path, '/api/commander-link');
  assert.equal(link.status().enabled, true);
  const enabled = await link.admin({ action: 'configure', enabled: true, host: '127.0.0.1', port: 0, publicUrl: 'https://desk.example.com' });
  assert(enabled.port > 0); assert(enabled.enabled);
  const lan = await link.admin({ action: 'pairing', mode: 'lan' });
  assert(new URL(lan.uri).searchParams.get('pin'));
  assert.equal(new URL(lan.uri).searchParams.get('url'), `https://127.0.0.1:${enabled.port}`);
  const publicPair = await link.admin({ action: 'pairing', mode: 'public' });
  assert.equal(new URL(publicPair.uri).searchParams.get('pin'), '');
  assert(publicPair.webUrl.startsWith('https://desk.example.com/link/#code='));
  await assert.rejects(link.admin({ action: 'configure', port: -1 }), /端口/);
  assert.equal(link.status().enabled, true);
  await link.admin({ action: 'configure', enabled: false });
  assert.equal(link.status().enabled, true, 'legacy off requests cannot disable persistent device connections');
});

test('invalid relay configuration never disables direct Link or exposes the host secret', async t => {
  const directory = await temporaryProfile('link-relay-admin-');
  const ctx = { get: () => undefined, workspaceRegistry: { list: () => [] }, connection: { fetch: { register: () => () => {} } }, effect: fn => fn() };
  const token = 'private-relay-secret-'.repeat(3);
  const link = await mountLink(ctx, { directory, env: { DSH_LINK_RELAY_URL: 'http://invalid.example', DSH_LINK_RELAY_TOKEN: token } });
  t.after(async () => { await link.close(); await rm(directory, { recursive: true, force: true }); });
  const state = await link.admin({ action: 'configure', enabled: true, host: '127.0.0.1', port: 0 });
  assert.equal(state.enabled, true);
  assert.equal(state.relay.configured, true);
  assert.equal(state.relay.connected, false);
  assert(!JSON.stringify(state).includes(token));
  await assert.rejects(link.admin({ action: 'pairing', mode: 'relay' }), /尚未连接/);
  assert((await link.admin({ action: 'pairing', mode: 'lan' })).uri.startsWith('benchgo://pair?'));
  await link.admin({ action: 'configure', enabled: false });
  assert.equal(link.status().relay.connected, false);
});

test('quick enable preserves settings and pairing uses suitable addresses without loopback fallback', async t => {
  const directory = await temporaryProfile('link-discovery-');
  const entry = address => ({ address, internal: false });
  let interfaces = {
    eth0: [entry('fe80::1'), entry('192.168.1.10')],
    'br-abcdef123456': [entry('172.19.0.1')],
    wlan0: [entry('10.0.0.8')],
  };
  t.mock.method(os, 'networkInterfaces', () => interfaces);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const ctx = { get: () => undefined, workspaceRegistry: { list: () => [] }, connection: { fetch: { register: () => () => {} } }, effect: fn => fn() };
  const link = await mountLink(ctx, { directory });
  t.after(async () => { await link.close(); await rm(directory, { recursive: true, force: true }); });
  await link.admin({ action: 'configure', host: '0.0.0.0', port: 0, publicUrl: 'https://desk.example.com' });
  const status = await link.admin({ action: 'configure', enabled: true });
  assert.equal(status.host, '0.0.0.0');
  assert.equal(status.publicUrl, 'https://desk.example.com');
  assert.deepEqual(status.addresses, [`https://192.168.1.10:${status.port}`, `https://10.0.0.8:${status.port}`]);
  assert.equal((await link.admin({ action: 'pairing' })).url, status.addresses[0]);
  assert.equal((await link.admin({ action: 'pairing', address: status.addresses[1] })).url, status.addresses[1]);
  await assert.rejects(link.admin({ action: 'pairing', address: `https://172.19.0.1:${status.port}` }), /局域网地址无效/);
  interfaces = {};
  assert.deepEqual(link.status().addresses, []);
  await assert.rejects(link.admin({ action: 'pairing' }), /未找到可用的连接地址/);
  assert.equal((await link.admin({ action: 'pairing', mode: 'public' })).url, 'https://desk.example.com');
});

test('owner relay configuration persists separately without returning credentials', async t => {
  const directory = await temporaryProfile('link-relay-save-');
  const ctx = { get: () => undefined, workspaceRegistry: { list: () => [] }, connection: { fetch: { register: () => () => {} } }, effect: fn => fn() };
  let link = await mountLink(ctx, { directory, env: {} });
  t.after(async () => { await link.close(); await rm(directory, { recursive: true, force: true }); });
  const token = 'owner-relay-credential-'.repeat(3);
  await assert.rejects(link.admin({ action: 'relay-configure', url: 'http://relay.example', token }), /HTTPS/);
  const value = await link.admin({ action: 'relay-configure', url: 'https://relay.example:48730', token, enabled: false });
  assert.equal(value.enabled, true);
  assert.equal(value.relay.configured, true);
  assert.equal(JSON.stringify(value).includes(token), false);
  const beforeTest = await readFile(join(directory, 'devices.json'), 'utf8');
  const tested = await link.admin({ action: 'relay-test', id: value.relay.nodes[0].id, url: 'http://invalid.example', token: '' });
  assert.equal(tested.ok, false); assert.match(tested.message, /HTTPS/);
  assert.equal(await readFile(join(directory, 'devices.json'), 'utf8'), beforeTest, 'relay test does not persist settings');
  await link.close(); link = await mountLink(ctx, { directory, env: { DSH_LINK_RELAY_URL: 'https://ignored.example' } });
  assert.equal(link.status().relay.url, 'https://relay.example:48730');
  assert.equal(link.status().relay.enabled, false);
});

test('relay pool configuration persists ordered nodes and exposes only public route metadata', async t => {
  const directory = await temporaryProfile('link-relay-pool-');
  const ctx = { get: () => undefined, workspaceRegistry: { list: () => [] }, connection: { fetch: { register: () => () => {} } }, effect: fn => fn() };
  const link = await mountLink(ctx, { directory, env: {} });
  t.after(async () => { await link.close(); await rm(directory, { recursive: true, force: true }); });
  const token = 'relay-pool-token-'.repeat(3);
  const value = await link.admin({ action: 'relay-pool-configure', nodes: [
    { id: 'primary', url: 'https://relay-a.example:48730', token, priority: 0, enabled: false },
    { id: 'backup', url: 'https://relay-b.example:48730', token, priority: 1, enabled: false },
  ] });
  assert.deepEqual(value.relay.nodes.map(node => node.id), ['primary', 'backup']);
  assert.equal(JSON.stringify(value).includes(token), false);
  const saved = JSON.parse(await readFile(join(directory, 'devices.json'), 'utf8'));
  assert.deepEqual(saved.relayPool.map(node => node.id), ['primary', 'backup']);
});

test('relay pool can be emptied after a node is disabled', async t => {
  const directory = await temporaryProfile('link-relay-delete-');
  const ctx = { get: () => undefined, workspaceRegistry: { list: () => [] }, connection: { fetch: { register: () => () => {} } }, effect: fn => fn() };
  let link = await mountLink(ctx, { directory, env: {}, createRelayHost: async () => ({ status: () => ({ connected: true }), close: async () => {} }) });
  t.after(async () => { await link.close(); await rm(directory, { recursive: true, force: true }); });
  const node = { id: 'only', url: 'https://relay.example:48730', token: 'relay-delete-token', enabled: true };
  await link.admin({ action: 'relay-pool-configure', nodes: [node] });
  await assert.rejects(link.admin({ action: 'relay-pool-configure', nodes: [] }), /请先停用中继/);
  await link.admin({ action: 'relay-pool-configure', nodes: [{ ...node, enabled: false }] });
  const value = await link.admin({ action: 'relay-pool-configure', nodes: [] });
  assert.deepEqual(value.relay.nodes, []);
  assert.equal(value.relay.enabled, false);
  assert.equal(value.relay.configured, false);
  await link.close();
  link = await mountLink(ctx, { directory, env: { DSH_LINK_RELAY_URL: node.url, DSH_LINK_RELAY_TOKEN: node.token } });
  assert.deepEqual(link.status().relay.nodes, []);
  assert.equal(link.status().relay.configured, false);
});

test('relay test reuses saved secrets without changing configuration', async t => {
  const directory = await temporaryProfile('link-relay-test-');
  const identity = await loadIdentity(directory), token = 'private-saved-relay-secret';
  let validProtocol = true;
  const server = createHttpsServer({ key: identity.key, cert: identity.cert }, (req, res) => {
    assert.equal(req.url, '/__link/relay/probe'); assert.equal(req.headers.authorization, 'Bearer ' + token);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(validProtocol ? { protocol: 'benchgo-link-relay', version: 1, authenticated: true } : { ok: true }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const ctx = { get: () => undefined, workspaceRegistry: { list: () => [] }, connection: { fetch: { register: () => () => {} } }, effect: fn => fn() };
  const link = await mountLink(ctx, { directory, env: {}, relayTestOptions: { ca: identity.cert } });
  t.after(async () => { await link.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await link.admin({ action: 'relay-pool-configure', nodes: [{ id: 'saved', url: `https://localhost:${server.address().port}`, token, enabled: false }] });
  const before = await readFile(join(directory, 'devices.json'), 'utf8');
  const tested = await link.admin({ action: 'relay-test', id: 'saved', token: '' });
  assert.equal(tested.ok, true); assert.equal(JSON.stringify(tested).includes(token), false);
  validProtocol = false;
  const ordinaryHttp = await link.admin({ action: 'relay-test', id: 'saved', token: '' });
  assert.equal(ordinaryHttp.ok, false); assert.match(ordinaryHttp.message, /协议/);
  assert.equal(await readFile(join(directory, 'devices.json'), 'utf8'), before); assert.equal(link.status().enabled, true);
});

test('old disabled profiles migrate to persistent connections and local names survive restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'link-persistent-name-'));
  await writeFile(join(directory, 'devices.json'), JSON.stringify({ enabled: false, host: '127.0.0.1', port: 0 }));
  const ctx = { get: () => undefined, workspaceRegistry: { list: () => [] }, connection: { fetch: { register: () => () => {} } }, effect: fn => fn() };
  let link = await mountLink(ctx, { directory, env: {} });
  t.after(async () => { await link.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(link.status().enabled, true);
  const port = link.status().port;
  const renamed = await link.admin({ action: 'configure', name: '办公室电脑' });
  assert.equal(renamed.hostName, '办公室电脑');
  assert.equal(renamed.port, port, 'renaming does not replace the listener or active sessions');
  assert.equal(new URL((await link.admin({ action: 'pairing' })).uri).searchParams.get('name'), '办公室电脑');
  await assert.rejects(link.admin({ action: 'configure', name: '   ' }), /名称/);
  await link.close();
  link = await mountLink(ctx, { directory, env: {} });
  assert.equal(link.status().hostName, '办公室电脑');
  assert.equal(link.status().enabled, true);
  assert.equal(JSON.parse(await readFile(join(directory, 'devices.json'), 'utf8')).enabled, true);
});

test('single relay configure registers its runtime state in the relay node list', async t => {
  const directory = await temporaryProfile('link-relay-node-state-');
  const ctx = { get: () => undefined, workspaceRegistry: { list: () => [] }, connection: { fetch: { register: () => () => {} } }, effect: fn => fn() };
  const link = await mountLink(ctx, { directory, env: {} });
  t.after(async () => { await link.close(); await rm(directory, { recursive: true, force: true }); });
  await link.admin({ action: 'configure', enabled: true, host: '127.0.0.1', port: 0 });
  await link.admin({ action: 'relay-configure', url: 'https://127.0.0.1:1', token: 'relay-secret', enabled: true });
  for (let index = 0; index < 50 && !link.status().relay.nodes[0].lastError; index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(link.status().relay.nodes[0].lastError, /ECONNREFUSED/);
});

test('relay status and pairing select the same connected enabled node by priority after reload', async t => {
  const directory = await temporaryProfile('link-relay-selection-');
  const ctx = { get: () => undefined, workspaceRegistry: { list: () => [] }, connection: { fetch: { register: () => () => {} } }, effect: fn => fn() };
  const states = new Map(), connected = url => states.set(url, { connected: true, lastError: null });
  const config = {
    directory, env: {},
    createRelayHost: ({ relayUrl }) => {
      states.set(relayUrl, { connected: false, lastError: 'offline' });
      return { status: () => states.get(relayUrl), async close() { states.set(relayUrl, { connected: false, lastError: null }); } };
    },
  };
  let link = await mountLink(ctx, config);
  t.after(async () => { await link.close(); await rm(directory, { recursive: true, force: true }); });
  await link.admin({ action: 'configure', enabled: true, host: '127.0.0.1', port: 0, publicUrl: 'https://direct.example' });
  const nodes = [
    { id: 'disabled', url: 'https://disabled.example', token: 'relay-secret', priority: -1, enabled: false },
    { id: 'first', url: 'https://first.example', token: 'relay-secret', priority: 0, enabled: true },
    { id: 'backup', url: 'https://backup.example', token: 'relay-secret', priority: 20, enabled: true },
    { id: 'preferred', url: 'https://preferred.example', token: 'relay-secret', priority: 10, enabled: true },
  ];
  await link.admin({ action: 'relay-pool-configure', nodes });
  await link.close();
  states.clear();
  link = await mountLink(ctx, config);
  assert.equal(link.status().relay.enabled, true, 'a disabled first node does not disable the pool on reload');
  assert.equal(states.has(nodes[0].url), false, 'disabled nodes are never connected');
  assert.equal(link.status().relay.connected, false);
  await assert.rejects(link.admin({ action: 'pairing', mode: 'relay' }), /尚未连接/);
  connected(nodes[2].url);
  assert.equal(link.status().relay.connected, true, 'a later connected node makes the pool available');
  assert.equal(link.status().relay.url, nodes[2].url);
  const fallback = await link.admin({ action: 'pairing', mode: 'relay' });
  assert.equal(fallback.url, nodes[2].url);
  assert.equal(new URL(fallback.uri).searchParams.get('url'), nodes[2].url);
  assert.equal(new URL(fallback.webUrl).origin, nodes[2].url);
  connected(nodes[3].url);
  assert.equal(link.status().relay.url, nodes[3].url, 'configuration priority wins over list order');
  assert.equal((await link.admin({ action: 'pairing', mode: 'relay' })).url, nodes[3].url);
  connected(nodes[1].url);
  assert.equal(link.status().relay.url, nodes[1].url);
  assert.equal((await link.admin({ action: 'pairing', mode: 'relay' })).url, nodes[1].url);
  assert.equal((await link.admin({ action: 'pairing', mode: 'public' })).url, 'https://direct.example');
  assert.equal((await link.admin({ action: 'pairing', mode: 'lan' })).url, link.status().addresses[0]);
  for (const node of nodes.slice(1)) states.set(node.url, { connected: false, lastError: 'offline' });
  assert.equal(link.status().relay.connected, false);
  await assert.rejects(link.admin({ action: 'pairing', mode: 'relay' }), /尚未连接/);
});
