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
  await symlink(official, join(target, 'node_modules/@deepseek-ai/dsh-llm'), 'junction');
  const require = createRequire(new URL('../../deepseek-harness/package.json', import.meta.url));
  await symlink(dirname(require.resolve('semver/package.json')), join(root, 'official/node_modules/semver'), 'junction');
  return { root, source, target, wrapper, enrollment: { managed: true, directory } };
}

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
  assert.equal(await realpath(join(setup.target, 'node_modules/@deepseek-ai/dsh-compaction-basic')), await realpath(join(setup.root, 'official/node_modules/@deepseek-ai/dsh-compaction-basic')));
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
