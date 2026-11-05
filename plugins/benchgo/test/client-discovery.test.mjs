import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { ClientModuleRegistry } from '../../../deepseek-harness/packages/client/modules/lib/index.js';

// Use the registry's own Cordis dependency, including its Service tracker.
const officialRequire = createRequire(new URL('../../../deepseek-harness/packages/client/modules/package.json', import.meta.url));
const { Context } = await import(pathToFileURL(officialRequire.resolve('@deepseek-ai/cordis')).href);
const packageUrl = new URL('../package.json', import.meta.url);
const packageRequire = createRequire(packageUrl);
const pkg = JSON.parse(readFileSync(packageUrl, 'utf8'));
const patch = parse(readFileSync(new URL(pkg.dsh.bundle.patch, packageUrl), 'utf8'));
const patchEntries = patch.flatMap(operation => operation.insert ?? []);
const clientUrl = new URL(pkg.exports['./client'], packageUrl);

async function discover(options = patchEntries) {
  const ctx = new Context();
  ctx.baseUrl = new URL('./', packageUrl).href;
  // Only Loader's entry/resolution seam is a fixture; discovery, package reads,
  // graph composition and bundle responses all run in the official service.
  const entries = options.map(options => ({
    options: { ...options }, fiber: {}, disabled: false,
    parent: { tree: { ctx } },
  }));
  ctx.provide('loader', {
    entries: () => entries.values(),
    internal: {
      version: 'v2',
      resolveSync: (_baseUrl, { specifier }) => ({
        format: 'module', url: pathToFileURL(packageRequire.resolve(specifier)).href,
      }),
    },
  });
  try {
    await ctx.plugin(ClientModuleRegistry);
    return {
      service: ctx.get('clientModules'),
      async setDisabled(id, disabled) {
        const entry = entries.find(entry => entry.options.id === id);
        assert(entry, `missing patch entry ${id}`);
        entry.disabled = disabled;
        entry.fiber = disabled ? undefined : {};
        ctx.emit('internal/plugin', { entry });
        await Promise.resolve();
      },
      dispose: () => ctx.fiber.dispose(),
    };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

test('the shipped five-entry patch discovers one BenchGo client and serves its actual build', async () => {
  assert.equal(patchEntries.length, 5);
  assert.equal(patchEntries.filter(entry => entry.name === pkg.name).length, 1);
  const fixture = await discover();
  try {
    const rows = fixture.service.graph().entries;
    assert.deepEqual(rows.map(row => row.id), ['benchgo-plugin']);
    assert.deepEqual(rows[0].inject, pkg.dsh.client.inject);
    assert.equal(fixture.service.clientPath(pkg.name), fileURLToPath(clientUrl));
    const response = await fixture.service.fetchBundle(new Request(new URL(rows[0].url, 'http://benchgo.test/')));
    assert.equal(response.status, 200);
    const body = await response.text();
    assert(body.includes(readFileSync(clientUrl, 'utf8').trimEnd()), 'serve the current client build bytes');
    const registrations = [];
    runInNewContext(body, { window: { __ModuleLoader__: { load: entry => registrations.push(entry) } } });
    assert.deepEqual(registrations.map(entry => entry.id), ['benchgo-plugin']);
    assert.equal(typeof registrations[0].factory, 'function');
  } finally { await fixture.dispose(); }
});

test('using only package subpaths leaves the official client graph empty', async () => {
  const subpath = patchEntries.find(entry => entry.name === `${pkg.name}/harness-plugin`);
  assert(subpath);
  const fixture = await discover(patchEntries.map(entry => entry.name === pkg.name ? { ...entry, name: subpath.name } : entry));
  try {
    assert.deepEqual(fixture.service.graph().entries, []);
    assert.equal(fixture.service.clientPath(pkg.name), undefined);
    const response = await fixture.service.fetchBundle(new Request(`http://benchgo.test/plugins/${pkg.name}/client.js`));
    assert.equal(response.status, 404);
  } finally { await fixture.dispose(); }
});

test('disabling and restoring the package-root entry removes and restores its client graph row', async () => {
  const base = patchEntries.find(entry => entry.name === pkg.name);
  assert(base);
  const fixture = await discover();
  try {
    const original = fixture.service.graph().entries[0];
    let changes = 0;
    const unsubscribe = fixture.service.onGraphChanged(() => { changes++; });
    await fixture.setDisabled(base.id, true);
    assert.deepEqual(fixture.service.graph().entries, []);
    assert.equal(fixture.service.clientPath(pkg.name), undefined);
    await fixture.setDisabled(base.id, false);
    assert.deepEqual(fixture.service.graph().entries, [original]);
    assert.equal(changes, 2);
    const response = await fixture.service.fetchBundle(new Request(new URL(original.url, 'http://benchgo.test/')));
    assert.equal(response.status, 200);
    unsubscribe();
  } finally { await fixture.dispose(); }
});
