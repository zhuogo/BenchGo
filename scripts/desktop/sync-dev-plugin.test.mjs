import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile, realpath, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { syncDevelopmentPlugin } from './sync-dev-plugin.mjs';
import { releaseBundleName } from '../../plugins/benchgo/shared/plugin-install.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-dev-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'selected-release');
  const source = join(root, 'plugins/benchgo');
  const target = join(directory, 'node_modules/benchgo-plugin');
  const wrapper = join(directory, 'node_modules', releaseBundleName('0.1.0'));
  await mkdir(wrapper, { recursive: true });
  await writeFile(join(wrapper, 'package.json'), JSON.stringify({ name: releaseBundleName('0.1.0'), exports: { './package.json': './package.json' } }));
  for (const base of [source, target]) {
    await mkdir(join(base, 'assets'), { recursive: true });
    await writeFile(join(base, 'assets/icon.svg'), base === source ? '<svg>BenchGo</svg>' : 'old icon');
    await mkdir(join(base, 'lib/link-web'), { recursive: true });
    await mkdir(join(base, 'lib/relay'), { recursive: true });
    for (const directory of ['src', 'shared', 'locale', 'lib/modules/harness/src', 'lib/modules/superagent/src', 'lib/modules/voice/src']) {
      await mkdir(join(base, directory), { recursive: true });
      await writeFile(join(base, directory, 'entry.mjs'), base === source ? `local:${directory}` : 'old source');
    }
    await writeFile(join(base, 'package.json'), JSON.stringify({ name: 'benchgo-plugin', version: '0.1.0', dependencies: { '@deepseek-ai/dsh-compaction-basic': '0.2.1-alpha.3' } }));
    await writeFile(join(base, 'cordis.patch.yml'), base === source ? '[{"insert":[{"id":"commander-harness","name":"benchgo-plugin/harness-plugin"}]}]' : '[]');
    for (const file of ['client.js', 'link.mjs', 'link-web/index.html', 'relay/run-relay-server.cjs']) {
      await writeFile(join(base, 'lib', file), base === source ? `local:${file}` : 'old seed');
    }
  }
  const official = join(root, 'official/node_modules/@deepseek-ai/dsh-llm');
  await mkdir(official, { recursive: true });
  await writeFile(join(official, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: '0.2.1-alpha.3' }));
  await mkdir(join(root, 'official/node_modules/@deepseek-ai/dsh-compaction-basic'), { recursive: true });
  await writeFile(join(root, 'official/node_modules/@deepseek-ai/dsh-compaction-basic/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-compaction-basic', version: '0.2.1-alpha.3' }));
  await mkdir(join(target, 'node_modules/@deepseek-ai'), { recursive: true });
  const require = createRequire(new URL('../../deepseek-harness/package.json', import.meta.url));
  await symlink(dirname(require.resolve('semver/package.json')), join(root, 'official/node_modules/semver'), 'junction');
  return { root, source, target, wrapper, enrollment: { managed: true, directory, runtime: join(root, 'official') } };
}

for (const mode of ['valid', 'slots', 'store', 'dockkit', 'missing-seed', 'wrong-version', 'unused-asset', 'node-dependency', 'unknown-peer']) test(`browser platform peer uses the installed official seed table: ${mode}`, async t => {
  const setup = await fixture(t);
  const put = async (base, path, value) => {
    await mkdir(dirname(join(base, path)), { recursive: true });
    await writeFile(join(base, path), typeof value === 'string' ? value : JSON.stringify(value));
  };
  await put(setup.enrollment.directory, 'release.json', { shared: [] });
  const name = ({ slots: '@deepseek-ai/dsh-client-ui-slots', store: '@deepseek-ai/dsh-client-store', dockkit: '@deepseek-ai/dsh-client-ui-dockkit', 'unknown-peer': '@deepseek-ai/dsh-client-unknown' })[mode] || '@deepseek-ai/dsh-client-ui-primitives';
  const manifest = JSON.parse(await readFile(join(setup.source, 'package.json'), 'utf8'));
  manifest.dependencies['fixture-client'] = '1.0.0';
  await put(setup.source, 'package.json', manifest);
  await put(setup.source, 'node_modules/fixture-client/package.json', { name: 'fixture-client', version: '1.0.0', [mode === 'node-dependency' ? 'dependencies' : 'peerDependencies']: { [name]: '^0.2.2-rc.1' } });
  const frontend = join(setup.root, 'official/node_modules/@deepseek-ai/dsh-web-frontend');
  await put(frontend, 'package.json', { name: '@deepseek-ai/dsh-web-frontend', version: mode === 'wrong-version' ? '0.1.0' : '0.2.2-rc.1' });
  await put(frontend, 'dist/index.html', '<script type="module" crossorigin src="./assets/index.js"></script>');
  const seed = 'function getStaticModules(){return {"@deepseek-ai/dsh-client-store":store,"@deepseek-ai/dsh-client-ui-slots":slots,"@deepseek-ai/dsh-client-ui-primitives":primitives,"@deepseek-ai/dsh-client-ui-dockkit":dockkit}}';
  await put(frontend, 'dist/assets/index.js', ['missing-seed', 'unused-asset'].includes(mode) ? 'console.log("@deepseek-ai/dsh-client-ui-primitives");' : seed);
  await put(frontend, 'dist/assets/unused.js', seed);
  if (!['valid', 'slots', 'store', 'dockkit'].includes(mode)) {
    await assert.rejects(syncDevelopmentPlugin(setup));
    assert.equal(await readFile(join(setup.target, 'lib/client.js'), 'utf8'), 'old seed');
    return;
  }
  for (let pass = 0; pass < 2; pass++) {
    await syncDevelopmentPlugin(setup);
    await assert.rejects(lstat(join(setup.target, 'node_modules', name)), { code: 'ENOENT' });
    const release = JSON.parse(await readFile(join(setup.enrollment.directory, 'release.json'), 'utf8'));
    assert.ok(!release.shared.some(item => item.name === name));
    assert.equal(await readFile(join(setup.target, 'lib/client.js'), 'utf8'), 'local:client.js');
  }
});

test('new third-party runtime SDK resolves from the installed release after synchronization', async t => {
  const setup = await fixture(t);
  await writeFile(join(setup.enrollment.directory, 'release.json'), JSON.stringify({ shared: [] }));
  const file = join(setup.source, 'package.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.dependencies['@example/channel-sdk'] = '1.0.0';
  await writeFile(file, JSON.stringify(manifest));
  const sdk = join(setup.source, 'node_modules/@example/channel-sdk');
  await mkdir(sdk, { recursive: true });
  await writeFile(join(sdk, 'package.json'), JSON.stringify({ name: '@example/channel-sdk', version: '1.0.0', main: 'index.js' }));
  await writeFile(join(sdk, 'index.js'), 'module.exports = { ready: true };');
  await syncDevelopmentPlugin(setup);
  assert.equal(createRequire(join(setup.target, 'package.json'))('@example/channel-sdk').ready, true);
  assert.equal(JSON.parse(await readFile(join(setup.target, 'package.json'), 'utf8')).dependencies['@example/channel-sdk'], '1.0.0');
  const release = JSON.parse(await readFile(join(setup.enrollment.directory, 'release.json'), 'utf8'));
  assert.ok(release.shared.every(item => item.name.startsWith('@deepseek-ai/')));
  await syncDevelopmentPlugin(setup);
  assert.equal(createRequire(join(setup.target, 'package.json'))('@example/channel-sdk').ready, true);
});

test('vendor utility versions stay private when the official host uses a different version', async t => {
  const setup = await fixture(t);
  const put = async (base, path, value) => {
    await mkdir(dirname(join(base, path)), { recursive: true });
    await writeFile(join(base, path), typeof value === 'string' ? value : JSON.stringify(value));
  };
  await put(setup.enrollment.directory, 'release.json', { shared: [] });
  const manifest = JSON.parse(await readFile(join(setup.source, 'package.json'), 'utf8'));
  manifest.dependencies['fixture-sidebar'] = '1.0.0';
  await put(setup.source, 'package.json', manifest);
  const vendor = join(setup.source, 'node_modules/fixture-sidebar');
  const versions = { '@deepseek-ai/schemastery': '3.18.5', '@deepseek-ai/cosmokit': '1.9.0' };
  await put(vendor, 'package.json', { name: 'fixture-sidebar', version: '1.0.0', dependencies: versions, peerDependencies: versions });
  await put(vendor, 'index.js', "module.exports = [require('@deepseek-ai/schemastery'), require('@deepseek-ai/cosmokit')];");
  for (const [name, version] of Object.entries(versions)) {
    await put(vendor, `node_modules/${name}/package.json`, { name, version });
    await put(vendor, `node_modules/${name}/index.js`, `module.exports = '${version}';`);
    await put(join(setup.root, 'official'), `node_modules/${name}/package.json`, { name, version: '9.0.0' });
    await put(join(setup.root, 'official'), `node_modules/${name}/index.js`, "module.exports = 'host';");
  }
  for (let pass = 0; pass < 2; pass++) {
    await syncDevelopmentPlugin(setup);
    assert.deepEqual(createRequire(join(setup.target, 'package.json'))('fixture-sidebar'), Object.values(versions));
    const release = JSON.parse(await readFile(join(setup.enrollment.directory, 'release.json'), 'utf8'));
    assert.ok(!release.shared.some(item => Object.hasOwn(versions, item.name)));
    for (const [name, version] of Object.entries(versions)) {
      const installed = join(setup.target, 'node_modules/fixture-sidebar/node_modules', name);
      assert.equal((await lstat(installed)).isSymbolicLink(), false);
      assert.equal(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version, version);
    }
  }
});

for (const legacyLink of [false, true]) test(`third-party closure shares host scope and Cordis, repairs junction=${legacyLink}, and syncs twice`, async t => {
  const setup = await fixture(t);
  const put = async (base, path, value) => {
    await mkdir(dirname(join(base, path)), { recursive: true });
    await writeFile(join(base, path), typeof value === 'string' ? value : JSON.stringify(value));
  };
  await put(setup.enrollment.directory, 'release.json', { shared: [] });
  const manifest = JSON.parse(await readFile(join(setup.source, 'package.json'), 'utf8'));
  manifest.dependencies['fixture-ops'] = '1.0.0';
  await put(setup.source, 'package.json', manifest);
  const ops = join(setup.source, 'node_modules/fixture-ops');
  await put(ops, 'package.json', { name: 'fixture-ops', version: '1.0.0', dependencies: { 'fixture-adapter': '1.0.0' }, optionalDependencies: { 'fixture-missing': '1.0.0' } });
  await put(ops, 'index.js', "module.exports = require('fixture-adapter');");
  const adapter = join(ops, 'node_modules/fixture-adapter');
  await put(adapter, 'package.json', { name: 'fixture-adapter', version: '1.0.0', dependencies: { '@deepseek-ai/dsh-scope': '1.0.0' }, peerDependencies: { '@deepseek-ai/dsh-peer': '1.0.0', '@deepseek-ai/dsh-optional-peer': '1.0.0' }, peerDependenciesMeta: { '@deepseek-ai/dsh-optional-peer': { optional: true } } });
  await put(adapter, 'index.js', "module.exports = require('@deepseek-ai/dsh-scope');");
  for (const base of [join(setup.root, 'official'), adapter]) {
    await put(base, 'node_modules/@deepseek-ai/dsh-scope/package.json', { name: '@deepseek-ai/dsh-scope', version: '1.0.0' });
    await put(base, 'node_modules/@deepseek-ai/dsh-scope/index.js', "module.exports = { scope: Symbol('scope'), cordis: require('cordis') };");
    await put(base, 'node_modules/cordis/package.json', { name: 'cordis', version: '1.0.0' });
    await put(base, 'node_modules/cordis/index.js', "module.exports = { context: Symbol('context') };");
  }
  await put(join(setup.root, 'official'), 'node_modules/@deepseek-ai/dsh-peer/package.json', { name: '@deepseek-ai/dsh-peer', version: '1.0.0' });
  const destination = join(setup.target, 'node_modules/fixture-ops');
  if (legacyLink) await symlink(ops, destination, 'junction');
  const host = createRequire(join(setup.root, 'official/package.json'))('@deepseek-ai/dsh-scope');
  assert.notEqual(createRequire(join(setup.source, 'package.json'))('fixture-ops'), host);
  const scopeManifest = 'node_modules/@deepseek-ai/dsh-scope/package.json';
  await put(join(setup.root, 'official'), scopeManifest, { name: '@deepseek-ai/dsh-scope', version: '9.0.0' });
  await assert.rejects(syncDevelopmentPlugin(setup), /版本不兼容/);
  assert.equal(await readFile(join(setup.target, 'lib/client.js'), 'utf8'), 'old seed');
  if (legacyLink) assert.equal((await lstat(destination)).isSymbolicLink(), true);
  await put(join(setup.root, 'official'), scopeManifest, { name: '@deepseek-ai/dsh-scope', version: '1.0.0' });
  for (let pass = 0; pass < 2; pass++) {
    await put(ops, 'revision.txt', String(pass));
    await syncDevelopmentPlugin(setup);
    assert.equal((await lstat(destination)).isSymbolicLink(), false);
    assert.equal(await readFile(join(destination, 'revision.txt'), 'utf8'), String(pass));
    // Runtime imports are intentionally supplied by official PluginPackages,
    // not Node's native lookup through physical unpacked links.
    await assert.rejects(lstat(join(setup.target, 'node_modules/@deepseek-ai/dsh-scope')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(setup.enrollment.directory, 'node_modules/@deepseek-ai/dsh-scope')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(destination, 'node_modules/fixture-adapter/node_modules/@deepseek-ai/dsh-scope')), { code: 'ENOENT' });
    const release = JSON.parse(await readFile(join(setup.enrollment.directory, 'release.json'), 'utf8'));
    assert.ok(release.shared.some(item => item.name === '@deepseek-ai/dsh-scope'));
    assert.ok(release.shared.some(item => item.name === '@deepseek-ai/dsh-peer'));
    assert.ok(!release.shared.some(item => item.name === '@deepseek-ai/dsh-optional-peer'));
  }
  assert.equal((await lstat(join(adapter, 'node_modules/@deepseek-ai/dsh-scope'))).isDirectory(), true);
});

test('third-party mismatch and unsafe destination reject before copying; ordinary dependencies survive', async t => {
  const setup = await fixture(t);
  const file = join(setup.source, 'package.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.dependencies['fixture-sdk'] = '1.0.0';
  await writeFile(file, JSON.stringify(manifest));
  const sdk = join(setup.source, 'node_modules/fixture-sdk');
  await mkdir(sdk, { recursive: true });
  await writeFile(join(sdk, 'package.json'), JSON.stringify({ name: 'fixture-sdk', version: '2.0.0' }));
  await assert.rejects(syncDevelopmentPlugin(setup), /版本不兼容/);
  assert.equal(await readFile(join(setup.target, 'lib/client.js'), 'utf8'), 'old seed');
  await writeFile(join(sdk, 'package.json'), JSON.stringify({ name: 'fixture-sdk', version: '1.0.0' }));
  const installed = join(setup.target, 'node_modules/fixture-sdk');
  await mkdir(installed);
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: 'fixture-sdk', version: '1.0.0' }));
  await writeFile(join(installed, 'user.txt'), 'keep');
  await syncDevelopmentPlugin(setup);
  assert.equal(await readFile(join(installed, 'user.txt'), 'utf8'), 'keep');
  const external = join(setup.root, 'external-sdk');
  await mkdir(external);
  await symlink(external, join(setup.target, 'node_modules/@example'), 'junction');
  manifest.dependencies['@example/sdk'] = '1.0.0';
  await writeFile(file, JSON.stringify(manifest));
  await mkdir(join(setup.source, 'node_modules/@example/sdk'), { recursive: true });
  await writeFile(join(setup.source, 'node_modules/@example/sdk/package.json'), JSON.stringify({ name: '@example/sdk', version: '1.0.0' }));
  await assert.rejects(syncDevelopmentPlugin(setup), /符号链接/);
  await assert.rejects(lstat(join(external, 'sdk')), { code: 'ENOENT' });
});

test('no dependencies does not require an official runtime anchor', async t => {
  const setup = await fixture(t);
  const file = join(setup.source, 'package.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  delete manifest.dependencies;
  await writeFile(file, JSON.stringify(manifest));
  delete setup.enrollment.runtime;
  await syncDevelopmentPlugin(setup);
});

test('missing release metadata rejects third-party copies before any writes', async t => {
  const setup = await fixture(t);
  const file = join(setup.source, 'package.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.dependencies['fixture-sdk'] = '1.0.0';
  await writeFile(file, JSON.stringify(manifest));
  const sdk = join(setup.source, 'node_modules/fixture-sdk');
  await mkdir(sdk, { recursive: true });
  await writeFile(join(sdk, 'package.json'), JSON.stringify({ name: 'fixture-sdk', version: '1.0.0' }));
  await assert.rejects(syncDevelopmentPlugin(setup), /缺少受管 release.json/);
  assert.equal(await readFile(join(setup.target, 'lib/client.js'), 'utf8'), 'old seed');
  await assert.rejects(lstat(join(setup.target, 'node_modules/fixture-sdk')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(setup.target, 'node_modules/@deepseek-ai/dsh-compaction-basic')), { code: 'ENOENT' });
});

for (const declaration of ['dependencies', 'peerDependencies']) for (const privateScope of [false, true]) test(`preserved user ${declaration} must resolve host singleton, private scope=${privateScope}`, async t => {
  const setup = await fixture(t);
  const manifest = JSON.parse(await readFile(join(setup.source, 'package.json'), 'utf8'));
  manifest.dependencies['fixture-user'] = '1.0.0';
  await writeFile(join(setup.source, 'package.json'), JSON.stringify(manifest));
  const packageManifest = { name: 'fixture-user', version: '1.0.0', dependencies: { 'fixture-adapter': '1.0.0' } };
  for (const base of [setup.source, setup.target]) {
    const sdk = join(base, 'node_modules/fixture-user');
    const adapter = join(sdk, 'node_modules/fixture-adapter');
    await mkdir(adapter, { recursive: true });
    await writeFile(join(sdk, 'package.json'), JSON.stringify(packageManifest));
    await writeFile(join(sdk, 'user.txt'), 'preserve');
    await writeFile(join(adapter, 'package.json'), JSON.stringify({ name: 'fixture-adapter', version: '1.0.0', [declaration]: { '@deepseek-ai/dsh-compaction-basic': '0.2.1-alpha.3' } }));
    if (base === setup.target && privateScope) {
      const copy = join(adapter, 'node_modules/@deepseek-ai/dsh-compaction-basic');
      await mkdir(copy, { recursive: true });
      await writeFile(join(copy, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-compaction-basic', version: '0.2.1-alpha.3' }));
    }
  }
  // With no local copy the official profile resolver supplies the service.
  if (privateScope) {
    await assert.rejects(syncDevelopmentPlugin(setup), /官方服务身份与宿主不一致/);
    assert.equal(await readFile(join(setup.target, 'lib/client.js'), 'utf8'), 'old seed');
  } else await syncDevelopmentPlugin(setup);
  assert.equal(await readFile(join(setup.target, 'node_modules/fixture-user/user.txt'), 'utf8'), 'preserve');
  assert.equal((await lstat(join(setup.target, 'node_modules/fixture-user'))).isSymbolicLink(), false);
});

test('copies local plugin sources and outputs to the enrolled release while preserving settings', async t => {
  const setup = await fixture(t);
  await writeFile(join(setup.target, 'settings.json'), 'preserved');
  assert.equal(await syncDevelopmentPlugin(setup), setup.target);
  for (const file of ['client.js', 'link.mjs', 'link-web/index.html', 'relay/run-relay-server.cjs']) {
    assert.equal(await readFile(join(setup.target, 'lib', file), 'utf8'), `local:${file}`);
  }
  assert.equal(await readFile(join(setup.target, 'settings.json'), 'utf8'), 'preserved');
  for (const directory of ['src', 'shared', 'locale', 'lib/modules/harness/src', 'lib/modules/superagent/src', 'lib/modules/voice/src']) {
    assert.equal(await readFile(join(setup.target, directory, 'entry.mjs'), 'utf8'), `local:${directory}`);
  }
  assert.equal(await readFile(join(setup.target, 'assets/icon.svg'), 'utf8'), '<svg>BenchGo</svg>');
  assert.equal(await readFile(join(setup.wrapper, 'icon.svg'), 'utf8'), '<svg>BenchGo</svg>');
  const patch = await readFile(join(setup.source, 'cordis.patch.yml'), 'utf8');
  assert.equal(await readFile(join(setup.target, 'cordis.patch.yml'), 'utf8'), patch);
  assert.equal(await readFile(join(setup.wrapper, 'cordis.patch.yml'), 'utf8'), patch);
  assert.deepEqual(JSON.parse(await readFile(join(setup.wrapper, 'package.json'), 'utf8')).exports, { './package.json': './package.json', './icon': './icon.svg' });
  await assert.rejects(lstat(join(setup.target, 'node_modules/@deepseek-ai/dsh-compaction-basic')), { code: 'ENOENT' });
});

test('updates migrated runtime exports while preserving installed metadata and custom exports', async t => {
  const setup = await fixture(t);
  const local = JSON.parse(await readFile(join(setup.source, 'package.json'), 'utf8'));
  local.exports = { '.': './src/plugin.mjs', './runtime': './lib/modules/harness/src/runtime.mjs' };
  local.files = ['src', 'shared', 'lib', 'locale'];
  local.main = './src/plugin.mjs';
  await writeFile(join(setup.source, 'package.json'), JSON.stringify(local));
  await writeFile(join(setup.source, 'lib/modules/harness/src/runtime.mjs'), 'export const migrated = true;');
  const installed = JSON.parse(await readFile(join(setup.target, 'package.json'), 'utf8'));
  installed.exports = { './runtime': './src/runtime.mjs', './custom': './custom.mjs', './base-plugin': './src/plugin.mjs', './base-plugin/locale/*.json': './locale/modules/base/*.json', './base-plugin/icon': './assets/icon.svg' };
  installed.dependencies['user-plugin'] = '1.2.3';
  installed.userSetting = { enabled: false };
  installed.files = ['src', 'agents', 'autoagent/src', 'voice/src'];
  await writeFile(join(setup.target, 'package.json'), JSON.stringify(installed));
  await syncDevelopmentPlugin(setup);
  const updated = JSON.parse(await readFile(join(setup.target, 'package.json'), 'utf8'));
  assert.deepEqual(updated.exports, { './runtime': './lib/modules/harness/src/runtime.mjs', './custom': './custom.mjs', '.': './src/plugin.mjs' });
  assert.equal(updated.dependencies['user-plugin'], '1.2.3');
  assert.deepEqual(updated.userSetting, { enabled: false });
  assert.deepEqual(updated.files, local.files);
  assert.equal(updated.main, local.main);
  const require = createRequire(join(setup.enrollment.directory, 'package.json'));
  assert.equal(await realpath(require.resolve('benchgo-plugin/runtime')), await realpath(join(setup.target, 'lib/modules/harness/src/runtime.mjs')));
});

test('mirrors owned source and generated trees and removes obsolete modules while preserving user and seed files', async t => {
  const setup = await fixture(t);
  const stale = ['agents/runtime.mjs', 'autoagent/src/service.mjs', 'voice/src/plugin.mjs', 'src/deleted.mjs', 'shared/deleted.mjs', 'locale/deleted.json', 'lib/deleted.mjs', 'lib/modules/harness/src/deleted.mjs', 'lib/link-web/deleted.js'];
  const preserved = ['settings.json', 'custom.mjs', 'node_modules/user-plugin/data.json', 'lib/server/server-seed.tar.gz'];
  for (const path of [...stale, ...preserved]) {
    await mkdir(dirname(join(setup.target, path)), { recursive: true });
    await writeFile(join(setup.target, path), path);
  }
  await syncDevelopmentPlugin(setup);
  for (const path of stale) await assert.rejects(lstat(join(setup.target, path)), { code: 'ENOENT' });
  for (const path of preserved) assert.equal(await readFile(join(setup.target, path), 'utf8'), path);
  assert.equal(await readFile(join(setup.target, 'lib/modules/harness/src/entry.mjs'), 'utf8'), 'local:lib/modules/harness/src');
});

test('obsolete module junction is unlinked without removing its external target', async t => {
  const setup = await fixture(t);
  const external = join(setup.root, 'external-module');
  await mkdir(external);
  await writeFile(join(external, 'keep.mjs'), 'external');
  await symlink(external, join(setup.target, 'agents'), 'junction');
  await syncDevelopmentPlugin(setup);
  await assert.rejects(lstat(join(setup.target, 'agents')), { code: 'ENOENT' });
  assert.equal(await readFile(join(external, 'keep.mjs'), 'utf8'), 'external');
});

for (const side of ['source', 'target']) test(`${side} nested junction prevents all mirror writes`, async t => {
  const setup = await fixture(t);
  const external = join(setup.root, 'external-files');
  await mkdir(external);
  await writeFile(join(external, 'keep.mjs'), 'external');
  await symlink(external, join(setup[side], 'src', 'external'), 'junction');
  await assert.rejects(syncDevelopmentPlugin(setup), /符号链接/);
  assert.equal(await readFile(join(setup.target, 'lib/client.js'), 'utf8'), 'old seed');
  assert.equal(await readFile(join(external, 'keep.mjs'), 'utf8'), 'external');
});

test('shared version mismatch blocks copying and preserves user dependencies', async t => {
  const setup = await fixture(t);
  await writeFile(join(setup.root, 'official/node_modules/@deepseek-ai/dsh-compaction-basic/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-compaction-basic', version: '9.0.0' }));
  await assert.rejects(syncDevelopmentPlugin(setup), /版本不兼容/);
  assert.equal(await readFile(join(setup.target, 'lib/client.js'), 'utf8'), 'old seed');
});

test('retires both legacy shared junctions without deleting the official service, including repeat sync', async t => {
  const setup = await fixture(t);
  const name = '@deepseek-ai/dsh-compaction-basic';
  const host = join(setup.enrollment.runtime, 'node_modules', name);
  await writeFile(join(host, 'keep.txt'), 'official');
  await writeFile(join(setup.enrollment.directory, 'release.json'), JSON.stringify({ shared: [{ name, version: '0.2.1-alpha.3' }] }));
  for (const base of [setup.target, setup.enrollment.directory]) {
    await mkdir(join(base, 'node_modules/@deepseek-ai'), { recursive: true });
    await symlink(host, join(base, 'node_modules', name), 'junction');
  }
  for (let pass = 0; pass < 2; pass++) {
    await syncDevelopmentPlugin(setup);
    for (const base of [setup.target, setup.enrollment.directory]) await assert.rejects(lstat(join(base, 'node_modules', name)), { code: 'ENOENT' });
    assert.equal(await readFile(join(host, 'keep.txt'), 'utf8'), 'official');
  }
});

for (const side of ['target', 'release']) test(`ordinary shared directory at ${side} blocks sync before any writes`, async t => {
  const setup = await fixture(t);
  const base = side === 'target' ? setup.target : setup.enrollment.directory;
  const copy = join(base, 'node_modules/@deepseek-ai/dsh-compaction-basic');
  await mkdir(copy, { recursive: true });
  await writeFile(join(copy, 'user.txt'), 'preserve');
  await assert.rejects(syncDevelopmentPlugin(setup), /共享依赖目标不是链接/);
  assert.equal(await readFile(join(copy, 'user.txt'), 'utf8'), 'preserve');
  assert.equal(await readFile(join(setup.target, 'lib/client.js'), 'utf8'), 'old seed');
});

test('missing explicit runtime rejects before mirror writes even if a legacy service link exists', async t => {
  const setup = await fixture(t);
  await symlink(join(setup.enrollment.runtime, 'node_modules/@deepseek-ai/dsh-llm'), join(setup.target, 'node_modules/@deepseek-ai/dsh-llm'), 'junction');
  delete setup.enrollment.runtime;
  await assert.rejects(syncDevelopmentPlugin(setup), /缺少官方运行时目录/);
  assert.equal(await readFile(join(setup.target, 'lib/client.js'), 'utf8'), 'old seed');
});

test('invalid management state, directory or package name cannot receive development files', async t => {
  const setup = await fixture(t);
  for (const enrollment of [null, { managed: false, directory: setup.enrollment.directory }, { managed: true, directory: 'relative' }]) {
    await assert.rejects(syncDevelopmentPlugin({ ...setup, enrollment }), /受管插件目录/);
  }
  await writeFile(join(setup.target, 'package.json'), JSON.stringify({ name: 'other-plugin' }));
  await assert.rejects(syncDevelopmentPlugin(setup), /插件包名不匹配/);
  assert.equal(await readFile(join(setup.target, 'lib/client.js'), 'utf8'), 'old seed');
});

for (const missing of ['link.mjs', 'relay', 'modules']) test(`missing ${missing} is reported before any output is copied`, async t => {
  const setup = await fixture(t);
  await rm(join(setup.source, 'lib', missing), { recursive: ['relay', 'modules'].includes(missing) });
  await assert.rejects(syncDevelopmentPlugin(setup), /开发插件同步失败.*未启动桌面/);
  assert.equal(await readFile(join(setup.target, 'lib/client.js'), 'utf8'), 'old seed');
});

for (const missing of ['src', 'shared']) test(`missing ${missing} sources block development synchronization`, async t => {
  const setup = await fixture(t);
  await rm(join(setup.source, missing), { recursive: true });
  await assert.rejects(syncDevelopmentPlugin(setup), /开发插件同步失败.*未启动桌面/);
  assert.equal(await readFile(join(setup.target, 'lib/client.js'), 'utf8'), 'old seed');
});
