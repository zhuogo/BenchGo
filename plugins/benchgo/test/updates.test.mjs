import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createUpdates, mountUpdates, desktopApplicationVersion } from '../src/updates.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-update-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const artifact = Buffer.from('verified plugin bytes');
  const manifest = { schemaVersion: 1, version: options.version || '0.1.3', engine: options.engine || { min: '1.2.3', max: '1.2.3' }, plugin: { version: options.version || '0.1.3', url: 'https://github.com/zhuogo/BenchGo/releases/download/plugin-v0.1.3/benchgo-0.1.3-plugin.tar.gz', size: artifact.length, sha256: createHash('sha256').update(artifact).digest('hex') } };
  if (options.appVersionInFeed) manifest.app = { version: options.appVersionInFeed, url: `https://github.com/zhuogo/BenchGo/releases/download/v${options.appVersionInFeed}/benchgo-setup.exe` };
  if (options.minAppVersion !== undefined) manifest.minAppVersion = options.minAppVersion;
  if (options.releaseVersion !== undefined) manifest.releaseVersion = options.releaseVersion;
  const bytes = Buffer.from(JSON.stringify(manifest)), signature = sign(null, bytes, privateKey).toString('base64');
  const state = { managed: true, root: join(directory, 'releases'), version: '0.1.2', appVersion: '0.1.2', ...options.state };
  let activated = 0, busy = false, downloads = 0, httpStatus = options.httpStatus;
  const install = {
    getInstallState: async () => ({ ...state }),
    prepareRelease: async ({ archive, version }) => { assert.deepEqual(await readFile(archive), artifact); return { version }; },
    activateRelease: async ({ release }) => { activated++; state.version = release.version; },
  };
  const fetcher = async url => {
    if (httpStatus) return new Response(null, { status: httpStatus });
    if (url.endsWith('.sig')) return new Response(signature);
    if (url.endsWith('.json')) return new Response(bytes);
    downloads++;
    if (options.beforeDownload) await options.beforeDownload(() => { busy = true; });
    return new Response(options.corrupt ? 'wrong bytes' : artifact);
  };
  const service = await createUpdates({ directory, profile: directory, runtime: directory, version: options.currentVersion || '0.1.2', releaseVersion: options.currentReleaseVersion, engineVersion: Object.hasOwn(options, 'engineVersion') ? options.engineVersion : '1.2.3', appVersion: options.appVersion, publicKey: publicKey.export({ type: 'spki', format: 'pem' }), fetcher, install, installation: options.installation || 'desktop', isBusy: () => busy });
  t.after(() => service.close());
  return { service, directory, state, setBusy: value => { busy = value; }, setHttpStatus: value => { httpStatus = value; }, activated: () => activated, downloads: () => downloads };
}

test('signed check, verified install, persistence and restart state form one complete update path', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.status()).config.source, 'mirror');
  await f.service.dispatch({ action: 'configure', source: 'custom', mirrorUrl: 'https://mirror.example.com/' });
  assert.equal(JSON.parse(await readFile(join(f.directory, 'updates.json'))).source, 'custom');
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  assert.equal((await f.service.status()).canInstall, true);
  await f.service.dispatch({ action: 'install' }); await f.service.settled();
  const status = await f.service.status();
  assert.equal(f.activated(), 1); assert.equal(status.restartRequired, true); assert.equal(status.current.plugin, '0.1.2'); assert.equal(status.current.app, '0.1.2');
  assert.equal(status.release.plugin.available, false, 'a staged update is waiting for restart, not another installation');
  await assert.rejects(f.service.dispatch({ action: 'install' }), /重启/);
});

test('actual app metadata takes priority over a marker containing the plugin version', async t => {
  const f = await fixture(t, { appVersion: '0.1.3', state: { appVersion: '0.1.4' } });
  assert.equal((await f.service.status()).current.app, '0.1.3');
  assert.equal((await f.service.status()).current.plugin, '0.1.2');
});

test('a current server plugin and unknown desktop version do not become an application update', async t => {
  const f = await fixture(t, { version: '0.1.8', currentVersion: '0.1.8', appVersionInFeed: '0.1.6', installation: 'server', state: { version: '0.1.8', appVersion: null, managed: false } });
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  const status = await f.service.status();
  assert.equal(status.current.app, undefined);
  assert.equal(status.release.plugin.available, false);
  assert.equal(status.release.app.available, false);
  assert.equal(status.restartRequired, false);
  assert.equal(status.canInstall, false);
});

test('application updates require a known installed desktop version and a strictly newer release', async t => {
  for (const [appVersion, expected] of [[undefined, false], [null, false], ['0.1.6', false], ['0.1.7', false], ['0.1.5', true]]) {
    const f = await fixture(t, { version: '0.1.2', appVersionInFeed: '0.1.6', state: { appVersion } });
    await f.service.dispatch({ action: 'check' }); await f.service.settled();
    const status = await f.service.status();
    assert.equal(status.release.app.available, expected, `current application: ${appVersion}`);
    assert.equal(status.release.plugin.available, false);
  }
});

test('server deployment ignores desktop markers while retaining real plugin updates', async t => {
  const f = await fixture(t, { appVersion: '0.1.1', appVersionInFeed: '0.1.6', installation: 'server', state: { appVersion: '0.1.1' } });
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  const status = await f.service.status();
  assert.equal(status.current.app, undefined);
  assert.equal(status.release.app.available, false);
  assert.equal(status.release.plugin.available, true);
  assert.equal(status.canInstall, true);
});

test('loading the prepared plugin after a restart clears the staged update', async t => {
  const f = await fixture(t, { currentVersion: '0.1.3', state: { version: '0.1.3' } });
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  const status = await f.service.status();
  assert.equal(status.restartRequired, false);
  assert.equal(status.phase, 'idle');
  assert.equal(status.release.plugin.available, false);
  assert.equal(status.canInstall, false);
});

test('desktop application version uses only the installed BenchGo application metadata', async () => {
  let requested;
  assert.equal(await desktopApplicationVersion('/installed/BenchGo.exe', async file => { requested = file; return { name: 'benchgo-desktop', version: '0.1.3' }; }), '0.1.3');
  assert.equal(requested, join('/installed', 'resources', 'app.asar', 'package.json'));
  assert.equal(await desktopApplicationVersion('/installed/node', async () => ({ name: 'node', version: '22.0.0' })), undefined);
  assert.equal(await desktopApplicationVersion('/installed/BenchGo.exe', async () => ({ name: 'benchgo-desktop', version: 'invalid' })), undefined);
  assert.equal(await desktopApplicationVersion('/installed/BenchGo.exe', async () => { throw Error('missing'); }), undefined);
});

test('unmanaged installations and running tasks cannot mutate plugin versions', async t => {
  const f = await fixture(t, { state: { managed: false } });
  await assert.rejects(f.service.dispatch({ action: 'install' }), /先升级一次应用/);
  f.state.managed = true; f.setBusy(true);
  await assert.rejects(f.service.dispatch({ action: 'install' }), /任务/);
  assert.equal(f.downloads(), 0);
});

test('new tasks during download prevent activation and corrupted bytes never prepare', async t => {
  for (const options of [{ beforeDownload: busy => busy() }, { corrupt: true }]) {
    const f = await fixture(t, options);
    await f.service.dispatch({ action: 'check' }); await f.service.settled();
    await f.service.dispatch({ action: 'install' }); await f.service.settled();
    assert.equal(f.activated(), 0); assert.equal((await f.service.status()).phase, 'error');
  }
});

test('incompatible engine and stale release are never offered as installable', async t => {
  for (const options of [{ engine: { min: '2.0.0' } }, { version: '0.1.1' }]) {
    const f = await fixture(t, options);
    await f.service.dispatch({ action: 'check' }); await f.service.settled();
    assert.equal((await f.service.status()).canInstall, false);
    await assert.rejects(f.service.dispatch({ action: 'install' }));
    assert.equal(f.downloads(), 0);
  }
});

test('removed former-version action is rejected and status exposes no downgrade capability', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.dispatch({ action: 'rollback' }), /未知更新操作/);
  const status = await f.service.status();
  assert.equal(f.state.version, '0.1.2'); assert.equal(status.restartRequired, false);
  assert.equal(Object.hasOwn(status, 'canRollback'), false);
  assert.equal(status.lastAction, null); assert.equal(f.downloads(), 0); assert.equal(f.activated(), 0);
});

test('concurrent install requests admit only one download', async t => {
  const f = await fixture(t);
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  const results = await Promise.allSettled([f.service.dispatch({ action: 'install' }), f.service.dispatch({ action: 'install' })]);
  assert.equal(results.filter(row => row.status === 'rejected').length, 1);
  await f.service.settled(); assert.equal(f.downloads(), 1);
});

test('management route rejects cross-origin requests before parsing', async t => {
  let handler;
  const directory = await mkdtemp(join(tmpdir(), 'dsh-update-route-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const cleanups = [];
  const ctx = { get: () => undefined, effect: fn => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); }, connection: { fetch: { register: route => { handler = route.fetch; return () => {}; } } } };
  const service = await mountUpdates(ctx, { store: { directory }, list: () => [] }); t.after(() => service.close());
  const response = await handler(new Request('https://host/api/commander/updates', { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{"action":"install"}' }));
  assert.equal(response.status, 403);
});


test('source-deployed hosts report server management and unpublished channels without application migration instructions', async t => {
  const f = await fixture(t, { state: { managed: false }, installation: 'server', httpStatus: 404 });
  assert.equal((await f.service.status()).installation, 'server');
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  const status = await f.service.status();
  assert.equal(status.phase, 'unpublished'); assert.equal(status.error, '');
  assert.match(status.notice, /尚未就绪/); assert.equal(status.canInstall, false);
  await assert.rejects(f.service.dispatch({ action: 'install' }), /服务器部署管理/);
});

test('HTTP permission errors remain check failures instead of claiming no published version', async t => {
  const f = await fixture(t, { httpStatus: 403 });
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  const status = await f.service.status();
  assert.equal(status.phase, 'error'); assert.match(status.error, /403/); assert.equal(status.notice, '');
});

test('a check never reports a ready release as idle while mutation admission remains occupied', async t => {
  const f = await fixture(t);
  await f.service.dispatch({ action: 'check' });
  for (let index = 0; index < 64; index++) {
    const status = await f.service.status();
    if (status.phase === 'idle' && status.release?.plugin.available) assert.equal(status.canInstall, true);
  }
  await f.service.settled();
  assert.equal((await f.service.status()).lastAction, 'check');
  await f.service.dispatch({ action: 'install' });
  await f.service.settled();
  assert.equal((await f.service.status()).lastAction, 'install');
});

test('unified release identity is explicit and never inferred from an internal plugin version', async t => {
  const legacy = await fixture(t);
  assert.equal((await legacy.service.status()).current.release, undefined);
  const f = await fixture(t, { currentReleaseVersion: '0.4.0', releaseVersion: '0.5.0' });
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  const status = await f.service.status();
  assert.equal(status.current.release, '0.4.0'); assert.equal(status.release.releaseVersion, '0.5.0');
  assert.equal(status.current.plugin, '0.1.2'); assert.equal(status.decision.action, 'plugin');
});

test('a signed release can confirm reused host components without rebuilding their archive', async t => {
  for (const options of [
    { appVersionInFeed: '0.2.0', appVersion: '0.2.0' },
    { appVersionInFeed: '0.1.0' },
    { installation: 'server', appVersionInFeed: '0.2.0', state: { version: '0.1.2', appVersion: null, managed: false } },
  ]) {
    const f = await fixture(t, { version: '0.1.2', currentReleaseVersion: '0.4.0', releaseVersion: '0.5.0', ...options });
    assert.equal((await f.service.status()).current.release, '0.4.0');
    await f.service.dispatch({ action: 'check' }); await f.service.settled();
    const status = await f.service.status();
    assert.equal(status.current.release, '0.5.0'); assert.equal(status.decision.action, 'current');
    assert.equal(status.current.plugin, '0.1.2'); assert.equal(f.downloads(), 0);
  }
});

test('public release confirmation requires known compatible active host components and never lowers its identity', async t => {
  const cases = [
    { appVersionInFeed: '0.2.0' },
    { appVersionInFeed: '0.2.0', state: { appVersion: null }, expected: 'blocked' },
    { engineVersion: '2.0.0', expected: 'blocked' },
    { minAppVersion: '0.2.0', expected: 'blocked' },
    { state: { version: '0.1.3' }, expected: 'restart' },
    { currentReleaseVersion: '0.6.0', expected: 'current' },
    { httpStatus: 503, expected: 'check' },
  ];
  for (const options of cases) {
    const f = await fixture(t, { version: '0.1.2', currentReleaseVersion: '0.4.0', releaseVersion: '0.5.0', ...options });
    await f.service.dispatch({ action: 'check' }); await f.service.settled();
    const status = await f.service.status();
    assert.equal(status.current.release, options.currentReleaseVersion || '0.4.0');
    assert.equal(status.decision.action, options.expected || 'app');
    if (options.expected === 'blocked') assert.equal(status.decision.available, false);
  }
});

test('failed later checks retain a confirmed public identity but keep retry as the primary decision', async t => {
  const f = await fixture(t, { version: '0.1.2', releaseVersion: '0.5.0' });
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  assert.equal((await f.service.status()).current.release, '0.5.0');
  f.setHttpStatus(503); await f.service.dispatch({ action: 'check' }); await f.service.settled();
  const status = await f.service.status();
  assert.equal(status.current.release, '0.5.0'); assert.equal(status.decision.action, 'check');
});

test('desktop minimum application version blocks install including unknown app versions', async t => {
  for (const appVersion of [null, '0.1.2']) {
    const f = await fixture(t, { minAppVersion: '0.2.0', state: { appVersion } });
    await f.service.dispatch({ action: 'check' }); await f.service.settled();
    const status = await f.service.status();
    assert.equal(status.canInstall, false); assert.equal(status.release.plugin.appCompatible, false);
    assert.equal(status.decision.action, 'blocked'); assert.equal(status.decision.enabled, false);
    await assert.rejects(f.service.dispatch({ action: 'install' }), appVersion ? /需要应用/ : /无法识别当前应用/);
    assert.equal(f.downloads(), 0);
  }
});

test('server ignores desktop minimum and legacy manifests remain independently installable', async t => {
  for (const options of [{ installation: 'server', minAppVersion: '9.0.0', state: { appVersion: null } }, { state: { appVersion: null } }]) {
    const f = await fixture(t, options);
    await f.service.dispatch({ action: 'check' }); await f.service.settled();
    const status = await f.service.status();
    assert.equal(status.canInstall, true); assert.equal(status.release.plugin.appCompatible, true);
    await f.service.dispatch({ action: 'install' }); await f.service.settled();
    assert.equal(f.activated(), 1);
  }
});

test('decision distinguishes engine direction and unknown version without bypassing install checks', async t => {
  for (const [engineVersion, action, reason] of [['1.0.0', 'app', /引擎版本过旧/], ['2.0.0', 'blocked', /较新的引擎/], [undefined, 'blocked', /无法识别当前引擎/]]) {
    const f = await fixture(t, { engineVersion, appVersionInFeed: '0.2.0' });
    await f.service.dispatch({ action: 'check' }); await f.service.settled();
    const status = await f.service.status();
    assert.equal(status.decision.action, action); assert.match(status.decision.reason, reason);
    assert.equal(status.release.plugin.engineCompatible, false); assert.equal(status.canInstall, false);
    await assert.rejects(f.service.dispatch({ action: 'install' }), reason);
  }
  const samePlugin = await fixture(t, { version: '0.1.2', engineVersion: '2.0.0', appVersionInFeed: '0.2.0' });
  await samePlugin.service.dispatch({ action: 'check' }); await samePlugin.service.settled();
  const status = await samePlugin.service.status();
  assert.equal(status.release.plugin.available, false); assert.equal(status.decision.action, 'blocked');
  assert.match(status.decision.reason, /较新的引擎/);
});

test('one decision prioritizes compatible plugin, mandatory app and remaining application update', async t => {
  const f = await fixture(t, { appVersionInFeed: '0.3.0', minAppVersion: '0.1.2' });
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  assert.equal((await f.service.status()).decision.action, 'plugin');
  f.setBusy(true);
  let status = await f.service.status();
  assert.equal(status.decision.enabled, false); assert.equal(status.canInstall, false);
  await assert.rejects(f.service.dispatch({ action: 'install' }), /任务/);
  f.setBusy(false); await f.service.dispatch({ action: 'install' }); await f.service.settled();
  status = await f.service.status();
  assert.equal(status.decision.action, 'restart'); assert.equal(status.release.app.available, true);
  const restarted = await fixture(t, { currentVersion: '0.1.3', state: { version: '0.1.3' }, appVersionInFeed: '0.3.0' });
  await restarted.service.dispatch({ action: 'check' }); await restarted.service.settled();
  assert.equal((await restarted.service.status()).decision.action, 'app');
  const mandatory = await fixture(t, { appVersionInFeed: '0.3.0', minAppVersion: '0.2.0' });
  await mandatory.service.dispatch({ action: 'check' }); await mandatory.service.settled();
  assert.equal((await mandatory.service.status()).decision.action, 'app');
});

test('unmanaged server directs deployment and insufficient app releases cannot unblock a minimum', async t => {
  const server = await fixture(t, { installation: 'server', state: { managed: false } });
  await server.service.dispatch({ action: 'check' }); await server.service.settled();
  assert.equal((await server.service.status()).decision.action, 'deployment');
  const desktop = await fixture(t, { minAppVersion: '0.3.0', appVersionInFeed: '0.2.0' });
  await desktop.service.dispatch({ action: 'check' }); await desktop.service.settled();
  assert.equal((await desktop.service.status()).decision.action, 'blocked');
});

test('a failed recheck retains verified metadata without claiming current or replacing retry with install', async t => {
  for (const candidate of ['0.1.2', '0.1.3']) {
    const f = await fixture(t, { version: candidate });
    await f.service.dispatch({ action: 'check' }); await f.service.settled();
    f.setHttpStatus(503); await f.service.dispatch({ action: 'check' }); await f.service.settled();
    const status = await f.service.status();
    assert.equal(status.phase, 'error'); assert.equal(status.release.plugin.version, candidate);
    assert.equal(status.decision.action, 'check'); assert.equal(status.decision.enabled, true);
    assert.equal(status.decision.available, candidate === '0.1.3'); assert.match(status.decision.reason, /503/);
    assert.equal(status.canInstall, false);
    await assert.rejects(f.service.dispatch({ action: 'install' }), /重新检查/);
  }
});
