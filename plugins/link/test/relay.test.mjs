import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { connect as connectHttp2 } from 'node:http2';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { gunzipSync } from 'node:zlib';
import { openStore } from '../src/pairing/store.mjs';
import { loadIdentity } from '../src/transport/tls.mjs';
import { listen, validateConfig } from '../src/transport/server.mjs';
import { createRelayServer } from '../src/transport/relay-server.mjs';
import { createRelayHost } from '../src/transport/relay-host.mjs';
import { testRelayConnection } from '../src/transport/relay-probe.mjs';
import { relayPathAllowed } from '../src/transport/relay-protocol.mjs';
import { createWorkbench } from '../src/transport/workbench.mjs';
import { createDeviceProxy } from '../src/devices/proxy.mjs';

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port;
}
function request(port, path, { method = 'GET', body, token, cookie, headers = {}, localAddress } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname: '127.0.0.1', port, path, method, localAddress, servername: 'localhost', ca: request.relayCert, headers: {
      host: `localhost:${port}`, origin: request.relayOrigin, ...(token ? { authorization: 'Bearer ' + token } : {}), ...(cookie ? { cookie } : {}), ...headers,
    } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('relay binds one Link host and streams pairing, workbench, and voice only', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'link-relay-'));
  const targetDir = join(directory, 'target'), relayDir = join(directory, 'relay'), workbenchRoot = join(directory, 'workbench');
  await mkdir(targetDir); await mkdir(relayDir); await mkdir(workbenchRoot);
  await writeFile(join(workbenchRoot, 'index.html'), '<!doctype html><html><head></head><body>real-workbench</body></html>');
  await mkdir(join(workbenchRoot, 'assets'));
  const asset = 'globalThis.relayCompression=true;\n'.repeat(2000);
  await writeFile(join(workbenchRoot, 'assets/large.js'), asset);
  const targetIdentity = await loadIdentity(targetDir), relayIdentity = await loadIdentity(relayDir);
  const store = await openStore(join(directory, 'devices'));
  const relayPort = await freePort(), relayOrigin = `https://localhost:${relayPort}`;
  request.relayCert = relayIdentity.cert; request.relayOrigin = relayOrigin;
  const forwardedWorkbenchCookies = [];
  const ctx = {
    connection: {
      createPeer: () => ({ dispose: async () => {} }),
      createSharedFetchHandler: () => ({
        requestBodyMode: () => 'streaming',
        async fetch(request) {
          let uploaded = 0;
          if (request.body) for await (const chunk of request.body) uploaded += chunk.length;
          const data = Buffer.alloc(48 * 48 * 1024, 0x5a);
          return new Response(new ReadableStream({ start(controller) { controller.enqueue(data); controller.close(); } }), { status: 200, headers: { 'content-type': 'application/octet-stream', 'x-uploaded-bytes': String(uploaded) } });
        },
      }),
    },
    webServer: { renderIndex: html => html },
    clientModules: undefined,
    get: () => ({ acceptRealtimeSocket(ws) { ws.on('message', (data, binary) => ws.send(data, { binary })); } }),
  };
  const workbench = createWorkbench(ctx, store, { workbenchRoot });
  const handleWorkbench = workbench.handle;
  workbench.handle = (...args) => { forwardedWorkbenchCookies.push(args[0].headers.cookie || ''); return handleWorkbench(...args); };
  const linkConfig = validateConfig({ enabled: true, host: '127.0.0.1', port: 0 }, { enabled: false, host: '127.0.0.1', port: 0, publicUrl: '' });
  const linkServer = await listen({ identity: targetIdentity, config: linkConfig, webRoot: new URL('../dist/web/', import.meta.url), store, dispatch: async input => ({ action: input.action }), workbench, onError: () => {} });
  const token = 'relay-host-secret-with-at-least-32-bytes';
  const relayServer = await createRelayServer({ host: '127.0.0.1', port: relayPort, identity: relayIdentity, publicUrl: relayOrigin, token });
  const hostErrors = [];
  const host = createRelayHost({ relayUrl: relayOrigin, relayCa: relayIdentity.cert, token, target: { url: `https://127.0.0.1:${linkServer.port}`, pin: targetIdentity.pin }, onError: error => hostErrors.push(error.message) });
  t.after(async () => {
    await host.close(); await relayServer.close(); await linkServer.close(); await store.flush(); await rm(directory, { recursive: true, force: true });
    delete request.relayCert; delete request.relayOrigin;
  });
  for (let index = 0; index < 50 && !host.status().connected; index++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(host.status().connected, true);

  const probeOptions = { ca: relayIdentity.cert };
  const tested = await testRelayConnection({ url: relayOrigin, token }, probeOptions);
  assert.equal(tested.ok, true); assert(tested.latencyMs >= 0);
  assert.match((await testRelayConnection({ url: relayOrigin, token })).message, /TLS/);
  assert.equal((await testRelayConnection({ url: relayOrigin, token: 'wrong-secret' }, probeOptions)).ok, false);
  assert.equal(host.status().connected, true, 'testing credentials must not replace the active host');

  const pairing = store.begin();
  const requested = await request(relayPort, '/link/api/pair', { method: 'POST', body: JSON.stringify({ code: pairing.code, name: 'Relay phone' }), headers: { 'content-type': 'application/json' } });
  assert.equal(requested.status, 200, `${requested.body.toString()} host=${JSON.stringify(host.status())} errors=${hostErrors.join('|')}`);
  const pending = requested.body.toString();
  const pendingValue = JSON.parse(pending);
  await store.decide(pendingValue.requestId, true);
  const approval = await request(relayPort, '/link/api/pair/status', { method: 'POST', body: JSON.stringify(pendingValue), headers: { 'content-type': 'application/json' } });
  assert.equal(approval.status, 200);
  const approved = JSON.parse(approval.body), tokenValue = approved.token;
  const opened = await request(relayPort, '/link/api/workbench', { method: 'POST', token: tokenValue, body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(opened.status, 200);
  const cookie = (opened.headers['set-cookie']?.[0] || opened.headers['set-cookie']).split(';')[0];
  assert.match(cookie, /^dsh_link_workbench=/);
  const page = await request(relayPort, '/link/workbench/', { cookie: `${cookie}; dsh_owner=owner-secret` });
  assert.equal(page.status, 200); assert.match(page.body.toString(), /real-workbench/);
  assert.deepEqual(forwardedWorkbenchCookies, [cookie]);
  const compressed = await request(relayPort, '/link/workbench/assets/large.js', { cookie, headers: { 'accept-encoding': 'gzip' } });
  assert.equal(compressed.headers['content-encoding'], 'gzip'); assert.equal(gunzipSync(compressed.body).toString(), asset);
  assert(compressed.body.length < Buffer.byteLength(asset) / 4);
  const identity = await request(relayPort, '/link/workbench/assets/large.js', { cookie, headers: { 'accept-encoding': 'gzip;q=0' } });
  assert.equal(identity.headers['content-encoding'], undefined); assert.equal(identity.body.toString(), asset);
  const proxy = await createDeviceProxy({ url: relayOrigin, pin: relayIdentity.pin, token: tokenValue }, { parentOrigin: 'http://127.0.0.1:4444' });
  try {
    const login = await fetch(await proxy.enter(), { redirect: 'manual' }), location = login.headers.get('location');
    const proxyPage = await fetch(proxy.origin + location);
    assert.equal(proxyPage.headers.get('content-encoding'), null); assert.match(await proxyPage.text(), /real-workbench/);
    const response = await fetch(proxy.origin + location + 'assets/large.js');
    assert.equal(response.headers.get('content-encoding'), 'gzip'); assert.equal(await response.text(), asset);
  } finally { await proxy.close(); }

  const multiplexed = connectHttp2(relayOrigin, { ca: relayIdentity.cert });
  t.after(() => multiplexed.destroy());
  const [limits] = await once(multiplexed, 'remoteSettings');
  assert.equal(limits.maxConcurrentStreams, 32, 'browser bursts queue below the shared relay transaction budget');
  const startup = await Promise.all(Array.from({ length: 80 }, () => new Promise((resolve, reject) => {
    const stream = multiplexed.request({ ':method': 'GET', ':path': '/link/api/info', origin: relayOrigin });
    let status;
    stream.on('response', headers => { status = headers[':status']; });
    stream.on('error', reject); stream.on('end', () => resolve(status)); stream.resume();
  })));
  assert(startup.every(status => status === 200), 'a cold-start resource burst must not return capacity errors');
  multiplexed.close();

  const payload = Buffer.alloc(1_500_000, 0x41);
  const streamed = await request(relayPort, '/link/workbench/api/stream/echo', { method: 'POST', body: payload, cookie, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(streamed.status, 200);
  assert.equal(streamed.headers['x-uploaded-bytes'], String(payload.length));
  assert.equal(streamed.body.length, 48 * 48 * 1024);
  assert.equal(streamed.body[0], 0x5a);

  const voiceUrl = `wss://localhost:${relayPort}/link/workbench/api/voice/realtime`;
  const browser = new WebSocket(voiceUrl, { ca: relayIdentity.cert, origin: relayOrigin, headers: { host: `localhost:${relayPort}`, cookie }, perMessageDeflate: false });
  t.after(() => browser.terminate());
  await once(browser, 'open'); browser.send('voice-through-relay');
  const [voiceData, isBinary] = await once(browser, 'message');
  assert.equal(String(voiceData), 'voice-through-relay'); assert.equal(isBinary, false);

  assert.equal((await request(relayPort, '/api/commander-link')).status, 404);
  assert.equal((await request(relayPort, '/link/workbench/api/commander-link')).status, 404);
  assert.equal((await request(relayPort, '/link/workbench/api/admin')).status, 404);
  assert.equal((await request(relayPort, '/link/api/info', { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal(relayPathAllowed('POST', '/link/workbench/api/commander-devices'), false);
  assert.equal(relayPathAllowed('GET', '/link/workbench/%2e%2e/api/commander-link'), false);
  assert.equal(relayPathAllowed('CONNECT', 'http://127.0.0.1:22'), false);

  await store.revoke(approved.deviceId); await workbench.revoke(approved.deviceId);
  assert.equal((await request(relayPort, '/link/api/workbench', { method: 'POST', token: tokenValue, body: '{}' })).status, 401);
  assert.equal((await request(relayPort, '/link/workbench/api/stream/echo', { method: 'POST', cookie, body: '{}' })).status, 401);
});

test('real relay isolates anonymous traffic and each verified device quota, including workbench cookies', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'link-relay-rate-'));
  const identity = await loadIdentity(directory), store = await openStore(join(directory, 'devices'));
  const relayPort = await freePort(), origin = `https://localhost:${relayPort}`;
  request.relayCert = identity.cert; request.relayOrigin = origin;
  const workbench = createWorkbench({ connection: {
    createPeer: () => ({ dispose: async () => {} }),
    createSharedFetchHandler: () => ({ fetch: async () => Response.json({ ok: true }) }),
  } }, store);
  const link = await listen({ identity, config: { host: '127.0.0.1', port: 0, publicUrl: '' }, store, workbench, dispatch: async () => ({ ok: true }), onError: () => {} });
  const secret = 'safe-test-relay-host-secret', relay = await createRelayServer({ host: '127.0.0.1', port: relayPort, identity, publicUrl: origin, token: secret });
  // Quota windows advance Date.now below; isolate the host's interval so a
  // slow test cannot mistake that jump for a lost pong.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const host = createRelayHost({ relayUrl: origin, relayCa: identity.cert, token: secret, relayHeaders: link.relayHeaders, target: { url: `https://127.0.0.1:${link.port}`, pin: identity.pin } });
  t.after(async () => {
    await host.close(); t.mock.timers.reset(); await relay.close(); await link.close(); await store.flush();
    await rm(directory, { recursive: true, force: true });
    delete request.relayCert; delete request.relayOrigin;
  });
  for (let i = 0; i < 100 && !host.status().connected; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(host.status().connected, true);
  const pair = async name => {
    const pending = store.request(store.begin().code, name); await store.decide(pending.requestId, true);
    const device = store.poll(pending.requestId, pending.pollToken);
    const opened = await request(relayPort, '/link/api/workbench', { method: 'POST', token: device.token, body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(opened.status, 200);
    return { ...device, cookie: opened.headers['set-cookie'][0].split(';')[0] };
  };
  const first = await pair('one'), second = await pair('two');
  let now = Date.now() + 60_000; t.mock.method(Date, 'now', () => now);
  const rpc = device => request(relayPort, '/link/api/rpc', { method: 'POST', token: device.token, body: '{}', headers: { 'content-type': 'application/json' } });
  const page = device => request(relayPort, '/link/workbench/api/test', { cookie: device.cookie });
  const fill = async call => {
    for (let offset = 0; offset < 600; offset += 20) {
      const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => call(offset + index)));
      assert(responses.every(response => response.status === 200));
    }
  };
  await fill(index => request(relayPort, '/link/api/info', { token: 'forged-' + index, headers: { 'x-forwarded-for': `198.51.100.${index % 250}` } }));
  assert.equal((await request(relayPort, '/link/api/info', { headers: { 'x-forwarded-for': '203.0.113.2' } })).status, 429);
  assert.equal((await rpc(first)).status, 200, 'anonymous loopback traffic cannot exhaust a verified device');
  assert.equal((await page(first)).status, 200, 'verified workbench cookies use the device quota');
  assert.equal((await rpc(second)).status, 200);
  assert.equal((await page({ cookie: 'dsh_link_workbench=forged' })).status, 429, 'unverified cookies cannot bypass the anonymous quota');
  const pairing = store.begin();
  const otherSource = await request(relayPort, '/link/api/pair', { localAddress: '127.0.0.2', method: 'POST', body: JSON.stringify({ code: pairing.code, name: 'new source' }), headers: { 'content-type': 'application/json' } });
  assert.equal(otherSource.status, 200, 'another real source can still pair through the same loopback relay host');
  assert.equal(JSON.parse(otherSource.body).requestId.length > 0, true);
  assert.equal((await request(relayPort, '/link/api/info', { headers: { 'x-benchgo-relay-source': 'a'.repeat(64), 'x-benchgo-relay-proof': 'b'.repeat(64) } })).status, 429, 'client-supplied relay source headers cannot change the source');

  now += 60_000;
  await fill(index => index % 2 ? rpc(first) : page(first));
  assert.equal((await rpc(first)).status, 429);
  assert.equal((await page(first)).status, 429, 'bearer and cookie share one verified device identity');
  assert.equal((await rpc(second)).status, 200, 'one authenticated device cannot exhaust another device');
  assert.equal((await page(second)).status, 200);
  await store.revoke(second.deviceId); await workbench.revoke(second.deviceId);
  assert.equal((await rpc(second)).status, 401);
  assert.equal((await page(second)).status, 401);

  // With no host, reaching the quota still returns 429 instead of 503: the
  // public socket limit is enforced at the relay before any loopback request.
  await host.close();
  for (let i = 0; i < 50; i++) {
    const response = await request(relayPort, '/link/api/info');
    if (response.status === 503) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  now += 60_000;
  for (let offset = 0; offset < 600; offset += 20) {
    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => request(relayPort, '/link/api/info', { headers: { 'x-forwarded-for': `198.51.100.${(offset + index) % 250}` } })));
    assert(responses.every(response => response.status === 503));
  }
  assert.equal((await request(relayPort, '/link/api/info')).status, 429);
});

test('relay rejects excess voice upgrades without crashing and host close interrupts TLS handshake', { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'link-relay-limit-'));
  await mkdir(join(directory, 'relay'));
  const identity = await loadIdentity(join(directory, 'relay'));
  const relayPort = await freePort(), origin = `https://localhost:${relayPort}`;
  request.relayCert = identity.cert; request.relayOrigin = origin;
  const relay = await createRelayServer({ host: '127.0.0.1', port: relayPort, identity, publicUrl: origin, token: 'relay-host-secret-with-at-least-32-bytes' });
  const control = new WebSocket(`wss://localhost:${relayPort}/__link/relay/control`, { ca: identity.cert, origin, headers: { host: `localhost:${relayPort}`, authorization: 'Bearer relay-host-secret-with-at-least-32-bytes' }, perMessageDeflate: false });
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.terminate();
    control.terminate(); await relay.close(); await rm(directory, { recursive: true, force: true });
  });
  control.on('error', () => {});
  await once(control, 'open');
  let received = 0, resolveRequests;
  const allRequests = new Promise(resolve => { resolveRequests = resolve; });
  control.on('message', raw => {
    const input = JSON.parse(raw.toString());
    if (input.type === 'http') {
      const url = new URL('/__link/relay/data', origin); url.protocol = 'wss:';
      const data = new WebSocket(url, { ca: identity.cert, headers: { host: `localhost:${relayPort}`, authorization: 'Bearer ' + input.ticket }, perMessageDeflate: false });
      data.on('error', () => {}); data.once('open', () => data.close(1011, 'test drop'));
    } else if (input.type === 'voice' && ++received === 64) resolveRequests();
  });
  let timeout;
  const dropped = await Promise.race([
    request(relayPort, '/link/api/info'),
    new Promise(resolve => { timeout = setTimeout(() => resolve(undefined), 2_000); }),
  ]);
  clearTimeout(timeout);
  assert.equal(dropped?.status, 502, 'a closed data channel must end the pending HTTP response');
  for (let index = 0; index < 64; index++) {
    const client = new WebSocket(`wss://localhost:${relayPort}/link/workbench/api/voice/realtime`, { ca: identity.cert, origin, headers: { host: `localhost:${relayPort}` }, perMessageDeflate: false });
    client.on('error', () => {}); clients.push(client);
  }
  await allRequests;
  const overflow = new WebSocket(`wss://localhost:${relayPort}/link/workbench/api/voice/realtime`, { ca: identity.cert, origin, headers: { host: `localhost:${relayPort}` }, perMessageDeflate: false });
  clients.push(overflow);
  const status = await new Promise(resolve => {
    overflow.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode); });
    overflow.on('error', () => {});
  });
  assert.equal(status, 429);

  const stalled = createNetServer(() => {});
  stalled.listen(0, '127.0.0.1'); await once(stalled, 'listening');
  const port = stalled.address().port;
  const host = createRelayHost({ relayUrl: `https://127.0.0.1:${port}`, token: 'relay-host-secret-with-at-least-32-bytes', target: { url: 'https://127.0.0.1:48721', pin: 'A'.repeat(43) + '=' } });
  await once(stalled, 'connection');
  const started = Date.now(); await host.close();
  assert.ok(Date.now() - started < 2_000, 'close should not wait for the TLS handshake timeout');
  await new Promise(resolve => stalled.close(resolve));
});

test('connecting relay timeout reports once, retries and closes without uncaught socket errors', { timeout: 5_000 }, async t => {
  const accepted = new Set();
  const stalled = createNetServer(socket => {
    accepted.add(socket); socket.resume(); socket.once('close', () => accepted.delete(socket));
  });
  stalled.listen(0, '127.0.0.1'); await once(stalled, 'listening');
  const errors = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = createRelayHost({ relayUrl: `https://127.0.0.1:${stalled.address().port}`, token: 'relay-host-secret-with-at-least-32-bytes', target: { url: 'https://127.0.0.1:48721', pin: 'A'.repeat(43) + '=' }, onError: error => errors.push(error.message) });
  t.after(async () => {
    await host.close(); t.mock.timers.reset();
    for (const socket of accepted) socket.destroy();
    await new Promise(resolve => stalled.close(resolve));
  });
  await once(stalled, 'connection');
  t.mock.timers.tick(10_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, ['中继连接超时']);
  assert.deepEqual(host.status(), { connected: false, lastError: '中继连接超时' });

  const reconnect = once(stalled, 'connection');
  t.mock.timers.tick(1_000);
  await reconnect;
  await host.close();
  t.mock.timers.tick(60_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, ['中继连接超时'], 'closing a connecting retry must not publish another failure');
  assert.equal(host.status().connected, false);
});

test('read-only relay probe times out on a stalled TLS peer and sanitizes failures', async t => {
  const sockets = new Set();
  const stalled = createNetServer(socket => { sockets.add(socket); socket.resume(); socket.once('close', () => sockets.delete(socket)); });
  stalled.listen(0, '127.0.0.1'); await once(stalled, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => stalled.close(resolve)); });
  const token = 'private-secret-do-not-return';
  const value = await testRelayConnection({ url: `https://127.0.0.1:${stalled.address().port}`, token }, { timeout: 25 });
  assert.equal(value.ok, false); assert.match(value.message, /超时/);
  assert.equal(JSON.stringify(value).includes(token), false);
  assert.equal((await testRelayConnection({ url: 'http://relay.example', token })).ok, false);
});

test('relay and host reject weak credentials and non-loopback upstreams', async () => {
  assert.throws(() => createRelayHost({ relayUrl: 'https://relay.example', token: 'short', target: { url: 'https://127.0.0.1:443', pin: 'x' } }));
  assert.throws(() => createRelayHost({ relayUrl: 'https://relay.example', token: 'relay-host-secret-with-at-least-32-bytes', target: { url: 'https://example.com', pin: 'A'.repeat(43) + '=' } }), /loopback/);
  const identity = { key: 'key', cert: 'cert' };
  await assert.rejects(createRelayServer({ host: '127.0.0.1', port: 48730, identity, publicUrl: 'http://relay.example', token: 'relay-host-secret-with-at-least-32-bytes' }), /HTTPS/);
});
