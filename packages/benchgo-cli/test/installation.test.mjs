import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as tar from 'tar';
import { acquireWorkbenchLease, acquireWorkbenchProfileLock, assertWorkbenchDataAvailable, readWorkbenchLease, registerWorkbenchInstallation } from '../../../plugins/benchgo/shared/workbench-installation.mjs';
import { createStopCoordinator } from '../src/host.mjs';
import { acquirePayload, extractTar, safeArchiveName } from '../src/artifacts.mjs';
import { discoverOfficialRuntime, installWorkbench, shouldOpenBrowser, openBrowser } from '../src/installer.mjs';
import { releaseBundleName } from '../../../plugins/benchgo/shared/plugin-install.mjs';

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-cli-test-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('live and invalid ownership locks cannot be stolen; a dead owner is recovered', async t => {
  const home = await temporary(t);
  const release = await acquireWorkbenchLease({ home });
  await assert.rejects(() => acquireWorkbenchLease({ home }), /已有 BenchGo/);
  assert.equal((await readWorkbenchLease({ home })).active, true);
  await release();
  const file = join(home, '.benchgo/workbench/host.lock');
  await writeFile(file, JSON.stringify({ schemaVersion: 1, pid: 20, token: 'a'.repeat(64), kind: 'web' }));
  const recovered = await acquireWorkbenchLease({ home, isAlive: () => false });
  await recovered();
  await writeFile(file, '{}');
  await assert.rejects(() => acquireWorkbenchLease({ home }), /锁无效/);
  assert.equal(await readFile(file, 'utf8'), '{}');
});

test('CLI holds the official Desktop PID lock for its full ownership', async t => {
  const profile = join(await temporary(t), 'profile');
  const release = await acquireWorkbenchProfileLock({ profile });
  assert.equal((await readFile(join(profile, 'lock'), 'utf8')).trim(), String(process.pid));
  await assert.rejects(() => acquireWorkbenchProfileLock({ profile }), /正在使用/);
  await release();
  await writeFile(join(profile, 'lock'), '99999999');
  await (await acquireWorkbenchProfileLock({ profile, isAlive: () => false }))();
});

test('legacy product ownership is respected across homes and hosts', async t => {
  const userHome = await temporary(t); await mkdir(join(userHome, '.benchgo'));
  const file = join(userHome, '.benchgo/owner.lock');
  await writeFile(file, JSON.stringify({ pid: process.pid, host: hostname() }));
  await assert.rejects(() => assertWorkbenchDataAvailable({ userHome }), /正在使用/);
  await writeFile(file, JSON.stringify({ pid: 20, host: 'another-host' }));
  await assert.rejects(() => assertWorkbenchDataAvailable({ userHome, isAlive: () => false }), /正在使用/);
  await writeFile(file, JSON.stringify({ pid: 20, host: hostname() }));
  await assertWorkbenchDataAvailable({ userHome, isAlive: () => false });
});

test('concurrent stops share one drain; a failed inspection unlocks and permits retry', async () => {
  let locks = 0, unlocks = 0, shutdowns = 0, busy = true;
  const stop = createStopCoordinator({ lock: async () => { locks++; }, unlock: async () => { unlocks++; },
    inspect: async () => ({ activeTasks: busy, scheduledTasks: false }), shutdown: async () => { shutdowns++; } });
  const first = stop(), second = stop(); assert.equal(first, second);
  await assert.rejects(() => first, /等待交互/);
  assert.deepEqual([locks, unlocks, shutdowns], [1, 1, 0]);
  busy = false; await stop();
  assert.deepEqual([locks, unlocks, shutdowns], [2, 1, 1]);
});

test('a failed drain restores admission', async () => {
  let unlocked = false;
  const stop = createStopCoordinator({ lock: async () => { throw new Error('drain failed'); },
    unlock: async () => { unlocked = true; } });
  await assert.rejects(() => stop(), /drain failed/); assert.equal(unlocked, true);
});

test('outer release extraction shares strict portable path policy', () => {
  for (const value of ['../escape', '/root', 'C:/root', 'a\\b', 'a/./b', 'a//b', 'a/con.txt', 'a/trail.', 'a/ads:payload', 'a/\u0000', 'a'.repeat(2049)])
    assert.throws(() => safeArchiveName(value), /不安全路径/);
  safeArchiveName('benchgo-linux-x64/node_modules/pkg/file.mjs');
});

test('browser defaults respect headless sessions and preserve argument boundaries', async () => {
  const interactive = { stdout: { isTTY: true }, platform: 'linux', env: { DISPLAY: ':0' } };
  assert.equal(shouldOpenBrowser({}, interactive), true);
  assert.equal(shouldOpenBrowser({}, { ...interactive, env: { SSH_CONNECTION: 'x', DISPLAY: ':0' } }), false);
  assert.equal(shouldOpenBrowser({}, { ...interactive, env: {} }), false);
  assert.equal(shouldOpenBrowser({ json: true }, interactive), false);
  const url = 'http://127.0.0.1:1234/?token=a&value=one'; let call;
  await openBrowser(url, { platform: 'win32', runCommand: async (...args) => { call = args; } });
  assert.deepEqual(call.slice(0, 2), ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]);
});

async function installationFixture(t, { nested = false } = {}) {
  const home = await temporary(t), runtime = join(home, 'official'), profile = join(home, 'profiles/desktop');
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-official-bundles']) {
    const root = join(runtime, 'node_modules', ...(nested && name !== '@deepseek-ai/dsh' ? ['@deepseek-ai/dsh/node_modules'] : []), name); await mkdir(root, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name, version: '0.2.2-rc.1' }));
  }
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] }, plusInstall: { schemaVersion: 1, version: '0.1.3' } } }));
  const installation = await registerWorkbenchInstallation({ home, installation: { kind: 'web', runtime, profile, node: process.execPath, engineVersion: '0.2.2-rc.1' } });
  return { home, installation };
}

test('same-version update and repeated install reuse registration without fetching or rewriting disabled state', async t => {
  const { home, installation } = await installationFixture(t);
  const before = await readFile(join(home, 'profiles/desktop/package.json'), 'utf8');
  let checks = 0;
  const dependencies = { metadata: { schemaVersion: 1, pluginVersion: '0.1.2', releaseVersion: '0.1.2', engineVersion: '0.2.2-rc.1' },
    releaseLoader: async () => { checks++; return { version: '0.1.3', engine: { min: '0.2.2-rc.1', max: '0.2.2-rc.1' } }; },
    payloadLoader: async () => { throw new Error('must not download'); },
    startHost: async record => ({ installation: record, pid: 42, url: 'http://127.0.0.1:1234/?token=fixture' }) };
  const installed = await installWorkbench({ home }, dependencies);
  assert.equal(installed.installation.id, installation.id); assert.equal(checks, 0);
  const updated = await installWorkbench({ home, update: true }, dependencies);
  assert.equal(checks, 1); assert.equal(updated.updated, false); assert.equal(updated.installation.id, installation.id);
  assert.equal(await readFile(join(home, 'profiles/desktop/package.json'), 'utf8'), before);
});

test('existing official npm runtime is verified and reused; incompatible runtime never triggers another installation', async t => {
  const { home, installation } = await installationFixture(t);
  const discovered = await discoverOfficialRuntime({ engineVersion: installation.engineVersion }, { candidateRoots: [join(home, 'missing'), installation.runtime] });
  assert.equal(discovered.runtime, installation.runtime); assert.equal(discovered.reusedRuntime, true);
  await assert.rejects(() => discoverOfficialRuntime({ engineVersion: '0.3.0' }, { candidateRoots: [installation.runtime] }), /未重复安装引擎/);
});

test('npm global dsh with nested official dependencies is reused through its real Node resolver', async t => {
  const { installation } = await installationFixture(t, { nested: true });
  const found = await discoverOfficialRuntime({ engineVersion: installation.engineVersion }, { candidateRoots: [installation.runtime] });
  assert.equal(found.runtime, installation.runtime); assert.equal(found.reusedRuntime, true);
});

test('incompatible signed update stops before resource acquisition', async t => {
  const { home } = await installationFixture(t);
  await assert.rejects(() => installWorkbench({ home, update: true }, {
    metadata: { engineVersion: '0.2.2-rc.1' }, releaseLoader: async () => ({ version: '0.1.4', engine: { min: '0.3.0' } }),
    payloadLoader: async () => { throw new Error('must not download'); },
  }), /新版引擎/);
});

test('duplicate archive entries fail before creating the destination', async t => {
  const root = await temporary(t), archive = join(root, 'duplicate.tar.gz');
  await writeFile(join(root, 'one'), 'one');
  await tar.c({ cwd: root, file: archive, gzip: true }, ['one', 'one']);
  const output = join(root, 'output');
  await assert.rejects(() => extractTar(archive, output), /重复路径/);
  await assert.rejects(() => readFile(join(output, 'one')), { code: 'ENOENT' });
});

test('payload cache is repaired against archive bytes even if a forged receipt accompanies modified files', async t => {
  const root = await temporary(t), seed = join(root, 'seed'), outer = join(root, 'outer');
  await mkdir(join(seed, 'node_modules/benchgo-plugin'), { recursive: true }); await mkdir(outer);
  await writeFile(join(seed, 'release.json'), JSON.stringify({ schemaVersion: 1, version: '0.1.3', platform: 'linux', arch: 'x64' }));
  await writeFile(join(seed, 'node_modules/benchgo-plugin/package.json'), JSON.stringify({ name: 'benchgo-plugin', version: '0.1.3' }));
  const payloadFile = join(outer, 'server-seed.tar.gz');
  await tar.c({ cwd: seed, file: payloadFile, gzip: true }, ['release.json', 'node_modules']);
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(outer, 'manifest.json'), JSON.stringify({ pluginVersion: '0.1.3', harnessVersion: '0.2.2-rc.1', sha256: sha(await readFile(payloadFile)) }));
  const archive = join(root, 'linux.tar.gz');
  await tar.c({ cwd: outer, file: archive, gzip: true }, ['manifest.json', 'server-seed.tar.gz']);
  const bytes = await readFile(archive), digest = sha(bytes);
  const cache = join(root, 'home/.benchgo/workbench/cache'); let fetched = 0;
  const options = { cache, platform: 'linux', arch: 'x64', source: 'github',
    metadata: { releaseVersion: '0.1.3', pluginVersion: '0.1.3', engineVersion: '0.2.2-rc.1' },
    catalogLoader: async () => ({ catalog: { files: [{ target: 'linux-server', version: '0.1.3', sha256: digest, size: bytes.length,
      url: 'https://github.com/zhuogo/BenchGo/releases/download/v0.1.3/benchgo-0.1.3-linux-server.tar.gz' }] } }),
    fetcher: async () => { fetched++; return new Response(bytes, { headers: { 'content-length': String(bytes.length) } }); } };
  const first = await acquirePayload(options); assert.equal(fetched, 1);
  await writeFile(join(first.seed, 'node_modules/benchgo-plugin/package.json'), '{"name":"tampered"}');
  await writeFile(join(cache, `payload-${digest}`, '.benchgo-payload.json'), JSON.stringify({ sha256: digest, files: [] }));
  const repaired = await acquirePayload(options); assert.equal(fetched, 1);
  assert.equal(JSON.parse(await readFile(join(repaired.seed, 'node_modules/benchgo-plugin/package.json'), 'utf8')).name, 'benchgo-plugin');
  assert.equal((await acquirePayload(options)).origin, 'cache');
  await writeFile(join(cache, `${digest}-benchgo-0.1.3-linux-server.tar.gz`), 'corrupt');
  await acquirePayload(options); assert.equal(fetched, 2);
});

async function freshInstallFixture(t, { validSeed = false } = {}) {
  const { home, installation } = await installationFixture(t);
  await rm(join(home, 'profiles'), { recursive: true }); await rm(join(home, '.benchgo/workbench/installation.json'));
  const original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => { for (const [name, value] of Object.entries(original)) value === undefined ? delete process.env[name] : process.env[name] = value; });
  const seed = join(home, 'seed'); await mkdir(seed);
  const version = '0.1.4', bundleName = releaseBundleName(version);
  const put = async (file, value) => { const target = join(seed, file); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value)); };
  if (validSeed) {
    await put('release.json', { schemaVersion: 1, version, platform: process.platform, arch: process.arch });
    await put('node_modules/benchgo-plugin/package.json', { name: 'benchgo-plugin', version, type: 'module', exports: { '.': './src/plugin.mjs' } });
    for (const path of ['src/plugin.mjs', 'lib/client.js', 'lib/link.mjs', 'lib/link-web/index.html', 'cordis.patch.yml']) await put(`node_modules/benchgo-plugin/${path}`, 'fixture');
    await put(`node_modules/${bundleName}/package.json`, { name: bundleName, version, dependencies: { 'benchgo-plugin': version } });
    // This fake runtime is intentionally independent of repository dependencies.
    // Activation still uses its real validation/commit path; only the official
    // atomic service boundary is a test double with an exclusive lock and rename.
    const atomic = join(installation.runtime, 'node_modules/@deepseek-ai/dsh-atomic-write');
    await mkdir(join(atomic, 'lib'), { recursive: true });
    await writeFile(join(atomic, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-atomic-write', version: installation.engineVersion, type: 'module', exports: { '.': './lib/index.js', './package.json': './package.json' } }));
    await writeFile(join(atomic, 'lib/index.js'), `
import { open, rename, rm, writeFile } from 'node:fs/promises';
export const calls = { locks: 0, writes: 0 };
export async function withFileLock(path, callback) {
  const name = path + '.fixture-lock', lock = await open(name, 'wx'); calls.locks++;
  try { return await callback(); } finally { await lock.close(); await rm(name); }
}
export async function writeFileAtomic(path, bytes, options) {
  const name = path + '.fixture-write'; calls.writes++;
  try { await writeFile(name, bytes, { ...options, flag: 'wx' }); await rename(name, path); }
  finally { await rm(name, { force: true }); }
}
`);
  }
  const dependencies = { metadata: { schemaVersion: 1, pluginVersion: version, releaseVersion: version, engineVersion: installation.engineVersion },
    payloadLoader: async () => ({ seed }), runtimeInstaller: async () => ({ runtime: installation.runtime, engineVersion: installation.engineVersion }),
    initializeProfile: async (_runtime, paths) => {
      await writeFile(join(paths.profile, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
      await writeFile(join(paths.profile, 'cordis.patch.yml'), '# initialized\n');
    } };
  return { home, dependencies };
}

test('failed fresh preparation removes only its own unchanged initialization and permits clean retry', async t => {
  const { home, dependencies } = await freshInstallFixture(t);
  await assert.rejects(() => installWorkbench({ home, offline: true }, dependencies), /ENOENT/);
  await assert.rejects(() => readFile(join(home, 'profiles/desktop/package.json')), { code: 'ENOENT' });
  await assert.rejects(() => readFile(join(home, '.benchgo/workbench/installation.json')), { code: 'ENOENT' });
});

test('a committed first install retains a retryable registration if startup fails; mutation lock is released before boot', async t => {
  const { home, dependencies } = await freshInstallFixture(t, { validSeed: true });
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-atomic-write') throw Object.assign(new Error('fixture must use its explicit runtime service'), { code: 'ERR_MODULE_NOT_FOUND' });
    return nextResolve(specifier, context);
  } });
  t.after(() => hooks.deregister());
  dependencies.startHost = async () => {
    await assert.rejects(() => readFile(join(home, 'profiles/desktop/lock')), { code: 'ENOENT' });
    throw new Error('fixture startup failure');
  };
  await assert.rejects(() => installWorkbench({ home, offline: true }, dependencies), /已安装，启动尚未成功/);
  const registered = JSON.parse(await readFile(join(home, '.benchgo/workbench/installation.json'), 'utf8'));
  assert.equal(registered.pluginVersion, '0.1.4');
  const atomic = await import(pathToFileURL(join(home, 'official/node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js')).href);
  assert.deepEqual(atomic.calls, { locks: 1, writes: 1 });
  dependencies.startHost = async installation => ({ installation, pid: 100 });
  const retried = await installWorkbench({ home, offline: true }, dependencies);
  assert.equal(retried.reused, true); assert.equal(retried.installation.id, registered.id);
});

test('unified benchgo command has one package owner', async () => {
  const cli = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const plugin = JSON.parse(await readFile(new URL('../../../plugins/benchgo/package.json', import.meta.url), 'utf8'));
  assert.deepEqual(cli.bin, { benchgo: './bin/benchgo.mjs' });
  assert.deepEqual(plugin.bin, { commander: 'src/cli.mjs' });
});
