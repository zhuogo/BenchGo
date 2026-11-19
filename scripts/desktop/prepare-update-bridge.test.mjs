import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createNativeUpdateActions, prepareUpdateMainInput, prepareUpdatePreloadInput, updateBridgePlugin } from './prepare-update-bridge.mjs';

const mainPath = new URL('../../deepseek-harness/apps/desktop/lib/types/main.js', import.meta.url);
const preloadPath = new URL('../../deepseek-harness/apps/desktop/lib/types/preload-app.js', import.meta.url);

function fixture(state = { phase: 'available', version: '2.0.0' }) {
  const events = [];
  const updates = { revision: 4, state,
    check: async manual => { events.push(['check', manual]); return updates.state; },
    download: async (version, revision) => { events.push(['download', version, revision]); return updates.state = { phase: 'ready', version }; },
    install: async (version, revision) => { events.push(['install', version, revision]); return updates.state = { phase: 'installing', version }; },
  };
  const actions = createNativeUpdateActions({ updates, blocked: () => false, authorize: value => events.push(['authorized', value]),
    prepareRestart: async () => { events.push(['stop']); return true; }, relaunch: async () => events.push(['relaunch']),
    failure: error => ({ phase: 'error', message: error.message }) });
  return { actions, updates, events };
}

test('one authorization selects the native target and revision and hands off installation without restarting twice', async () => {
  const f = fixture();
  assert.equal((await f.actions.apply('ignored renderer target')).phase, 'installing');
  assert.deepEqual(f.events, [['check', true], ['download', '2.0.0', 4], ['authorized', true], ['install', '2.0.0', 4], ['authorized', false]]);
});

test('no application update returns idle and leaves the feature-package restart to its caller', async () => {
  const f = fixture({ phase: 'idle' });
  assert.deepEqual(await f.actions.apply(), { phase: 'idle' });
  assert.deepEqual(f.events, [['check', true], ['authorized', false]]);
  assert.equal((await f.actions.restart()).phase, 'installing');
  assert.deepEqual(f.events.slice(2), [['authorized', true], ['stop'], ['relaunch'], ['authorized', false]]);
});

test('changed channel, concurrent requests and failed downloads never authorize installation', async () => {
  const f = fixture();
  let finish;
  f.updates.check = () => new Promise(resolve => { finish = resolve; });
  const operation = f.actions.apply();
  await Promise.resolve();
  await assert.rejects(f.actions.restart(), /正在进行/);
  finish({ phase: 'available', version: '2.0.0' });
  f.updates.download = async () => { f.updates.revision++; return { phase: 'ready', version: '2.0.0' }; };
  await assert.rejects(operation, /来源已变化/);
  assert.deepEqual(f.events, [['authorized', false]]);
  const broken = fixture({ phase: 'error', failedOperation: 'download' });
  assert.equal((await broken.actions.apply()).phase, 'error');
  assert.equal(broken.events.some(([event]) => event === 'install'), false);
});

test('failed native installation retries its downloaded main-owned target', async () => {
  const f = fixture({ phase: 'error', failedOperation: 'install', version: '2.0.0' });
  assert.equal((await f.actions.apply()).phase, 'installing');
  assert.deepEqual(f.events, [['check', true], ['authorized', true], ['install', '2.0.0', 4], ['authorized', false]]);
});

async function nativePreparation({ active = false, changed = false, unclean = false } = {}) {
  const transformed = prepareUpdateMainInput(await readFile(mainPath, 'utf8'));
  const body = transformed.match(/const benchgoPrepareRestart = async \(\) => \{([\s\S]*?)\n    \};\n    const updates = new DesktopUpdateCoordinator/)[1];
  const events = [];
  class PreparationError extends Error { constructor(kind, message) { super(message); this.kind = kind; } }
  const host = { updateTasks: async action => { events.push(action); return action === 'inspect' ? active : action === 'lock' ? changed : false; } };
  const scope = { benchgoUpdateAuthorized: true, commandManager: { idle: async () => {} }, workspaceRecovery: undefined, startup: undefined,
    backend: { host, stop: async () => { events.push('stop'); if (unclean) scope.updateStopFailure = new Error('unclean'); } },
    DesktopUpdatePreparationError: PreparationError, locale: { messages: { updateTasksChanged: 'tasks changed', updateTasksUnavailable: 'unavailable', updateStopFailed: 'unclean' } },
    currentDialogWindow: () => ({}), prepareDesktopUpdateWindow: async () => true,
    desktopUpdateReadyConfirmation: () => assert.fail('must not open confirmation'),
    track: async () => {}, mandatoryUI: undefined, platformView: { closeAndWait: async () => {} }, disposeFileDrag: async () => {},
    requireCleanStop: false, updateStopFailure: undefined, updateStoppedHost: false,
    stopOperationReports: async () => {}, operationJournal: undefined, updateJournal: undefined, shellInstallerOwnsQuit: false, shuttingDown: false };
  return { scope, events, prepare: runInNewContext(`(async () => {${body}\n})`, scope) };
}

test('compiled native preparation rejects current or newly admitted tasks and unlocks without stopping them', async () => {
  const busy = await nativePreparation({ active: true });
  await assert.rejects(busy.prepare(), error => error.kind === 'tasks-changed');
  assert.deepEqual(busy.events, ['inspect']);
  const changed = await nativePreparation({ changed: true });
  await assert.rejects(changed.prepare(), error => error.kind === 'tasks-changed');
  assert.deepEqual(changed.events, ['inspect', 'lock', 'unlock']);
});

test('restart waits for a clean native stop and reports unclean exits without scheduling relaunch', async () => {
  const f = await nativePreparation({ unclean: true }); let relaunched = false, recovered = false;
  const actions = createNativeUpdateActions({ updates: {}, blocked: () => false, authorize: () => {}, prepareRestart: f.prepare,
    relaunch: () => { relaunched = true; }, failure: error => { recovered = f.scope.updateStoppedHost; return { phase: 'error', failure: error.kind }; } });
  assert.deepEqual(await actions.restart(), { phase: 'error', failure: 'stop-failed' });
  assert.equal(relaunched, false); assert.equal(recovered, true); assert.equal(f.scope.requireCleanStop, false);
  const good = await nativePreparation(); assert.equal(await good.prepare(), true);
  assert.deepEqual(good.events, ['inspect', 'lock', 'stop']);
});

test('bridge keeps official sender/frame boundaries and fails compilation when lifecycle anchors drift', async () => {
  const main = await readFile(mainPath, 'utf8'), preload = await readFile(preloadPath, 'utf8');
  const transformed = prepareUpdateMainInput(main);
  for (const channel of ['apply', 'restart']) assert.match(transformed, new RegExp(`ipcMain.handle\\('benchgo-desktop:updates-${channel}', async \\(event\\) => \\{\\s*assertProductSender\\(event\\)`));
  const bridge = prepareUpdatePreloadInput(preload);
  assert.match(bridge, /process\.isMainFrame \? createProductApi\(\)/);
  assert.match(bridge, /apply: \(\) => ipcRenderer.invoke\('benchgo-desktop:updates-apply'\)/);
  assert.throws(() => prepareUpdateMainInput(main.replace("const active = await host.updateTasks('inspect');", 'const active = false;')), /Official desktop changed/);
  assert.throws(() => prepareUpdatePreloadInput(preload + preload), /Official desktop changed/);
  const plugin = updateBridgePlugin('entry'); plugin.buildStart();
  assert.equal(plugin.transform(main, 'another'), null); assert.throws(() => plugin.generateBundle(), /got 0/);
});
