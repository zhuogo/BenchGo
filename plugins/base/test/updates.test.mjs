import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile, symlink, lstat, readdir } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import * as tar from 'tar';
import { createUpdates, mountUpdates, desktopApplicationVersion } from '../src/updates.mjs';
import { createRestartAdmission, managedServerRestart } from '../src/server-restart.mjs';
import { prepareRelease, activateRelease, getInstallState, releaseBundleName } from '../shared/plugin-install.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-update-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const artifact = Buffer.from('verified plugin bytes');
  const manifest = { schemaVersion: 1, version: options.version || '0.1.3', engine: options.engine || { min: '1.2.3', max: '1.2.3' }, plugin: { version: options.version || '0.1.3', url: 'https://github.com/zhuogo/BenchGo/releases/download/plugin-v0.1.3/benchgo-0.1.3-plugin.tar.gz', size: artifact.length, sha256: createHash('sha256').update(artifact).digest('hex') } };
  if (options.appVersionInFeed) manifest.app = { version: options.appVersionInFeed, url: `https://github.com/zhuogo/BenchGo/releases/download/v${options.appVersionInFeed}/benchgo-setup.exe` };
  if (options.minAppVersion !== undefined) manifest.minAppVersion = options.minAppVersion;
  if (options.releaseVersion !== undefined) manifest.releaseVersion = options.releaseVersion;
  let server;
  if (options.serverCatalog) {
    manifest.releaseVersion = '0.1.9';
    manifest.sourceSha = 'a'.repeat(40);
    manifest.plugin.url = `https://github.com/zhuogo/BenchGo/releases/download/v${manifest.releaseVersion}/benchgo-${manifest.version}-plugin.tar.gz`;
    const archiveRoot = 'benchgo-0.1.9-linux-server';
    const source = join(directory, archiveRoot);
    const commit = 'b'.repeat(40);
    await mkdir(source);
    await Promise.all([
      writeFile(join(source, 'bootstrap.sh'), 'fixture'),
      writeFile(join(source, 'bootstrap.mjs'), 'fixture'),
      writeFile(join(source, 'server-seed.tar.gz'), artifact),
      writeFile(join(source, 'manifest.json'), JSON.stringify({ schemaVersion: 1, pluginVersion: manifest.version,
        harnessVersion: manifest.engine.min, harnessCommit: commit, sha256: manifest.plugin.sha256 })),
      writeFile(join(source, 'release-source.json'), JSON.stringify({ schemaVersion: 1, sourceSha: manifest.sourceSha,
        version: manifest.releaseVersion, pluginVersion: manifest.version, platform: 'linux', arch: 'x64', kind: 'server',
        engine: { version: manifest.engine.min, commit } })),
    ]);
    const archive = join(directory, 'server.tar.gz');
    await tar.c({ cwd: directory, file: archive, gzip: true }, [archiveRoot]);
    const payload = await readFile(archive);
    const target = { target: 'linux-server', kind: 'server', arch: 'x64', version: manifest.releaseVersion,
      url: `https://github.com/zhuogo/BenchGo/releases/download/v${manifest.releaseVersion}/${archiveRoot}.tar.gz`,
      size: payload.length, sha256: createHash('sha256').update(payload).digest('hex') };
    const catalog = { schemaVersion: 1, releaseVersion: manifest.releaseVersion, sourceSha: manifest.sourceSha,
      files: [{ ...manifest.plugin, target: 'plugin' }, target] };
    options.serverCatalog(catalog);
    const bytes = Buffer.from(JSON.stringify(catalog));
    server = { payload, target, bytes, signature: sign(null, bytes, privateKey).toString('base64') };
  }
  const bytes = Buffer.from(JSON.stringify(manifest)), signature = sign(null, bytes, privateKey).toString('base64');
  const state = { managed: true, root: join(directory, 'releases'), version: '0.1.2', appVersion: '0.1.2', ...options.state };
  let activated = 0, busy = false, downloads = 0, prepared = 0, preparedVersion, httpStatus = options.httpStatus;
  const install = {
    getInstallState: async () => ({ ...state }),
    prepareRelease: async input => {
      if (input.archive) assert.deepEqual(await readFile(input.archive), artifact);
      else assert.equal(input.version, preparedVersion, 'only a previously prepared immutable release can be reused');
      prepared++;
      await options.beforePrepare?.(input);
      preparedVersion = input.version;
      return { version: input.version };
    },
    activateRelease: async ({ release }) => { await options.beforeActivate?.(); activated++; state.version = release.version; },
  };
  const fetcher = async url => {
    if (httpStatus) return new Response(null, { status: httpStatus });
    if (url.endsWith('/downloads.json.sig')) return server ? new Response(server.signature) : new Response(null, { status: 404 });
    if (url.endsWith('/downloads.json')) return server ? new Response(server.bytes) : new Response(null, { status: 404 });
    if (url.endsWith('.sig')) return new Response(signature);
    if (url.endsWith('.json')) return new Response(bytes);
    downloads++;
    if (options.beforeDownload) await options.beforeDownload(() => { busy = true; });
    if (options.platform === 'linux') {
      assert.ok(server && url.endsWith(server.target.url), 'Linux must request the Linux distribution');
      return new Response(server.payload);
    }
    return options.downloadResponse ? options.downloadResponse(artifact) : new Response(options.corrupt ? 'wrong bytes' : artifact);
  };
  const startService = next => createUpdates({ directory, profile: directory, runtime: directory, version: options.currentVersion || '0.1.2', releaseVersion: options.currentReleaseVersion, engineVersion: Object.hasOwn(options, 'engineVersion') ? options.engineVersion : '1.2.3', appVersion: options.appVersion, publicKey: publicKey.export({ type: 'spki', format: 'pem' }), fetcher, install, installation: options.installation || 'desktop', platform: options.platform ?? 'win32', arch: options.arch ?? 'x64', isBusy: () => busy, ...options.host, ...next });
  const service = await startService();
  t.after(() => service.close());
  return { service, directory, state, startService, setBusy: value => { busy = value; }, setHttpStatus: value => { httpStatus = value; }, activated: () => activated, downloads: () => downloads, prepared: () => prepared };
}

test('managed Linux waits for idle without a client and confirms the target and prior assistant after restart', { timeout: 10_000 }, async t => {
  let restarts = 0, assistant = true;
  const f = await fixture(t, { installation: 'server', platform: 'linux', serverCatalog() {},
    host: { restartServer: async () => { restarts++; }, idlePollMs: 10, serverReadiness: () => ({ workbench: true, assistant }) },
  });
  await f.service.dispatch({ action: 'check' });
  await f.service.settled();
  f.setBusy(true);
  assert.equal((await f.service.status()).canInstall, true);
  await f.service.dispatch({ action: 'install' });
  while ((await f.service.status()).phase !== 'waiting') await delay(10);
  assert.equal(f.activated(), 0);
  assert.equal(restarts, 0);
  f.setBusy(false);
  while (!restarts) await delay(10);
  await f.service.settled();
  const staged = await f.service.status();
  assert.equal(staged.hostHealth.restart, 'restarting');
  assert.equal(staged.hostHealth.target, '0.1.3');
  await assert.rejects(f.service.dispatch({ action: 'restart' }), /正在重启/);
  await f.service.close();
  assistant = false;
  const next = await f.startService({ version: '0.1.3' });
  t.after(() => next.close());
  const warming = await next.status();
  assert.notEqual(warming.hostHealth.instanceId, staged.hostHealth.instanceId);
  assert.equal(warming.restartRequired, false);
  assert.equal(warming.hostHealth.ready, false);
  assistant = true;
  assert.equal((await next.status()).hostHealth.ready, true);
  assert.equal(restarts, 1);
});

test('managed Linux retries a rejected service restart without downloading or activating again', async t => {
  let attempts = 0;
  const f = await fixture(t, { installation: 'server', platform: 'linux', serverCatalog() {},
    host: { restartServer: async () => { if (++attempts === 1) throw new Error('systemd rejected restart'); } },
  });
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  await f.service.dispatch({ action: 'install' }); await f.service.settled();
  const failed = await f.service.status();
  assert.equal(failed.hostHealth.restart, 'failed');
  assert.equal(failed.decision.enabled, true);
  await f.service.dispatch({ action: 'restart' }); await f.service.settled();
  assert.equal((await f.service.status()).hostHealth.restart, 'restarting');
  assert.equal(f.downloads(), 1);
  assert.equal(f.activated(), 1);
});

test('restart admission drains accepted requests and refuses work until unlocked', async () => {
  const admission = createRestartAdmission();
  const pending = Promise.withResolvers();
  const request = admission.run(() => pending.promise);
  let drained = false;
  const lock = admission.lock(new AbortController().signal).then(() => { drained = true; });
  await assert.rejects(admission.run(() => assert.fail('work admitted while locked')), { status: 503 });
  await delay(5);
  assert.equal(drained, false);
  pending.resolve();
  await Promise.all([lock, request]);
  assert.equal(drained, true);
  admission.unlock();
  assert.equal(await admission.run(() => 'accepted'), 'accepted');
});

test('Linux restart matches the owning user unit and installation profile', async () => {
  for (const group of ['/user.slice/user-0.slice/user@0.service/app.slice/benchgo.service', '/user.slice/user-0.slice/user@0.service/benchgo.service']) {
    let called;
    const restart = await managedServerRestart('/profile', 'linux', {
      home: '/home', env: {}, uid: () => 0,
      read: async path => path === '/proc/self/cgroup' ? '0::' + group : JSON.stringify({ schemaVersion: 1, profile: '/profile', dataDir: '/data' }),
      execute: async (...args) => { called = args; },
    });
    assert.ok(restart);
    assert.equal(restart.receiptPath, join('/data', 'update-restart.json'));
    await restart.request();
    assert.deepEqual(called.slice(0, 2), ['systemctl', ['--user', '--no-block', 'restart', 'benchgo.service']]);
    assert.equal(called[2].env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/0/bus');
  }
  for (const [profile, group] of [['/other', '/user@0.service/app.slice/benchgo.service'], ['/profile', '/system.slice/other.service']]) {
    assert.equal(await managedServerRestart(profile, 'linux', {
      read: async path => path === '/proc/self/cgroup' ? '0::' + group : JSON.stringify({ schemaVersion: 1, profile: '/profile', dataDir: '/data' }),
    }), undefined);
  }
});

test('manual managed restart shares task waiting and admission, and releases admission on failure', { timeout: 10_000 }, async t => {
  const admission = createRestartAdmission();
  let attempts = 0;
  const f = await fixture(t, { installation: 'server', platform: 'linux',
    host: { restartAdmission: admission, idlePollMs: 10, restartServer: async () => {
      admission.check();
    } },
  });
  f.setBusy(true);
  await f.service.dispatch({ action: 'restart-host' });
  assert.equal((await f.service.status()).lastAction, 'restart');
  assert.doesNotThrow(() => admission.check());
  f.setBusy(false);
  await f.service.settled();
  assert.match((await f.service.status()).error, /正在重启/);
  assert.doesNotThrow(() => admission.check());
  const next = await f.startService({ restartServer: async () => { attempts++; }, restartAdmission: admission });
  t.after(() => next.close());
  await next.dispatch({ action: 'restart-host' }); await next.settled();
  assert.equal(attempts, 1);
  assert.equal((await next.status()).hostHealth.restart, 'restarting');
  assert.throws(() => admission.check(), { status: 503 });
  await next.close();
  assert.doesNotThrow(() => admission.check());
});

test('a prepared managed update resumes after plugin disposal without a second download', { timeout: 10_000 }, async t => {
  let restarts = 0;
  const f = await fixture(t, { installation: 'server', platform: 'linux', serverCatalog() {},
    host: { idlePollMs: 10, restartServer: async () => { restarts++; } },
    beforeActivate: () => { f.setBusy(true); },
  });
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  await f.service.dispatch({ action: 'install' });
  while (f.activated() !== 1) await delay(10);
  await f.service.close();
  assert.equal(restarts, 0);
  f.setBusy(false);
  const next = await f.startService();
  t.after(() => next.close());
  await next.settled();
  assert.equal(restarts, 1);
  assert.equal(f.downloads(), 1);
  assert.equal(f.activated(), 1);
});

test('signed check, verified install, persistence and restart state form one complete update path', async t => {
  const f = await fixture(t, { appVersionInFeed: '0.1.2' });
  assert.equal((await f.service.status()).config.source, 'mirror');
  await f.service.dispatch({ action: 'configure', source: 'custom', mirrorUrl: 'https://mirror.example.com/' });
  assert.equal(JSON.parse(await readFile(join(f.directory, 'updates.json'))).source, 'custom');
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  assert.equal((await f.service.status()).canInstall, true);
  await f.service.dispatch({ action: 'install' }); await f.service.settled();
  const status = await f.service.status();
  assert.equal(f.activated(), 1); assert.equal(status.restartRequired, true); assert.equal(status.current.plugin, '0.1.2'); assert.equal(status.current.app, '0.1.2');
  assert.equal(status.decision.restartOnly, true);
  assert.equal(status.release.plugin.available, false, 'a staged update is waiting for restart, not another installation');
  await assert.rejects(f.service.dispatch({ action: 'install' }), /重启/);
});

test('restart alone requires a matching signed target and a known application that already satisfies it', async t => {
  for (const options of [
    { appVersionInFeed: '0.1.4' },
    { appVersionInFeed: '0.1.2', state: { appVersion: undefined } },
    { appVersionInFeed: '0.1.2', state: { version: '0.1.4' } },
    {},
  ]) {
    const f = await fixture(t, { ...options, state: { version: '0.1.3', ...options.state } });
    assert.equal((await f.service.status()).decision.restartOnly, undefined);
    await f.service.dispatch({ action: 'check' }); await f.service.settled();
    const { decision } = await f.service.status();
    assert.equal(decision.action, 'restart');
    assert.equal(decision.restartOnly, undefined);
  }
});

test('status exposes real download, extraction and activation progress without changing the legacy active phase', async t => {
  const observations = [];
  let f;
  f = await fixture(t, {
    beforeDownload: async () => observations.push(await f.service.status()),
    beforePrepare: async () => {
      const first = await f.service.status(), second = await f.service.status();
      assert.equal(second.progress.updatedAt, first.progress.updatedAt, 'polling does not invent a progress heartbeat');
      observations.push(first);
    },
    beforeActivate: async () => observations.push(await f.service.status()),
  });
  assert.equal((await f.service.status()).progress, null);
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  await f.service.dispatch({ action: 'install' }); await f.service.settled();
  assert.deepEqual(observations.map(value => value.progress.stage), ['downloading', 'extracting', 'activating']);
  assert.ok(observations.every(value => value.phase === 'downloading'));
  assert.equal(observations[0].progress.transferred, 0);
  for (const value of observations) {
    assert.ok(value.progress.total > 0 && value.progress.transferred <= value.progress.total);
    assert.ok(Number.isFinite(Date.parse(value.progress.updatedAt)));
  }
  assert.equal(observations[1].progress.transferred, observations[1].progress.total);
  assert.equal(observations[2].progress.bytesPerSecond, 0);
  assert.equal((await f.service.status()).phase, 'ready');
});

test('a prepared release blocked by new work is revalidated and activated on retry without another download', async t => {
  const f = await fixture(t, { beforeDownload: busy => busy() });
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  await f.service.dispatch({ action: 'install' }); await f.service.settled();
  assert.equal((await f.service.status()).phase, 'error');
  assert.equal(f.downloads(), 1); assert.equal(f.prepared(), 1); assert.equal(f.activated(), 0);
  f.setBusy(false);
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  assert.equal((await f.service.status()).progress, null, 'a fresh check clears old installation progress');
  await f.service.dispatch({ action: 'install' }); await f.service.settled();
  assert.equal(f.downloads(), 1); assert.equal(f.prepared(), 2); assert.equal(f.activated(), 1);
  assert.equal((await f.service.status()).restartRequired, true);
  assert.deepEqual(await readdir(f.state.root), [], 'the completed archive is removed after staging');
});

test('reusing a staged release still refuses failed revalidation and never activates its cached result', async t => {
  const f = await fixture(t, { beforeDownload: busy => busy(), beforePrepare: input => { if (!input.archive) throw Error('共享服务版本不兼容'); } });
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  await f.service.dispatch({ action: 'install' }); await f.service.settled();
  f.setBusy(false);
  await f.service.dispatch({ action: 'install' }); await f.service.settled();
  assert.equal(f.downloads(), 1); assert.equal(f.prepared(), 2); assert.equal(f.activated(), 0);
  const status = await f.service.status();
  assert.equal(status.phase, 'error'); assert.equal(status.progress.stage, 'verifying');
  assert.match(status.error, /版本不兼容/);
});

test('closing the update service cancels a stalled reader and removes its partial archive', { timeout: 2000 }, async t => {
  const stalled = Promise.withResolvers();
  let pulls = 0, cancelled = false;
  const f = await fixture(t, { downloadResponse: artifact => new Response(new ReadableStream({ pull(controller) {
    if (!pulls++) controller.enqueue(artifact.subarray(0, 2));
    else stalled.resolve();
  }, cancel() { cancelled = true; return new Promise(() => {}); } }, { highWaterMark: 0 })) });
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  await f.service.dispatch({ action: 'install' }); await stalled.promise;
  await f.service.close();
  assert.equal(cancelled, true);
  assert.equal(f.prepared(), 0); assert.equal(f.activated(), 0);
  assert.match((await f.service.status()).error, /取消/);
  assert.deepEqual(await readdir(f.state.root), []);
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
  assert.equal(status.release.app, undefined);
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

test('a managed Linux host installs the signed Linux seed through the normal plugin update action', async t => {
  const f = await fixture(t, { appVersion: '0.1.1', appVersionInFeed: '0.1.6', installation: 'server', platform: 'linux',
    state: { appVersion: '0.1.1' }, serverCatalog() {} });
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  const status = await f.service.status();
  assert.equal(status.current.app, undefined);
  assert.equal(status.release.app, undefined);
  assert.equal(status.release.plugin.url, undefined);
  assert.equal(status.release.plugin.available, true);
  assert.equal(status.canInstall, true);
  assert.equal(f.downloads(), 0);
  await f.service.dispatch({ action: 'install' }); await f.service.settled();
  assert.equal(f.downloads(), 1); assert.equal(f.activated(), 1);
  assert.equal((await f.service.status()).restartRequired, true);
});

test('Linux refuses mismatched signed release metadata and unsupported architectures before downloading', async t => {
  for (const [options, message] of [
    [{ serverCatalog: catalog => { catalog.sourceSha = 'c'.repeat(40); } }, /不一致/],
    [{ serverCatalog: catalog => { catalog.files[1].arch = 'arm64'; } }, /平台/],
    [{ arch: 'arm64', serverCatalog() {} }, /部署入口/],
    [{}, /部署入口/],
  ]) {
    const f = await fixture(t, { installation: 'server', platform: 'linux', ...options });
    await f.service.dispatch({ action: 'check' }); await f.service.settled();
    const status = await f.service.status();
    assert.equal(status.canInstall, false);
    assert.match(status.error || status.decision.reason, message);
    await assert.rejects(f.service.dispatch({ action: 'install' }));
    assert.equal(f.downloads(), 0);
  }
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

test('mounted updates identify only the official running engine manifest across desktop, server and source layouts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-update-engine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    { label: 'desktop', path: 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh', name: 'desktop', manifest: { name: '@deepseek-ai/dsh', version: '0.2.2-rc.5' }, expected: '0.2.2-rc.5' },
    { label: 'server', path: 'runtime/node_modules/@deepseek-ai/dsh', name: 'web', manifest: { name: '@deepseek-ai/dsh', version: '1.2.3' }, expected: '1.2.3' },
    { label: 'source', path: 'source/apps/cli', name: 'desktop', manifest: { name: '@deepseek-ai/dsh', version: '2.3.4-beta.1' }, expected: '2.3.4-beta.1' },
    { label: 'wrong-package', manifest: { name: 'benchgo-desktop', version: '9.9.9' } },
    { label: 'invalid-version', manifest: { name: '@deepseek-ai/dsh', version: 'invalid' } },
    { label: 'missing-version', manifest: { name: '@deepseek-ai/dsh' } },
    { label: 'missing-manifest' },
  ];
  for (const item of cases) await t.test(item.label, async () => {
    const directory = join(root, item.label), installAnchor = join(directory, item.path ?? 'runtime', 'package.json');
    if (item.manifest) {
      await mkdir(dirname(installAnchor), { recursive: true });
      await writeFile(installAnchor, JSON.stringify(item.manifest));
    }
    const ctx = {
      get: name => name === 'profileContext' ? { name: item.name ?? 'desktop', dir: directory, installAnchor } : undefined,
      effect: fn => fn(), connection: { fetch: { register: () => () => {} } },
    };
    const service = await mountUpdates(ctx, { store: { directory }, list: () => [] });
    try { assert.equal((await service.status()).current.engine, item.expected); }
    finally { await service.close(); }
  });
});

test('packaged mount revalidates a busy-blocked signed release and installs through the official anchor without redownloading', async t => {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-update-packaged-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (file, value) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const runtime = join(root, 'resources/app.asar/dsh');
  const installAnchor = join(runtime, 'node_modules/@deepseek-ai/dsh/package.json');
  const engineVersion = '1.2.3', version = '0.1.3', profile = join(root, 'profile'), releases = join(profile, '.benchgo/releases');
  await put(installAnchor, { name: '@deepseek-ai/dsh', version: engineVersion });
  await put(join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/package.json'), { name: '@deepseek-ai/dsh-app-boot', version: engineVersion });
  await put(join(runtime, 'node_modules/@deepseek-ai/dsh-llm/package.json'), { name: '@deepseek-ai/dsh-llm', version: engineVersion });
  const atomic = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-atomic-write/package.json');
  await symlink(dirname(atomic), join(runtime, 'node_modules/@deepseek-ai/dsh-atomic-write'), process.platform === 'win32' ? 'junction' : 'dir');
  await put(join(profile, 'package.json'), { private: true, dependencies: { kept: '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] }, plusInstall: { schemaVersion: 1, version: '0.1.2', root: releases, appVersion: '0.1.2' } } });
  await put(join(profile, 'cordis.patch.yml'), '# keep user settings\n');
  const seed = join(root, 'seed'), bundleName = releaseBundleName(version);
  await put(join(seed, 'release.json'), { schemaVersion: 1, version, platform: process.platform, arch: process.arch, shared: [{ name: '@deepseek-ai/dsh-llm', version: engineVersion }] });
  await put(join(seed, 'node_modules/benchgo-plugin/package.json'), { name: 'benchgo-plugin', version, exports: { '.': './src/plugin.mjs' } });
  for (const file of ['src/plugin.mjs', 'lib/client.js', 'lib/link.mjs', 'lib/link-web/index.html', 'cordis.patch.yml']) await put(join(seed, 'node_modules/benchgo-plugin', file), 'fixture');
  await put(join(seed, 'node_modules', bundleName, 'package.json'), { name: bundleName, version, dependencies: { 'benchgo-plugin': version } });
  const archive = join(root, 'plugin.tar.gz');
  await tar.c({ cwd: seed, file: archive, gzip: true }, ['release.json', 'node_modules']);
  const artifact = await readFile(archive), { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, version, engine: { min: engineVersion, max: engineVersion }, plugin: { version, url: 'https://github.com/zhuogo/BenchGo/releases/download/plugin-v0.1.3/benchgo-0.1.3-plugin.tar.gz', size: artifact.length, sha256: createHash('sha256').update(artifact).digest('hex') } }));
  const signature = sign(null, bytes, privateKey).toString('base64');
  const ctx = {
    get: name => name === 'profileContext' ? { name: 'desktop', dir: profile, installAnchor } : undefined,
    effect: fn => fn(), connection: { fetch: { register: () => () => {} } },
  };
  let busy = false, downloads = 0, preparations = 0;
  const service = await mountUpdates(ctx, { store: { directory: profile }, list: () => busy ? [{ status: 'running' }] : [] }, {
    version: '0.1.2', platform: 'win32', arch: 'x64', publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    fetcher: async url => {
      if (url.endsWith('.sig')) return new Response(signature);
      if (url.endsWith('.json')) return new Response(bytes);
      downloads++; return new Response(artifact);
    },
    install: {
      getInstallState,
      prepareRelease: async input => {
        assert.equal(input.runtime, dirname(installAnchor));
        const prepared = await prepareRelease(input);
        if (++preparations === 1) busy = true;
        return prepared;
      },
      activateRelease: input => { assert.equal(input.runtime, dirname(installAnchor)); return activateRelease(input); },
    },
  });
  t.after(() => service.close());
  await service.dispatch({ action: 'check' }); await service.settled();
  assert.equal((await service.status()).current.engine, engineVersion);
  assert.equal((await service.status()).canInstall, true);
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-atomic-write') throw Object.assign(new Error('no packaged bare dependency'), { code: 'ERR_MODULE_NOT_FOUND' });
    return nextResolve(specifier, context);
  } });
  try {
    await service.dispatch({ action: 'install' }); await service.settled();
    assert.match((await service.status()).error, /新任务/);
    assert.equal((await service.status()).restartRequired, false);
    busy = false;
    await service.dispatch({ action: 'install' }); await service.settled();
  }
  finally { hooks.deregister(); }
  const status = await service.status(), state = await getInstallState(profile);
  assert.equal(status.error, ''); assert.equal(status.restartRequired, true);
  assert.equal(downloads, 1); assert.equal(preparations, 2);
  assert.equal(state.version, version);
  assert.equal(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')).dependencies.kept, '1.0.0');
  assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), '# keep user settings\n');
  await assert.rejects(lstat(join(state.directory, 'node_modules/@deepseek-ai/dsh-llm')), { code: 'ENOENT' });
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
