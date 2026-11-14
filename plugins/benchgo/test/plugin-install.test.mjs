import test from 'node:test';
import assert from 'node:assert/strict';
import * as filesystem from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath, readdir, lstat } from 'node:fs/promises';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as tar from 'tar';
import { prepareRelease, activateRelease, getInstallState, releaseBundleName } from '../shared/plugin-install.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (file, value) => { file = join(root, file); await mkdir(dirname(file), { recursive: true }); await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const profile = join(root, 'profile'), releases = join(profile, '.benchgo/releases');
  await put('profile/package.json', { name: 'test-profile', private: true, dependencies: { kept: '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } });
  await put('profile/cordis.patch.yml', '# keep user config\n');
  const seed = async (version, shared = []) => {
    const prefix = `seed-${version}`;
    await put(`${prefix}/release.json`, { schemaVersion: 1, version, platform: process.platform, arch: process.arch, shared });
    const exports = { '.': './src/plugin.mjs', './harness-plugin': './lib/modules/harness/src/plugin.mjs', './superagent-plugin': './lib/modules/superagent/src/plugin.mjs', './voice-plugin': './lib/modules/voice/src/plugin.mjs' };
    await put(`${prefix}/node_modules/benchgo-plugin/package.json`, { name: 'benchgo-plugin', version, type: 'module', main: './src/plugin.mjs', exports });
    for (const file of ['src/plugin.mjs', 'lib/client.js', 'lib/link.mjs', 'lib/link-web/index.html', ...Object.values(exports), 'cordis.patch.yml']) await put(`${prefix}/node_modules/benchgo-plugin/${file}`, 'export default true;');
    const bundleName = releaseBundleName(version);
    await put(`${prefix}/node_modules/${bundleName}/package.json`, { name: bundleName, version, dependencies: { 'benchgo-plugin': version }, dsh: { bundle: { patch: './cordis.patch.yml' } } });
    await put(`${prefix}/node_modules/${bundleName}/cordis.patch.yml`, '[]\n');
    const directory = join(root, prefix), archive = join(root, `${version}.tar.gz`);
    await tar.c({ file: archive, cwd: directory, gzip: true }, ['release.json', 'node_modules']);
    return { archive, directory, root: releases, version };
  };
  return { root, releases, profile, put, seed };
}

test('complete archive installs offline and upgrades atomically with settings and app version preserved', async t => {
  const { profile, seed } = await fixture(t);
  const first = await prepareRelease(await seed('0.1.0'));
  assert.equal((await getInstallState(profile)).managed, false, 'preparation does not change activation');
  let state = await activateRelease({ profile, release: first, enabled: true, appVersion: '0.1.0' });
  assert.equal(state.enabled, true);
  const wrapperRequire = createRequire(await realpath(join(profile, 'node_modules', state.bundleName, 'package.json')));
  assert.equal(await realpath(wrapperRequire.resolve('benchgo-plugin')), await realpath(join(first.pluginPath, 'src/plugin.mjs')));
  const second = await prepareRelease(await seed('0.1.1'));
  state = await activateRelease({ profile, release: second });
  assert.equal(state.version, '0.1.1');
  assert.equal(state.appVersion, '0.1.0', 'plugin updates do not change the installed app version');
  assert.equal(Object.hasOwn(state, 'previous'), false);
  const manifest = JSON.parse(await readFile(join(profile, 'package.json')));
  assert.equal(Object.hasOwn(manifest.dsh.plusInstall, 'previous'), false, 'activation does not store a former-version pointer');
  assert.equal(manifest.dependencies.kept, '1.0.0');
  assert.equal(Object.hasOwn(manifest.dependencies, first.bundleName), false);
  assert.equal(manifest.dsh.profile.bundles.includes(first.bundleName), false);
  assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), '# keep user config\n');
  assert.equal(state.enabled, true);
});

test('disabled plugin remains disabled during upgrade', async t => {
  const { profile, seed } = await fixture(t);
  await activateRelease({ profile, release: await prepareRelease(await seed('0.1.0')), enabled: false });
  await activateRelease({ profile, release: await prepareRelease(await seed('0.1.1')) });
  assert.equal((await getInstallState(profile)).enabled, false);
});

test('legacy former-version pointers are not exposed and disappear on the next activation', async t => {
  const { profile, seed } = await fixture(t);
  const first = await prepareRelease(await seed('0.1.0'));
  await activateRelease({ profile, release: first, enabled: true });
  const file = join(profile, 'package.json'), manifest = JSON.parse(await readFile(file));
  manifest.dsh.plusInstall.previous = { version: '0.0.9', directory: 'obsolete', bundleName: 'obsolete' };
  await writeFile(file, JSON.stringify(manifest));
  assert.equal(Object.hasOwn(await getInstallState(profile), 'previous'), false);
  await activateRelease({ profile, release: await prepareRelease(await seed('0.1.1')) });
  assert.equal(Object.hasOwn(JSON.parse(await readFile(file)).dsh.plusInstall, 'previous'), false);
});

test('a running plugin cannot silently activate over a legacy physical package', async t => {
  const { profile, seed, put } = await fixture(t);
  const first = await prepareRelease(await seed('0.1.6'));
  await activateRelease({ profile, release: first, enabled: true });
  const before = await readFile(join(profile, 'package.json'), 'utf8');
  await put('profile/node_modules/benchgo/package.json', { name: 'benchgo', version: '0.1.6' });
  await put('profile/node_modules/benchgo/keep.txt', 'old plugin files');
  const next = await prepareRelease(await seed('0.1.9'));
  await assert.rejects(activateRelease({ profile, release: next }), /关闭BenchGo/);
  assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), before);
  assert.equal(await readFile(join(profile, 'node_modules/benchgo/keep.txt'), 'utf8'), 'old plugin files');
});

test('offline migration removes a legacy junction without deleting its target or immutable release files', async t => {
  const { root, profile, seed, put } = await fixture(t);
  const first = await prepareRelease(await seed('0.1.6'));
  await activateRelease({ profile, release: first, enabled: true });
  await put('external-plugin/package.json', { name: 'benchgo', version: '0.1.6' });
  await put('external-plugin/keep.txt', 'preserve linked target');
  await symlink(join(root, 'external-plugin'), join(profile, 'node_modules/benchgo'), process.platform === 'win32' ? 'junction' : 'dir');
  const next = await prepareRelease(await seed('0.1.9'));
  await activateRelease({ profile, release: next, migrateLegacy: true });
  await assert.rejects(lstat(join(profile, 'node_modules/benchgo')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'external-plugin/keep.txt'), 'utf8'), 'preserve linked target');
  assert.equal(JSON.parse(await readFile(join(first.pluginPath, 'package.json'))).version, '0.1.6');
  assert.equal((await getInstallState(profile)).version, '0.1.9');
  assert.equal((await readdir(join(profile, '.benchgo'))).some(name => name.startsWith('.legacy-')), false);
});

test('offline migration refuses an unrecognized package at the plugin location', async t => {
  const { profile, seed, put } = await fixture(t);
  const release = await prepareRelease(await seed('0.1.9'));
  const before = await readFile(join(profile, 'package.json'), 'utf8');
  await put('profile/node_modules/benchgo/package.json', { name: 'user-owned-package', version: '1.0.0' });
  await put('profile/node_modules/benchgo/keep.txt', 'user data');
  await assert.rejects(activateRelease({ profile, release, migrateLegacy: true }), /原文件已保留/);
  assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), before);
  assert.equal(await readFile(join(profile, 'node_modules/benchgo/keep.txt'), 'utf8'), 'user data');
});

test('failed manifest commit restores the legacy plugin and leaves the selected version unchanged', async t => {
  const { profile, seed, put } = await fixture(t);
  const first = await prepareRelease(await seed('0.1.6'));
  await activateRelease({ profile, release: first, enabled: true });
  const before = await readFile(join(profile, 'package.json'), 'utf8');
  await put('profile/node_modules/benchgo/package.json', { name: 'benchgo', version: '0.1.6' });
  await put('profile/node_modules/benchgo/keep.txt', 'restore old files');
  const next = await prepareRelease(await seed('0.1.9'));
  const builtin = createRequire(import.meta.url)('node:fs/promises');
  const rename = builtin.rename;
  t.mock.method(builtin, 'rename', async (source, destination) => {
    if (destination === join(profile, 'package.json')) {
      await assert.rejects(filesystem.lstat(join(profile, 'node_modules/benchgo')), { code: 'ENOENT' });
      throw Object.assign(new Error('simulated manifest commit failure'), { code: 'EIO' });
    }
    return rename(source, destination);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(activateRelease({ profile, release: next, migrateLegacy: true }), /simulated manifest commit failure/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), before);
  assert.equal(await readFile(join(profile, 'node_modules/benchgo/keep.txt'), 'utf8'), 'restore old files');
  assert.equal((await readdir(join(profile, '.benchgo'))).some(name => name.startsWith('.legacy-')), false);
});

test('activation coordinates with official plugin-manager writers and preserves their completed changes', async t => {
  const { profile, seed } = await fixture(t);
  const release = await prepareRelease(await seed('0.1.0'));
  const atomic = await import('@deepseek-ai/dsh-atomic-write');
  const filename = join(profile, 'package.json');
  let activating, completed = false;
  await atomic.withFileLock(filename, async () => {
    activating = activateRelease({ profile, release, enabled: true }).then(value => { completed = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(completed, false, 'activation waits for the official writer lock');
    const manifest = JSON.parse(await readFile(filename));
    manifest.dependencies.concurrent = '2.0.0';
    await atomic.writeFileAtomic(filename, JSON.stringify(manifest), { mode: 0o600 });
  });
  await activating;
  assert.equal(JSON.parse(await readFile(filename)).dependencies.concurrent, '2.0.0');
});

test('shared services validate matching official runtime without native shadows and conflicting old sealed Plus is refused', async t => {
  const { root, profile, seed, put } = await fixture(t);
  const runtime = join(root, 'runtime');
  await put('runtime/node_modules/@deepseek-ai/dsh-llm/package.json', { name: '@deepseek-ai/dsh-llm', version: '0.2.1-alpha.3' });
  const options = await seed('0.1.0', [{ name: '@deepseek-ai/dsh-llm', version: '0.2.1-alpha.3' }]);
  const release = await prepareRelease({ ...options, runtime });
  await assert.rejects(lstat(join(release.directory, 'node_modules/@deepseek-ai/dsh-llm')), { code: 'ENOENT' });
  await put('runtime/node_modules/benchgo-plugin/package.json', { name: 'benchgo-plugin', version: '0.0.1' });
  await assert.rejects(prepareRelease({ ...await seed('0.1.1'), runtime }), /新版应用/);
  assert.equal((await getInstallState(profile)).managed, false);
});

test('shared runtime refresh preserves occupied physical directories', async t => {
  const { root, seed, put } = await fixture(t);
  const service = { name: '@deepseek-ai/dsh-llm', version: '0.2.1-alpha.3' };
  await put('runtime/node_modules/@deepseek-ai/dsh-llm/package.json', service);
  const options = await seed('0.1.0', [service]);
  const release = await prepareRelease({ ...options, runtime: join(root, 'runtime') });
  const target = join(release.directory, 'node_modules', service.name);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'user.txt'), 'keep');
  await assert.rejects(prepareRelease({ ...options, runtime: join(root, 'runtime') }), /不得覆盖官方共享服务/u);
  assert.equal(await readFile(join(target, 'user.txt'), 'utf8'), 'keep');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'runtime/node_modules', service.name, 'package.json'), 'utf8')), service);
});

test('shared services already linked beside the plugin are removed so the official runtime copy is used', async t => {
  const { root, profile, seed, put } = await fixture(t);
  const runtime = join(root, 'runtime');
  const shared = [{ name: '@deepseek-ai/dsh-llm', version: '0.2.1-alpha.3' }];
  await put('runtime/node_modules/@deepseek-ai/dsh-llm/package.json', { name: shared[0].name, version: shared[0].version });
  const options = await seed('0.1.0', shared);
  const release = await prepareRelease({ ...options, runtime });
  await put('legacy/node_modules/@deepseek-ai/dsh-llm/package.json', shared[0]);
  await put('private/node_modules/@deepseek-ai/schemastery/package.json', { name: '@deepseek-ai/schemastery', version: 'private' });
  for (const base of [release.directory, release.pluginPath]) {
    const modules = join(base, 'node_modules/@deepseek-ai');
    await mkdir(modules, { recursive: true });
    await symlink(join(root, 'legacy/node_modules/@deepseek-ai/dsh-llm'), join(modules, 'dsh-llm'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(join(root, 'private/node_modules/@deepseek-ai/schemastery'), join(modules, 'schemastery'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  await prepareRelease({ ...options, runtime });
  for (const base of [release.directory, release.pluginPath]) {
    await assert.rejects(lstat(join(base, 'node_modules/@deepseek-ai/dsh-llm')), { code: 'ENOENT' });
    assert.equal((await lstat(join(base, 'node_modules/@deepseek-ai/schemastery'))).isSymbolicLink(), true);
  }
  assert.equal(JSON.parse(await readFile(join(root, 'legacy/node_modules/@deepseek-ai/dsh-llm/package.json'), 'utf8')).version, '0.2.1-alpha.3');
  assert.equal((await getInstallState(profile)).managed, false);
});

test('reuse of a prepared release revalidates shared-service compatibility without changing activation', async t => {
  const { root, profile, seed, put } = await fixture(t);
  const runtime = join(root, 'runtime');
  const shared = [{ name: '@deepseek-ai/dsh-llm', version: '0.2.1-alpha.3' }];
  await put('runtime/node_modules/@deepseek-ai/dsh-llm/package.json', { name: shared[0].name, version: shared[0].version });
  await activateRelease({ profile, release: await prepareRelease({ ...await seed('0.1.0', shared), runtime }), enabled: true });
  const next = { ...await seed('0.1.1', shared), runtime };
  await activateRelease({ profile, release: await prepareRelease(next) });
  await put('runtime/node_modules/@deepseek-ai/dsh-llm/package.json', { name: shared[0].name, version: '0.2.2' });
  await assert.rejects(prepareRelease(next), /版本不兼容/);
  assert.equal((await getInstallState(profile)).version, '0.1.1');
});

test('unsafe archive entries and links are rejected before extraction without changing profile', async t => {
  const { root, releases, profile, seed, put } = await fixture(t);
  const options = await seed('0.1.0');
  const before = await readFile(join(profile, 'package.json'), 'utf8');
  await symlink(root, join(options.directory, 'node_modules/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await tar.c({ file: options.archive, cwd: options.directory, gzip: true }, ['release.json', 'node_modules']);
  await assert.rejects(prepareRelease(options), /链接/);
  await put('escape.txt', 'outside allowed payload');
  await tar.c({ file: options.archive, cwd: root, gzip: true }, ['escape.txt']);
  await assert.rejects(prepareRelease(options), /非插件文件/);
  assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), before);
  assert.deepEqual(await readdir(releases), []);
});

test('invalid and wrong-platform archives cannot activate', async t => {
  const { seed, put, releases } = await fixture(t);
  const options = await seed('0.1.0');
  await put('seed-0.1.0/release.json', { schemaVersion: 1, version: '0.1.0', platform: process.platform === 'win32' ? 'linux' : 'win32' });
  await tar.c({ file: options.archive, cwd: options.directory, gzip: true }, ['release.json', 'node_modules']);
  await assert.rejects(prepareRelease(options), /当前系统/);
  assert.deepEqual(await readdir(releases), []);
  await assert.rejects(prepareRelease({ ...options, version: '../0.1.0' }));
});

test('packaged activation resolves atomic writes from the explicit runtime ancestor without release links', async t => {
  const { root, profile, seed, put } = await fixture(t);
  const release = await prepareRelease(await seed('0.1.0'));
  const official = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-atomic-write/package.json');
  const target = join(root, 'installation/node_modules/@deepseek-ai/dsh-atomic-write');
  await mkdir(dirname(target), { recursive: true });
  await symlink(dirname(official), target, process.platform === 'win32' ? 'junction' : 'dir');
  await put('installation/dsh/runtime-marker', 'runtime');
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-atomic-write') throw Object.assign(new Error('no packaged bare dependency'), { code: 'ERR_MODULE_NOT_FOUND' });
    return nextResolve(specifier, context);
  } });
  try {
    const state = await activateRelease({ profile, release, runtime: join(root, 'installation/dsh'), enabled: true });
    assert.equal(state.enabled, true);
    assert.equal(Object.hasOwn(state, 'runtime'), false);
    await assert.rejects(lstat(join(release.directory, 'node_modules/@deepseek-ai/dsh-atomic-write')), { code: 'ENOENT' });
    await assert.rejects(activateRelease({ profile, release }), /官方原子写入服务/);
  } finally { hooks.deregister(); }
});
