import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { hostScope } from '../../benchgo/shared/host-scope.mjs';
import { mountLink } from '../src/index.mjs';

test('host scope survives module replacement without retaining HMR or request identity', async () => {
  const hmr = new AsyncLocalStorage(), identity = new AsyncLocalStorage();
  const root = {};
  const initial = hostScope({ root });
  const replacement = await hmr.run(true, () => import('../../benchgo/shared/host-scope.mjs?reload-test'));
  await identity.run('paired-device', async () => {
    await hmr.run(true, async () => {
      const scope = replacement.hostScope({ root });
      assert.equal(scope, initial);
      await scope(async () => {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(hmr.getStore(), undefined);
        assert.equal(identity.getStore(), undefined);
      });
      assert.equal(hmr.getStore(), true);
      assert.equal(identity.getStore(), 'paired-device');
    });
  });
});

test('real Link HTTP requests can save settings after HMR remount and listener reconfiguration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-link-scope-'));
  const hmr = new AsyncLocalStorage(), root = {};
  hostScope({ root }); // The base plugin records the application startup boundary.
  const values = [], received = [];
  const routes = new Map();
  let link;
  t.after(async () => { await link?.close(); await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, 'devices.json'), JSON.stringify({ name: 'Scope test', host: '127.0.0.1', port: 0 }));
  const ctx = {
    root, get() {}, effect: fn => fn(), workspaceRegistry: { list: () => [] },
    connection: {
      fetch: { register: route => { routes.set(route.path, route); return () => {}; } },
      createPeer: options => ({ principal: options.principal, async dispose() {} }),
      createSharedFetchHandler: () => ({ requestBodyMode: () => 'buffered', async fetch(req, peer) {
        if (hmr.getStore()) return Response.json({ error: 'HMR transactions cannot be nested' });
        const value = await req.json();
        received.push(peer.principal.deviceId);
        values.push(value.preference);
        return Response.json({ preference: value.preference });
      } }),
    },
  };
  async function call(path, body, headers = {}) {
    const tls = JSON.parse(await readFile(join(directory, 'tls.json'), 'utf8'));
    return new Promise((resolve, reject) => {
      const req = request(`https://127.0.0.1:${link.status().port}${path}`, { method: 'POST', ca: tls.cert, headers: { 'content-type': 'application/json', ...headers } }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
        res.once('end', () => resolve({ value: JSON.parse(text), headers: res.headers }));
      });
      req.once('error', reject); req.end(JSON.stringify(body));
    });
  }
  async function saveTheme(preference) {
    const pair = await link.admin({ action: 'pairing', mode: 'lan' });
    const pending = await call('/link/api/pair', { code: pair.code, name: 'Paired browser' });
    await link.admin({ action: 'confirm', id: pending.value.requestId });
    const approved = await call('/link/api/pair/status', pending.value);
    const login = await call('/link/api/workbench', {}, { authorization: 'Bearer ' + approved.value.token });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const saved = await call('/link/workbench/api/settings/mutate', { preference }, { cookie });
    assert.deepEqual(saved.value, { preference });
    assert.equal(received.at(-1), approved.value.deviceId);
  }
  link = await mountLink(ctx, { directory, env: {} });
  await saveTheme('light');
  await link.close();
  const replacement = await hmr.run(true, () => import('../src/index.mjs?reload-test'));
  link = await hmr.run(true, () => replacement.mountLink({ ...ctx }, { directory, env: {} }));
  await saveTheme('dark');
  await hmr.run(true, () => link.admin({ action: 'configure', host: '127.0.0.1', port: 0 }));
  await saveTheme('light');
  assert.deepEqual(values, ['light', 'dark', 'light']);
  // A first install can itself happen under HMR. A native owner request rebases
  // the scope even for sockets already created by that transaction.
  await link.close();
  const hotRoot = {};
  link = await hmr.run(true, () => mountLink({ ...ctx, root: hotRoot }, { directory, env: {} }));
  const status = await routes.get('/api/commander-link').fetch(new Request('http://127.0.0.1/api/commander-link', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'status' }),
  }));
  assert.equal(status.status, 200);
  await saveTheme('dark');
  assert.deepEqual(values, ['light', 'dark', 'light', 'dark']);
});
