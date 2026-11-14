import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, inspectPackagedProfile, packagedModules } from './packaged-profile-probe.mjs';

function fixture() {
  const services = new Map(Object.values(packagedModules).map(name => [name, {}]));
  const entries = Object.entries(packagedModules).map(([id]) => ({
    options: { id, name: id === 'commander' ? 'benchgo-plugin' : `benchgo-plugin/${id.slice(10)}-plugin` },
    disabled: false, fiber: { state: 2, inject: {}, ctx: { get: name => services.get(name) } },
  }));
  const routes = [];
  const ctx = { get: name => services.get(name), loader: { entries: () => entries },
    connection: { fetch: { register: route => { routes.push(route); return () => {}; } } }, effect: fn => fn() };
  return { services, entries, routes, ctx };
}

test('installed-profile diagnostic reports all five independently active services through the authenticated registry', async () => {
  const { ctx, routes } = fixture();
  apply(ctx);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/api/benchgo-packaging-probe');
  const response = await routes[0].fetch();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const report = await response.json();
  assert.equal(report.modules.length, 5);
  assert.ok(report.modules.every(row => row.available && row.state === 2 && row.missing.length === 0));
});

test('installed-profile diagnostic distinguishes failed imports, pending, disabled and missing entries', async () => {
  const { ctx, entries, services } = fixture();
  entries[0].fiber = undefined;
  entries[0].parent = { tree: { async import() { throw Error('missing dependency /?token=private-token Bearer private-token'); } } };
  services.delete('benchgo');
  entries[1].fiber.state = 0;
  entries[1].fiber.inject = { benchgo: {} };
  entries[2].disabled = true;
  entries.pop();
  const { modules } = await inspectPackagedProfile(ctx);
  assert.equal(modules[0].state, 'import-failed');
  assert.equal(modules[0].available, false);
  assert.match(modules[0].error, /missing dependency/);
  assert.doesNotMatch(modules[0].error, /private-token/);
  assert.deepEqual(modules[1].missing, ['benchgo']);
  assert.equal(modules[1].state, 0);
  assert.equal(modules[2].state, 'disabled');
  assert.equal(modules[4].state, 'missing');
});
