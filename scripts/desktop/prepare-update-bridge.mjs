import { resolve } from 'node:path';

/** One explicit product action owns native target selection and its restart authorization. */
export function createNativeUpdateActions({ updates, blocked, authorize, prepareRestart, relaunch, failure }) {
  let pending;
  const run = work => {
    if (pending || blocked()) return Promise.reject(new Error('主机更新正在进行，请稍候'));
    pending = Promise.resolve().then(work).finally(() => { authorize(false); pending = undefined; });
    return pending;
  };
  return {
    get pending() { return !!pending; },
    apply: () => run(async () => {
      let state = await updates.check(true);
      const revision = updates.revision;
      const version = state.version;
      if (state.phase === 'idle' || state.phase === 'error' && state.failedOperation !== 'install') return state;
      if (!version) throw new Error('无法确认主机应用更新目标，请重新检查');
      if (state.phase === 'available') state = await updates.download(version, revision);
      if (revision !== updates.revision) throw new Error('更新来源已变化，请重新检查');
      if (state.phase === 'error' && state.failedOperation !== 'install') return state;
      if (state.phase !== 'ready' && !(state.phase === 'error' && state.failedOperation === 'install')) throw new Error('主机应用更新尚未准备好，请稍后重试');
      authorize(true);
      return updates.install(version, revision);
    }),
    restart: () => run(async () => {
      authorize(true);
      try {
        if (!await prepareRestart()) throw new Error('主机未完成重启准备，请重试');
        await relaunch();
        return { phase: 'installing' };
      } catch (error) { return failure(error); }
    }),
  };
}

function replaceOnce(code, before, after) {
  if (code.split(before).length !== 2) throw new Error('Official desktop changed; review update bridge anchor: ' + before.slice(0, 70));
  return code.replace(before, after);
}

/** Compile against the pinned official lifecycle; no runtime monkey patches or upstream edits. */
export function prepareUpdateMainInput(source) {
  let code = source.replaceAll('\r\n', '\n');
  code = replaceOnce(code, 'const updates = new DesktopUpdateCoordinator(publishUpdate, async () => {',
    'let benchgoUpdateAuthorized = false;\n    const benchgoPrepareRestart = async () => {');
  code = replaceOnce(code, "const active = await host.updateTasks('inspect');", "const active = await host.updateTasks('inspect');\n        if (benchgoUpdateAuthorized && active) throw new DesktopUpdatePreparationError('tasks-changed', locale.messages.updateTasksChanged);");
  code = replaceOnce(code, 'const ready = desktopUpdateReadyConfirmation(', 'if (!benchgoUpdateAuthorized) {\n        const ready = desktopUpdateReadyConfirmation(');
  code = replaceOnce(code, '// The update lock rejects new HTTP requests, including analytics intake.', '}\n        // The update lock rejects new HTTP requests, including analytics intake.');
  code = replaceOnce(code, '}, undefined, undefined, undefined, (success, reason) =>', '};\n    const updates = new DesktopUpdateCoordinator(publishUpdate, benchgoPrepareRestart, undefined, undefined, undefined, (success, reason) =>');
  code = replaceOnce(code, "ipcMain.handle(DESKTOP_IPC.updatesOpen, async (event) => {", `const benchgoNativeUpdates = (${createNativeUpdateActions.toString()})({
        updates, blocked: () => quitting || promptOperation !== undefined || authenticationOperation !== undefined || channelState?.changing || ['checking', 'downloading', 'verifying', 'installing'].includes(updates.state.phase),
        authorize: value => { benchgoUpdateAuthorized = value; },
        prepareRestart: benchgoPrepareRestart,
        relaunch: () => { shellInstallerOwnsQuit = false; app.relaunch(); quitWithoutConfirmation(); },
        failure: error => publishUpdate({ phase: 'error', failedOperation: 'install', message: error.message,
            ...(error instanceof DesktopUpdatePreparationError ? { preparationFailure: error.kind, technicalDetails: error.technicalDetails } : {}) }),
    });
    ipcMain.handle('benchgo-desktop:updates-apply', async (event) => {
        assertProductSender(event);
        return updatePresentation(await benchgoNativeUpdates.apply());
    });
    ipcMain.handle('benchgo-desktop:updates-restart', async (event) => {
        assertProductSender(event);
        return updatePresentation(await benchgoNativeUpdates.restart());
    });
    ipcMain.handle(DESKTOP_IPC.updatesOpen, async (event) => {`);
  code = replaceOnce(code, 'await openUpdatePrompt();', 'if (benchgoNativeUpdates.pending) return;\n        await openUpdatePrompt();');
  return code;
}

export function prepareUpdatePreloadInput(source) {
  return replaceOnce(source.replaceAll('\r\n', '\n'), 'open: () => ipcRenderer.invoke(DESKTOP_IPC.updatesOpen),', `open: () => ipcRenderer.invoke(DESKTOP_IPC.updatesOpen),
            apply: () => ipcRenderer.invoke('benchgo-desktop:updates-apply'),
            restart: () => ipcRenderer.invoke('benchgo-desktop:updates-restart'),`);
}

export function updateBridgePlugin(path, preload = false) {
  const target = resolve(path); let count;
  return { name: preload ? 'benchgo-update-preload' : 'benchgo-update-main',
    buildStart() { count = 0; },
    transform(source, id) { if (resolve(id) !== target) return null; count++; return { code: (preload ? prepareUpdatePreloadInput : prepareUpdateMainInput)(source), map: null }; },
    generateBundle() { if (count !== 1) throw new Error(`Official desktop changed: expected one update bridge entry, got ${count}`); },
  };
}

export function verifyUpdateBridgeBundle(source, preload = false) {
  for (const channel of ['benchgo-desktop:updates-apply', 'benchgo-desktop:updates-restart'])
    if (!source.includes(channel)) throw new Error('Compiled desktop is missing the BenchGo update bridge');
  if (preload && (!source.includes('process.isMainFrame') || !source.includes('createProductApi'))) throw new Error('Compiled update preload lost its document boundary');
  if (!preload && !source.includes('benchgoUpdateAuthorized')) throw new Error('Compiled update bridge lost its authorization boundary');
}
