import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginDesktopWorkbench, assertDesktopEnrollmentAvailable, createDesktopWorkbenchOwner, desktopWorkbenchInstallation } from './workbench-desktop.mjs';
import * as shared from '../../plugins/base/shared/workbench-installation.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-desktop-workbench-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), resources = join(root, 'app', 'resources'), runtime = join(resources, 'app.asar.unpacked', 'dsh');
  const paths = shared.workbenchPaths({ home });
  const put = async (file, value) => { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  await put(join(resources, 'app.asar', 'package.json'), { name: 'benchgo-desktop', version: '0.1.3' });
  for (const name of ['dsh', 'dsh-app-boot', 'dsh-official-bundles']) await put(join(runtime, 'node_modules', '@deepseek-ai', name, 'package.json'), { name: `@deepseek-ai/${name}`, version: '0.2.2-rc.1' });
  await put(join(paths.profile, 'package.json'), { private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] }, plusInstall: { version: '0.1.3' } } });
  await put(join(paths.profile, 'cordis.patch.yml'), '# user configuration\n');
  return { root, home, resources, runtime, paths, put };
}

test('desktop and CLI use the identical profile and preserve the installation identity through handoff', async t => {
  const f = await fixture(t), events = [];
  const old = await shared.registerWorkbenchInstallation({ home: f.home, installation: {
    kind: 'web', runtime: f.runtime, profile: f.paths.profile, engineVersion: '0.2.2-rc.1', node: process.execPath,
  } });
  let webRunning = true;
  const api = { ...shared,
    createProfileIntegrityGuard: async ({ paths }) => { events.push('profile-guard'); assert.deepEqual(paths, [join(f.paths.profile, 'cordis.patch.yml'), join(f.home, 'cordis.patch.yml')]); },
    createProfileIntegrityServices: { withFileLock: async (_path, callback) => callback(), writeFileAtomic: async () => {} },
    readWorkbenchLease: args => webRunning ? { pid: process.pid + 100000, kind: 'web', active: true } : shared.readWorkbenchLease(args),
    requestWorkbenchControl: async (installation, options) => {
      assert.equal(installation.id, old.id); assert.equal(options.action, 'stop');
      events.push('graceful-stop'); webRunning = false;
    },
    waitForWorkbenchStop: async () => { events.push('stopped'); },
  };
  const workbench = await beginDesktopWorkbench({ ...f, initialize: async options => {
    events.push('enroll');
    assert.equal(options.profile, f.paths.profile);
    assert.equal((await shared.readWorkbenchLease({ home: f.home })).kind, 'desktop');
    return { profile: options.profile, enrolled: false };
  } }, api);
  t.after(() => workbench.dispose());
  assert.deepEqual(events, ['graceful-stop', 'stopped', 'enroll', 'profile-guard']);
  const current = await shared.readWorkbenchInstallation({ home: f.home });
  assert.equal(current.id, old.id); assert.equal(current.kind, 'desktop');
  assert.equal(current.profile, old.profile); assert.equal(current.runtime, f.runtime);
  assert.equal(await readFile(join(f.paths.profile, 'cordis.patch.yml'), 'utf8'), '# user configuration\n');
  await workbench.dispose();
  assert.equal(await shared.readWorkbenchLease({ home: f.home }), null);
});

test('busy Web handoff fails before acquiring Desktop ownership or enrolling', async t => {
  const f = await fixture(t);
  await shared.registerWorkbenchInstallation({ home: f.home, installation: {
    kind: 'web', runtime: f.runtime, profile: f.paths.profile, engineVersion: '0.2.2-rc.1', node: process.execPath,
  } });
  let enrolled = false, acquired = false;
  await assert.rejects(beginDesktopWorkbench({ ...f, initialize: async () => { enrolled = true; } }, { ...shared,
    readWorkbenchLease: async () => ({ pid: process.pid + 100000, kind: 'web', active: true }),
    requestWorkbenchControl: async () => { throw new Error('有任务运行中'); },
    acquireWorkbenchLease: async () => { acquired = true; },
  }), /有任务运行中/);
  assert.equal(enrolled, false); assert.equal(acquired, false);
  assert.equal((await shared.readWorkbenchInstallation({ home: f.home })).kind, 'web');
});

test('profile integrity recovery must finish before Desktop ownership is registered', async t => {
  const f = await fixture(t);
  let registered = false;
  await assert.rejects(beginDesktopWorkbench({ ...f, initialize: async () => ({ profile: f.paths.profile }) }, {
    ...shared,
    createProfileIntegrityGuard: async () => { throw Object.assign(new Error('profile restored'), { code: 'PROFILE_CONFIG_RESTORED' }); },
    createProfileIntegrityServices: { withFileLock: async (_path, callback) => callback(), writeFileAtomic: async () => {} },
    registerWorkbenchInstallation: async () => { registered = true; },
  }), { code: 'PROFILE_CONFIG_RESTORED' });
  assert.equal(registered, false);
  assert.equal(await shared.readWorkbenchLease({ home: f.home }), null);
});

test('unknown or Desktop owner is never killed or replaced by startup', async t => {
  const f = await fixture(t);
  let stopped = false;
  await assert.rejects(beginDesktopWorkbench({ ...f, initialize: async () => assert.fail('must not enroll') }, { ...shared,
    readWorkbenchLease: async () => ({ pid: process.pid + 100000, kind: 'desktop', active: true }),
    requestWorkbenchControl: async () => { stopped = true; },
  }), /未启动第二个工作台/);
  assert.equal(stopped, false);
});

test('enrollment failure releases the live lease and retains existing user configuration', async t => {
  const f = await fixture(t);
  await assert.rejects(beginDesktopWorkbench({ ...f, initialize: async () => { throw new Error('fixture enrollment failure'); } }), /fixture enrollment failure/);
  assert.equal(await shared.readWorkbenchLease({ home: f.home }), null);
  assert.equal(await readFile(join(f.paths.profile, 'cordis.patch.yml'), 'utf8'), '# user configuration\n');
  await assert.rejects(access(f.paths.ownerFile), { code: 'ENOENT' });
});

test('offline installer refuses another live Host but allows its own startup lease', async () => {
  await assert.rejects(assertDesktopEnrollmentAvailable({}, { readWorkbenchLease: async () => ({ active: true, pid: process.pid + 100000 }) }), /请先.*关闭/);
  await assertDesktopEnrollmentAvailable({}, { readWorkbenchLease: async () => ({ active: true, pid: process.pid }) });
});

test('runtime validation rejects a second profile and incompatible engine before touching configuration', async t => {
  const f = await fixture(t);
  await assert.rejects(desktopWorkbenchInstallation({ ...f, profile: join(f.home, 'profiles', 'web') }), /未创建第二套工作区/);
  await f.put(join(f.runtime, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'), { name: '@deepseek-ai/dsh-app-boot', version: '0.3.0' });
  await assert.rejects(desktopWorkbenchInstallation(f), /依赖身份不一致/);
});

test('unchanged Desktop startup keeps its installation record and checks runtime packages on the next startup', async t => {
  const f = await fixture(t);
  const engine = '0.2.2-rc.1';
  const host = '@deepseek-ai/dsh-desktop-host';
  const hostManifest = join(f.runtime, 'node_modules', host, 'package.json');
  await f.put(hostManifest, { name: host, version: engine });
  const sharedPackages = ['@deepseek-ai/dsh', host].map(name => ({ name, version: engine, path: `node_modules/${name}` }));
  await f.put(join(f.runtime, 'desktop-runtime.json'), { schemaVersion: 1, platform: process.platform, arch: process.arch,
    release: { version: engine }, sharedPackages, files: [] });
  const initialize = async ({ profile }) => ({ profile });
  const api = { ...shared, createProfileIntegrityGuard: async () => {}, createProfileIntegrityServices: {} };
  const start = () => beginDesktopWorkbench({ ...f, initialize }, api);
  await (await start()).dispose();
  await utimes(f.paths.registryFile, 1_600_000_000, 1_600_000_000);
  const initial = await stat(f.paths.registryFile);
  await (await start()).dispose();
  assert.equal((await stat(f.paths.registryFile)).mtimeMs, initial.mtimeMs);
  await f.put(hostManifest, { name: host, version: '0.3.0' });
  await assert.rejects(start(), /共享服务身份不一致/);
  assert.equal(await shared.readWorkbenchLease({ home: f.home }), null);
});

test('Desktop status capability exposes the legacy browser login URL and cannot stop Desktop', async t => {
  const f = await fixture(t);
  const installation = { id: '11111111-1111-4111-8111-111111111111' };
  const owner = await createDesktopWorkbenchOwner({ paths: f.paths, installation });
  t.after(() => owner.dispose());
  await assert.rejects(owner.publish({ url: 'http://example.com/?token=secret', inspect: async () => ({ activeTasks: false, scheduledTasks: false }) }), /连接地址无效/);
  const readyUrl = 'http://127.0.0.1:12345/?token=private-browser-token';
  let activeTasks = true;
  await owner.publish({ url: readyUrl, inspect: async () => ({ activeTasks, scheduledTasks: false }) });
  const stored = JSON.parse(await readFile(f.paths.ownerFile, 'utf8'));
  assert.equal(stored.installationId, installation.id);
  assert.equal(JSON.stringify(stored).includes('private-browser-token'), false);
  const request = (input, headers = {}) => fetch(stored.controlUrl, { method: 'POST', headers: { authorization: `Bearer ${stored.token}`, ...headers }, body: JSON.stringify(input) });
  assert.equal((await fetch(stored.controlUrl)).status, 403);
  assert.equal((await request({ action: 'status' }, { authorization: 'Bearer wrong' })).status, 403);
  assert.equal((await request({ action: 'status' }, { origin: 'https://example.com' })).status, 403);
  assert.equal((await request({ action: 'stop' })).status, 409);
  const response = await request({ action: 'status' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { installationId: installation.id, pid: process.pid, kind: 'desktop', url: readyUrl, activeTasks: true, scheduledTasks: false });
  activeTasks = false;
  const connected = await shared.requestWorkbenchControl(installation, { home: f.home });
  assert.equal(connected.url, readyUrl); assert.equal(connected.activeTasks, false);
  await owner.dispose();
  await assert.rejects(access(f.paths.ownerFile), { code: 'ENOENT' });
});

test('Desktop status accepts an IPC-authenticated Host without exposing its URL as a browser entry', async t => {
  const f = await fixture(t);
  const installation = { id: '11111111-1111-4111-8111-111111111111' };
  const owner = await createDesktopWorkbenchOwner({ paths: f.paths, installation });
  t.after(() => owner.dispose());
  const inspect = async () => ({ activeTasks: false, scheduledTasks: true });
  await assert.rejects(owner.publish({ url: 'http://example.com:12345/', inspect }), /连接地址无效/);
  await owner.publish({ url: 'http://127.0.0.1:12345/', inspect });
  const status = await shared.requestWorkbenchControl(installation, { home: f.home });
  assert.deepEqual(status, { installationId: installation.id, pid: process.pid, kind: 'desktop', activeTasks: false, scheduledTasks: true });
});

test('status refuses unknown task state and never fabricates an idle workbench', async t => {
  const f = await fixture(t);
  const owner = await createDesktopWorkbenchOwner({ paths: f.paths, installation: { id: 'fixture' } });
  t.after(() => owner.dispose());
  await owner.publish({ url: 'http://127.0.0.1:12345/?token=private', inspect: async () => ({ activeTasks: false }) });
  const stored = JSON.parse(await readFile(f.paths.ownerFile, 'utf8'));
  const response = await fetch(stored.controlUrl, { method: 'POST', headers: { authorization: `Bearer ${stored.token}` }, body: JSON.stringify({ action: 'status' }) });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private/);
});
