import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertEmbeddedServerSeed, assertSidebarPayload, DESKTOP_ELECTRON_LANGUAGES, inspectPluginPayload, omitClaudeNative,
  SERVER_BUILD_INPUTS, SERVER_PAYLOAD_FILES, serverInputDigest, serverResourceDelivery, SIDEBAR_PAYLOAD_FILES } from './payload-policy.mjs';
import { readInstallerLocales } from '../../deepseek-harness/apps/desktop/scripts/installer-locales.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('full remains default and online requires an explicit valid resource delivery', () => {
  assert.equal(serverResourceDelivery(), 'full');
  assert.equal(serverResourceDelivery('online'), 'online');
  for (const value of ['', 'auto', 'minimal']) assert.throws(() => serverResourceDelivery(value), /full or online/);
});
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'benchgo-payload-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)); };
  const plugin = join(root, 'plugin'), metadata = { name: 'benchgo-plugin', version: '0.1.4', benchgo: { releaseVersion: '0.1.5' } };
  const upstream = { version: '0.2.2-rc.5', commit: 'a'.repeat(40) }, files = ['package.json', 'src/plugin.mjs', 'lib/client.js'];
  for (const file of SERVER_BUILD_INPUTS) put(file, 'build-input');
  put('upstream.json', upstream);
  put('plugin/package.json', metadata); put('plugin/src/plugin.mjs', 'export default {};'); put('plugin/lib/client.js', 'client');
  put('plugin/package-lock.json', '{}'); put('plugins/base/shared/update-public-key.pem', 'test-public-key');
  const sourceDigest = serverInputDigest({ plugin, files, root });
  const manifest = { schemaVersion: 1, harnessVersion: upstream.version, harnessCommit: upstream.commit, pluginVersion: metadata.version, sourceDigest, sha256: hash('server-archive') };
  const descriptor = { schemaVersion: 1, delivery: 'full', releaseVersion: '0.1.5', pluginVersion: metadata.version, harnessVersion: upstream.version, harnessCommit: upstream.commit, sourceDigest };
  put('plugin/lib/server/resources.json', descriptor); put('plugin/lib/server/update-public-key.pem', 'test-public-key');
  put('plugin/lib/server/manifest.json', manifest); put('plugin/lib/server/server-seed.tar.gz', 'server-archive');
  for (const file of ['bootstrap.sh', 'bootstrap.mjs']) put(`plugin/lib/server/${file}`, readFileSync(join(root, 'scripts/server', file)));
  return { root, plugin, files, put, manifest, descriptor };
}

test('current full seed is bound to plugin, engine, inputs, bootstrap and public key', t => {
  const f = fixture(t);
  assert.equal(assertEmbeddedServerSeed(f).delivery, 'full');
  assert.equal(assertEmbeddedServerSeed(f).bytes, 14);
  f.put('plugin/src/plugin.mjs', 'changed-source');
  assert.throws(() => assertEmbeddedServerSeed(f), /inputs have changed/);
});

test('freshness does not depend recursively on the generated server directory but does include the lock and adapter', t => {
  const f = fixture(t), initial = serverInputDigest(f);
  f.put('plugin/lib/server/unrelated.json', '{}');
  assert.equal(serverInputDigest(f), initial);
  f.put('plugin/package-lock.json', '{"changed":true}');
  assert.notEqual(serverInputDigest(f), initial);
  assert.throws(() => assertEmbeddedServerSeed(f), /inputs have changed/);
});

test('corrupted, mismatched or partial full resources cannot become an implicit online fallback', t => {
  const f = fixture(t);
  f.put('plugin/lib/server/server-seed.tar.gz', 'damaged-archive');
  assert.throws(() => assertEmbeddedServerSeed(f), /checksum mismatch/);
  f.put('plugin/lib/server/server-seed.tar.gz', 'server-archive');
  f.put('plugin/lib/server/update-public-key.pem', 'different-key');
  assert.throws(() => assertEmbeddedServerSeed(f), /trust root/);
  f.put('plugin/lib/server/update-public-key.pem', 'test-public-key');
  rmSync(join(f.plugin, 'lib/server/bootstrap.mjs'));
  assert.throws(() => assertEmbeddedServerSeed({ ...f, delivery: 'online' }), /incomplete full/);
});

test('descriptor-only resources require an explicit online delivery and keep the pinned trust root', t => {
  const f = fixture(t);
  for (const file of SERVER_PAYLOAD_FILES) rmSync(join(f.plugin, 'lib/server', file));
  assert.throws(() => assertEmbeddedServerSeed({ ...f, delivery: 'online' }), /full server payload is missing/);
  f.descriptor.delivery = 'online';
  f.put('plugin/lib/server/resources.json', f.descriptor);
  assert.throws(() => assertEmbeddedServerSeed(f), /full delivery requires/);
  const result = assertEmbeddedServerSeed({ ...f, delivery: 'online' });
  assert.equal(result.delivery, 'online'); assert.equal(result.releaseVersion, '0.1.5');
  f.descriptor.releaseVersion = '0.1.3';
  f.put('plugin/lib/server/resources.json', f.descriptor);
  assert.throws(() => assertEmbeddedServerSeed({ ...f, delivery: 'online' }), /stale server resource descriptor/);
});

test('oversized nested seeds are rejected before copying', t => {
  const f = fixture(t);
  assert.throws(() => assertEmbeddedServerSeed({ ...f, budget: { serverSeedBytes: 10 } }), /explicit 10-byte budget/);
});

test('missing resources fail normal full/online builds and are allowed only for explicit internal seed construction', t => {
  const f = fixture(t);
  rmSync(join(f.plugin, 'lib/server'), { recursive: true });
  for (const delivery of ['full', 'online']) assert.throws(() => assertEmbeddedServerSeed({ ...f, delivery }), /server resources are missing/);
  assert.equal(assertEmbeddedServerSeed({ ...f, required: false }), null);
});

test('sidebar receipt preserves required host, all lazy chunks and notices and detects edits', t => {
  const f = fixture(t), directory = 'plugin/lib/modules/workbench/lib';
  const files = SIDEBAR_PAYLOAD_FILES.map(path => ({ path, bytes: 7, sha256: hash('runtime') }));
  for (const { path } of files) f.put(`${directory}/${path}`, 'runtime');
  f.put(`${directory}/sidebar-runtime.json`, { schemaVersion: 1, vendor: { name: 'dsh-better-sidebar', version: '0.30.1' }, files });
  assert.equal(assertSidebarPayload(f.plugin).files.length, 6);
  f.put(`${directory}/client-mermaid.js`, 'changed');
  assert.throws(() => assertSidebarPayload(f.plugin), /stale sidebar runtime asset client-mermaid.js/);
});

test('inventory separates embedded compressed archives and counts actual staged bytes without double counting', t => {
  const f = fixture(t), seed = join(f.root, 'seed');
  f.put('seed/release.json', '{}'); f.put('seed/node_modules/benchgo-plugin/src/plugin.mjs', '123');
  f.put('seed/node_modules/benchgo-plugin/node_modules/shared/index.js', '1234');
  f.put('seed/node_modules/benchgo-plugin/lib/server/server-seed.tar.gz', '12345');
  const result = inspectPluginPayload(seed);
  assert.equal(result.bytes, 14);
  assert.equal(result.categories.plugin.bytes, 3); assert.equal(result.categories.dependencies.bytes, 4); assert.equal(result.categories.serverSeed.bytes, 5);
  assert.throws(() => inspectPluginPayload(seed, { budget: { unpackedBytes: 13, entries: 1000 } }), /updater budget/);
  const external = join(f.root, 'external'); mkdirSync(external);
  symlinkSync(external, join(seed, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => inspectPluginPayload(seed), /unsupported staged entry/);
});

test('only the reviewed SDK native optional edges are removed, not the SDK or other Anthropic packages', () => {
  const name = '@anthropic-ai/claude-agent-sdk-win32-x64';
  const metadata = { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.300', optionalDependencies: { [name]: '0.3.300' } };
  assert.equal(omitClaudeNative(metadata, name), true);
  assert.equal(omitClaudeNative(metadata, '@anthropic-ai/sdk'), false);
  assert.equal(omitClaudeNative({ name: 'another-package' }, name), false);
  assert.throws(() => omitClaudeNative({ ...metadata, version: '0.3.301' }, name), /compatibility verification/);
  assert.throws(() => omitClaudeNative({ ...metadata, optionalDependencies: {} }, name), /must remain optional/);
});

test('Electron language budget keeps every declared installer/shell language', () => {
  const languages = new Set(DESKTOP_ELECTRON_LANGUAGES.map(value => value.split('-')[0]));
  assert.deepEqual(new Set(readInstallerLocales().map(locale => locale.id.split('_')[0])), languages);
  assert(DESKTOP_ELECTRON_LANGUAGES.includes('zh-CN')); assert(DESKTOP_ELECTRON_LANGUAGES.includes('pt-BR')); assert(DESKTOP_ELECTRON_LANGUAGES.includes('en-US'));
});
