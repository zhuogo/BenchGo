import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:https';
import { openStore } from '../src/pairing/store.mjs';
import { loadIdentity } from '../src/transport/tls.mjs';
import { createWorkbench } from '../src/transport/workbench.mjs';
import { listen } from '../src/transport/server.mjs';
import { createDeviceProxy } from '../src/devices/proxy.mjs';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'link-sessions-')), identity = await loadIdentity(directory);
  await writeFile(join(directory, 'index.html'), '<html></html>');
  const ctx = { webServer: { renderIndex: html => html }, connection: {
    createPeer: () => ({ async dispose() {} }),
    createSharedFetchHandler: () => ({ fetch: async request => {
      if (new URL(request.url).pathname === '/api/applicationUnauthorized') {
        return Response.json({ error: '应用授权不足' }, { status: 401 });
      }
      return Response.json({ ok: true });
    } }),
  } };
  const f = { directory, identity };
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
  const read = path => fetch(base + path, {
    method: 'POST', body: '{"action":"state"}', headers: { 'content-type': 'application/json' },
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
  const responses = await Promise.all([read('api/commander'), read('api/commander/assistant'), fetch(base)]);
  assert.deepEqual(responses.map(response => response.status), [200, 200, 200]);
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

  await f.store.revoke(f.deviceId);
  const revoked = await Promise.all([read('api/commander'), read('api/commander/assistant'), fetch(base)]);
  assert.deepEqual(revoked.map(response => response.status), [401, 401, 401]);
  assert.equal(admissions, 4);
  assert.equal((await read('api/commander')).status, 401);
  assert.equal(admissions, 4);
});
