import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { request } from 'node:https';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { openStore } from '../src/pairing/store.mjs';
import { loadIdentity } from '../src/transport/tls.mjs';
import { createWorkbench } from '../src/transport/workbench.mjs';
import { listen } from '../src/transport/server.mjs';
import { createDeviceProxy } from '../src/devices/proxy.mjs';

function readStream(ws, id) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const receive = raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.id !== id) return;
      frames.push(frame);
      if (frame.type === 'error') { ws.off('message', receive); reject(Error(frame.error)); }
      if (frame.type === 'end') { ws.off('message', receive); resolve(frames); }
    };
    ws.on('message', receive);
    ws.send(JSON.stringify({ type: 'open', id, body: { id, endpoint: 'fixture/read', payload: {} } }));
  });
}

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'link-sessions-')), identity = await loadIdentity(directory);
  await writeFile(join(directory, 'index.html'), '<html></html>');
  const ctx = { get() {}, webServer: { renderIndex: html => html }, connection: {
    createPeer: () => ({ async dispose() {} }),
    createSharedFetchHandler: () => ({ fetch: async request => {
      f.calls.push(new URL(request.url).pathname);
      if (new URL(request.url).pathname.startsWith('/api/commander-fonts/')) {
        return new Response('remote-font', { headers: { 'content-type': 'font/woff2', 'cache-control': 'private, max-age=31536000, immutable' } });
      }
      if (new URL(request.url).pathname === '/api/applicationUnauthorized') {
        return Response.json({ error: '应用授权不足' }, { status: 401 });
      }
      return Response.json({ ok: true });
    } }),
  } };
  const f = { directory, identity, calls: [], opened: [] };
  ctx.typertGateway = { wireStream: {
    failure: error => ({ message: error.message }),
    async open(endpoint) {
      f.opened.push(endpoint);
      return { async *[Symbol.asyncIterator]() { yield { ok: true }; } };
    },
  } };
  f.start = async () => {
    f.store = await openStore(directory);
    f.workbench = createWorkbench(ctx, f.store, { workbenchRoot: directory });
    f.server = await listen({ identity, config: { host: '127.0.0.1', port: 0 }, store: f.store, workbench: f.workbench, onError() {} });
  };
  f.call = (path, { token, cookie } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: f.server.port, servername: 'localhost', ca: identity.cert, path, method: 'POST', headers: {
      'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}),
    } }, res => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }));
    });
    req.on('error', reject); req.end('{}');
  });
  f.restart = async () => { await f.server.close(); await f.store.flush(); await f.start(); };
  await f.start();
  const pairing = f.store.begin(), pending = f.store.request(pairing.code, 'Phone');
  await f.store.decide(pending.requestId, true);
  const approved = f.store.poll(pending.requestId, pending.pollToken);
  f.token = approved.token; f.deviceId = approved.deviceId;
  f.login = async () => {
    const response = await f.call('/link/api/workbench', { token: f.token });
    assert.equal(response.status, 200); assert.ok(response.cookie); return response.cookie;
  };
  t.after(async () => { await f.server.close(); await f.store.flush(); await rm(directory, { recursive: true, force: true }); });
  return f;
}

test('workbench cookies survive instance and store restart with only credential hashes on disk', async t => {
  const f = await setup(t), cookie = await f.login();
  const saved = await readFile(join(f.directory, 'devices.json'), 'utf8');
  assert.equal(saved.includes(cookie.split('=')[1]), false);
  assert.equal(saved.includes(f.token), false);
  const sessions = JSON.parse(saved).workbenchSessions;
  assert.equal(sessions.length, 1);
  assert.deepEqual(Object.keys(sessions[0]).sort(), ['digest', 'expires', 'id', 'tokenHash']);
  await f.restart();
  assert.equal((await f.call('/link/workbench/api/status', { cookie })).status, 200);
  await f.workbench.revoke(f.deviceId);
  await f.restart();
  assert.equal((await f.call('/link/workbench/api/status', { cookie })).status, 401);
});

test('logout removes only its cookie durably and device revoke removes every cookie', async t => {
  const f = await setup(t), first = await f.login(), second = await f.login();
  assert.equal((await f.call('/link/workbench/disconnect', { cookie: first })).status, 200);
  await f.restart();
  assert.equal((await f.call('/link/workbench/api/status', { cookie: first })).status, 401);
  assert.equal((await f.call('/link/workbench/api/status', { cookie: second })).status, 200);
  await f.store.revoke(f.deviceId);
  await f.restart();
  assert.equal((await f.call('/link/workbench/api/status', { cookie: second })).status, 401);
  assert.equal((await f.call('/link/api/workbench', { token: f.token })).status, 401);
  assert.equal(f.store.state.workbenchSessions.length, 0);
});

test('concurrent cookie issuance keeps eight per device and expired or rotated credentials are rejected', async t => {
  const f = await setup(t), oldest = await f.login();
  const cookies = await Promise.all(Array.from({ length: 8 }, () => f.login()));
  assert.equal(f.store.state.workbenchSessions.length, 8);
  await f.restart();
  assert.equal((await f.call('/link/workbench/api/status', { cookie: oldest })).status, 401);
  assert.equal((await f.call('/link/workbench/api/status', { cookie: cookies.at(-1) })).status, 200);
  f.store.state.workbenchSessions.forEach(session => { session.expires = Date.now() - 1; });
  await f.store.persist(); await f.restart();
  assert.equal((await f.call('/link/workbench/api/status', { cookie: cookies.at(-1) })).status, 401);
  const current = await f.login();
  f.store.state.devices[0].tokenHash = 'a'.repeat(64);
  await f.store.persist(); await f.restart();
  assert.equal((await f.call('/link/workbench/api/status', { cookie: current })).status, 401);
});

test('workbench does not issue a cookie when persistent session storage fails', async t => {
  const f = await setup(t);
  t.mock.method(f.store, 'saveWorkbenchSession', async () => { throw new Error('storage unavailable'); });
  const response = await f.call('/link/api/workbench', { token: f.token });
  assert.equal(response.status, 400);
  assert.equal(response.cookie, undefined);
});

test('desktop proxy recovers an evicted workbench with one admission and never repeats a write', async t => {
  const f = await setup(t);
  let admissions = 0;
  const proxy = await createDeviceProxy({
    url: 'https://127.0.0.1:' + f.server.port, pin: f.identity.pin,
    authorize: () => { admissions++; return f.token; },
  });
  t.after(() => proxy.close());
  const open = await fetch(proxy.enter(), { redirect: 'manual' });
  const base = proxy.origin + open.headers.get('location');
  assert.equal(admissions, 1);
  const read = (path, action = 'state') => fetch(base + path, {
    method: 'POST', body: JSON.stringify({ action }), headers: { 'content-type': 'application/json' },
  });
  const write = () => fetch(base + 'api/commander', {
    method: 'POST', body: '{"action":"ensureRecent"}', headers: { 'content-type': 'application/json' },
  });

  // Match the deployed server's legacy JSON error without the new header.
  const handle = f.workbench.handle;
  f.workbench.handle = async (req, res, ...args) => {
    try { await handle(req, res, ...args); }
    catch (error) { res.removeHeader('x-benchgo-workbench-session'); throw error; }
  };
  await Promise.all(Array.from({ length: 8 }, () => f.login()));
  const responses = await Promise.all([read('api/commander'), read('api/commander/assistant'), fetch(base), read('api/commander/updates', 'status')]);
  assert.deepEqual(responses.map(response => response.status), [200, 200, 200, 200]);
  assert.equal(admissions, 2);
  assert.deepEqual(await responses[0].json(), { ok: true });
  assert.match(await responses[2].text(), /<html>/);

  const unauthorized = await fetch(base + 'api/applicationUnauthorized');
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: '应用授权不足' });
  assert.equal(admissions, 2);

  f.workbench.handle = handle;
  f.store.state.workbenchSessions.forEach(session => { session.expires = Date.now() - 1; });
  const rejectedWrite = await write();
  assert.equal(rejectedWrite.status, 409);
  assert.match((await rejectedWrite.json()).error, /连接已恢复/);
  assert.equal(admissions, 3);
  assert.equal((await read('api/commander')).status, 200);

  f.store.state.workbenchSessions.forEach(session => { session.expires = Date.now() - 1; });
  const install = await read('api/commander/updates', 'install');
  assert.equal(install.status, 409, 'install is never replayed after reauthorization');
  assert.equal(admissions, 4);

  await f.store.revoke(f.deviceId);
  const revoked = await Promise.all([read('api/commander'), read('api/commander/assistant'), fetch(base)]);
  assert.deepEqual(revoked.map(response => response.status), [401, 401, 401]);
  assert.equal(admissions, 5);
  assert.equal((await read('api/commander')).status, 401);
  assert.equal(admissions, 5);
});

test('desktop proxy serves exact installed font subsets locally and preserves hashed font caching', async t => {
  const f = await setup(t);
  const fontRoot = new URL('../../base/assets/fonts/', import.meta.url);
  const [{ file }] = JSON.parse(await readFile(new URL('manifest.json', fontRoot), 'utf8'));
  const proxy = await createDeviceProxy({ url: 'https://127.0.0.1:' + f.server.port, pin: f.identity.pin, token: f.token }, { fontRoot });
  t.after(() => proxy.close());
  assert.equal((await fetch(proxy.origin + '/link/workbench/api/commander-fonts/' + file)).status, 403);
  const entry = await fetch(proxy.enter(), { redirect: 'manual' });
  const base = proxy.origin + entry.headers.get('location');
  const font = await fetch(base + 'api/commander-fonts/' + file);
  assert.equal(font.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.deepEqual(Buffer.from(await font.arrayBuffer()), await readFile(new URL('web/' + file, fontRoot)));
  const head = await fetch(base + 'api/commander-fonts/' + file, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(f.calls.length, 0);
  const unknown = await fetch(base + 'api/commander-fonts/fangyuan-latin-000000000000.woff2');
  assert.equal(await unknown.text(), 'remote-font');
  assert.equal(unknown.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  const state = await fetch(base + 'api/commander', { method: 'POST', body: '{"action":"state"}', headers: { 'content-type': 'application/json' } });
  assert.equal(state.headers.get('cache-control'), 'no-store');
});

test('missing or corrupted installed font subsets fall back to the authorized remote host', async t => {
  const f = await setup(t);
  const fontRoot = pathToFileURL(join(f.directory, 'fonts') + '/');
  const file = 'fangyuan-latin-000000000000.woff2';
  await mkdir(new URL('web/', fontRoot), { recursive: true });
  await writeFile(new URL('manifest.json', fontRoot), JSON.stringify([{ file }]));
  const proxy = await createDeviceProxy({ url: 'https://127.0.0.1:' + f.server.port, pin: f.identity.pin, token: f.token }, { fontRoot });
  t.after(() => proxy.close());
  const entry = await fetch(proxy.enter(), { redirect: 'manual' });
  const base = proxy.origin + entry.headers.get('location');
  for (const corrupted of [false, true]) {
    if (corrupted) await writeFile(new URL('web/' + file, fontRoot), 'wrong-content');
    const response = await fetch(base + 'api/commander-fonts/' + file);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'remote-font');
  }
  assert.equal(f.calls.length, 2);
});

test('multiplexed streams renew expired and legacy cookies once before opening and respect revocation', async t => {
  const f = await setup(t);
  let admissions = 0;
  const proxy = await createDeviceProxy({ url: 'https://127.0.0.1:' + f.server.port, pin: f.identity.pin, authorize: () => { admissions++; return f.token; } });
  t.after(() => proxy.close());
  const entry = await fetch(proxy.enter(), { redirect: 'manual' });
  const prefix = entry.headers.get('location').replace('/link/workbench/', '');
  const ws = new WebSocket(proxy.origin.replace('http:', 'ws:') + prefix + '/socket', { origin: proxy.origin });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  const open = id => readStream(ws, id);
  for (const legacy of [false, true]) {
    const handle = f.workbench.handle;
    if (legacy) f.workbench.handle = async (req, res, ...args) => {
      try { await handle(req, res, ...args); }
      catch (error) { res.removeHeader('x-benchgo-workbench-session'); throw error; }
    };
    f.store.state.workbenchSessions.forEach(session => { session.expires = Date.now() - 1; });
    const frames = await Promise.all([open('one-' + legacy), open('two-' + legacy)]);
    for (const stream of frames) {
      assert.equal(stream[0].status, 200);
      assert(stream.some(frame => frame.value?.type === 'item' && frame.value.value.ok));
    }
    assert.equal(admissions, legacy ? 3 : 2);
    assert.equal(f.opened.length, legacy ? 4 : 2);
    f.workbench.handle = handle;
  }
  await f.store.revoke(f.deviceId);
  const rejected = await open('revoked');
  assert.equal(rejected[0].status, 401);
  assert.equal(f.opened.length, 4);
});

test('stream cancellation during cookie renewal never opens the cancelled operation', { timeout: 10000 }, async t => {
  const f = await setup(t);
  const target = { url: 'https://127.0.0.1:' + f.server.port, pin: f.identity.pin, cookie: await f.login() };
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const proxy = await createDeviceProxy(target, { workbenchLease: async () => {
    entered.resolve();
    await release.promise;
    return { ...target, cookie: await f.login() };
  } });
  t.after(() => { release.resolve(); return proxy.close(); });
  const entry = await fetch(proxy.enter(), { redirect: 'manual' });
  const prefix = entry.headers.get('location').replace('/link/workbench/', '');
  const ws = new WebSocket(proxy.origin.replace('http:', 'ws:') + prefix + '/socket', { origin: proxy.origin });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  const frames = [];
  ws.on('message', raw => frames.push(JSON.parse(raw.toString())));
  f.store.state.workbenchSessions.forEach(session => { session.expires = Date.now() - 1; });
  ws.send(JSON.stringify({ type: 'open', id: 'cancelled', body: { endpoint: 'fixture/read', payload: {} } }));
  await entered.promise;
  ws.send(JSON.stringify({ type: 'cancel', id: 'cancelled' }));
  const pong = once(ws, 'pong');
  ws.ping();
  await pong;
  const next = readStream(ws, 'active');
  release.resolve();
  assert.equal((await next)[0].status, 200);
  assert.deepEqual(f.opened, ['fixture/read']);
  assert.equal(frames.some(frame => frame.id === 'cancelled'), false);
});

for (const failure of ['network', 'application']) {
  test(`stream ${failure} failures preserve their status without false credential rejection`, { timeout: 10000 }, async t => {
    const f = await setup(t);
    let renewals = 0;
    const target = { url: 'https://127.0.0.1:' + f.server.port, pin: f.identity.pin, cookie: await f.login() };
    const proxy = await createDeviceProxy(target, { workbenchLease: async () => {
      renewals++;
      throw new Error('upstream unavailable');
    } });
    t.after(() => proxy.close());
    if (failure === 'network') f.store.state.workbenchSessions.forEach(session => { session.expires = Date.now() - 1; });
    else {
      const handle = f.workbench.handle;
      f.workbench.handle = async (req, res, ...args) => {
        if (new URL(req.url, target.url).pathname.endsWith('/remote/open')) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'application denied' }));
        } else await handle(req, res, ...args);
      };
    }
    const entry = await fetch(proxy.enter(), { redirect: 'manual' });
    const prefix = entry.headers.get('location').replace('/link/workbench/', '');
    const ws = new WebSocket(proxy.origin.replace('http:', 'ws:') + prefix + '/socket', { origin: proxy.origin });
    t.after(() => ws.terminate());
    await once(ws, 'open');
    for (const id of ['first', 'second']) {
      const frames = await readStream(ws, id);
      assert.equal(frames[0].status, failure === 'network' ? 502 : 401);
    }
    assert.equal(renewals, failure === 'network' ? 1 : 0);
    assert.equal(f.opened.length, 0);
  });
}
