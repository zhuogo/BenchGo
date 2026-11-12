import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_UPDATE_CONFIG, normalizeUpdateConfig, fetchVerifiedRelease, fetchUpdateArtifact, compareVersions, isNewerVersion, resolveUpdateUrl } from '../shared/update-feed.mjs';
import { prepareRelease, activateRelease, getInstallState, rollbackRelease } from '../shared/plugin-install.mjs';
import { assertSameOrigin } from '../shared/http.mjs';
import { readLimited } from '../shared/http.mjs';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const conflict = message => Object.assign(new Error(message), { status: 409 });

/** Read the immutable application's version, never the independently updated plugin version. */
export async function desktopApplicationVersion(executable = process.execPath, readJson = json) {
  try {
    const app = await readJson(join(dirname(executable), 'resources', 'app.asar', 'package.json'));
    if (app.name === 'benchgo-desktop' && typeof app.version === 'string') {
      isNewerVersion(app.version, app.version);
      return app.version;
    }
  } catch {}
  return undefined;
}

/** Each immutable release is staged before one profile manifest switch; loaded code stays intact. */
export async function createUpdates({ directory, profile, runtime, version, releaseVersion, engineVersion, appVersion, isBusy = () => false,
  installation = 'desktop', fetcher = globalThis.fetch, publicKey, install = { prepareRelease, activateRelease, getInstallState, rollbackRelease } }) {
  const configFile = join(directory, 'updates.json');
  const lifetime = new AbortController();
  const updateFetch = (url, options = {}) => fetcher(url, { ...options, signal: AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])]) });
  let config = { ...DEFAULT_UPDATE_CONFIG }, phase = 'idle', release = null, error = '', checkedAt = null, task = null, lastAction = null, closed = false;
  let confirmedReleaseVersion = releaseVersion;
  try { config = normalizeUpdateConfig(await json(configFile)); } catch (failure) { if (failure.code !== 'ENOENT') error = '更新源配置读取失败，请重新选择更新来源'; }
  const installed = async () => profile ? await install.getInstallState(profile) : { managed: false };
  const compatibility = state => {
    const currentApp = installation === 'desktop' ? appVersion ?? state.appVersion : undefined;
    let engineCompatible = false, appCompatible = true, reason = '', needsApp = false;
    if (!release) return { currentApp, engineCompatible, appCompatible, compatible: false, reason: '请先检查更新', needsApp };
    if (!engineVersion) reason = '无法识别当前引擎版本，暂不能安装插件';
    else if (compareVersions(engineVersion, release.engine.min) < 0) {
      needsApp = installation === 'desktop';
      reason = needsApp ? '当前引擎版本过旧，请先升级应用' : '当前引擎版本过旧，请由维护者升级服务器引擎';
    } else if (release.engine.max && compareVersions(engineVersion, release.engine.max) > 0) reason = '此插件尚不支持当前较新的引擎，请等待兼容版本';
    else engineCompatible = true;
    if (installation === 'desktop' && release.minAppVersion) {
      appCompatible = !!currentApp && compareVersions(currentApp, release.minAppVersion) >= 0;
      if (!appCompatible && !reason) {
        needsApp = !!currentApp;
        reason = currentApp ? `此插件需要应用 v${release.minAppVersion} 或更新版本，请先升级应用` : '无法识别当前应用版本，暂不能确认插件所需的桌面能力';
      }
    }
    return { currentApp, engineCompatible, appCompatible, compatible: engineCompatible && appCompatible, reason, needsApp };
  };
  const status = async () => {
    const state = await installed(), busy = !!(await isBusy());
    const restartRequired = !!state.managed && state.version !== version;
    const { currentApp, compatible, engineCompatible, appCompatible, reason, needsApp } = compatibility(state);
    // A source-deployed host has no desktop application to compare. Unknown is
    // not an older version, including desktop profiles without app metadata.
    const pluginAvailable = !!release && !restartRequired && isNewerVersion(release.plugin.version, version);
    const appAvailable = !!release?.app && !!currentApp && isNewerVersion(release.app.version, currentApp);
    const unavailable = closed || !!task;
    // App-only and notes-only releases may reuse an older feature archive.
    // Its embedded identity is a baseline; only a successful signed check and
    // satisfied host components can confirm a newer public release identity.
    const knownApp = installation !== 'desktop' || !release?.app || !!currentApp;
    if (release?.releaseVersion && checkedAt && phase === 'idle' && !unavailable && !restartRequired
      && compatible && knownApp && !pluginAvailable && !appAvailable
      && (!confirmedReleaseVersion || isNewerVersion(release.releaseVersion, confirmedReleaseVersion))) confirmedReleaseVersion = release.releaseVersion;
    const busyReason = busy ? '有任务正在运行，结束后再更新' : '';
    let decision;
    const decide = (action, available, enabled, explanation = '', targetVersion) => ({ action, available, enabled: !!enabled && !unavailable, reason: explanation, ...(targetVersion ? { targetVersion } : {}) });
    if (restartRequired) decision = decide('restart', true, !busy, busyReason || (installation === 'server' ? '插件已准备好，请重启主机服务后生效' : '插件已准备好，请重启主机应用后生效'), state.version);
    else if (task) decision = decide('check', pluginAvailable || appAvailable, false, phase === 'downloading' ? '正在准备更新' : '正在检查更新');
    else if (phase === 'error' && lastAction === 'check') decision = decide('check', pluginAvailable || appAvailable, true, error || '更新检查失败，请重试');
    else if (!release) decision = decide('check', false, true, error || (phase === 'unpublished' ? '更新通道尚未就绪' : '检查可用更新'));
    else if (pluginAvailable && installation === 'server' && !state.managed) decision = decide('deployment', true, false, '此主机由服务器部署管理，请由维护者更新', release.plugin.version);
    else if (pluginAvailable && !compatible) {
      const appResolvesMinimum = !release.minAppVersion || release.app && compareVersions(release.app.version, release.minAppVersion) >= 0;
      decision = needsApp && appAvailable && appResolvesMinimum
        ? decide('app', true, !busy, busyReason || reason, release.app.version)
        : decide('blocked', true, false, reason, release.plugin.version);
    } else if (pluginAvailable && !state.managed) decision = appAvailable
      ? decide('app', true, !busy, busyReason || '当前安装方式需要先升级应用，才能独立更新插件', release.app.version)
      : decide('blocked', true, false, '当前安装方式不支持独立更新，请先安装支持插件更新的新版应用', release.plugin.version);
    else if (pluginAvailable) decision = decide('plugin', true, !busy, busyReason, release.plugin.version);
    else if (appAvailable && !engineCompatible && !needsApp) decision = decide('blocked', true, false, reason, release.app.version);
    else if (appAvailable) decision = decide('app', true, !busy, busyReason, release.app.version);
    else if (!compatible) decision = decide('blocked', false, false, reason);
    else if (!knownApp) decision = decide('blocked', false, false, '无法识别当前应用版本，暂不能确认主机应用是否需要更新');
    else decision = decide('current', false, false, '当前主机已是可用最新版本');
    return {
      // A check can publish its release before the task's finalizer releases admission.
      // Keep that intermediate response active so clients continue polling readiness.
      phase: restartRequired ? 'ready' : task && phase === 'idle' ? 'checking' : phase, lastAction, installation, notice: phase === 'unpublished' ? '更新通道尚未就绪' : '', config, current: { plugin: version, engine: engineVersion, app: currentApp, ...(confirmedReleaseVersion ? { release: confirmedReleaseVersion } : {}) },
      managed: !!state.managed, busy, restartRequired, checkedAt, error,
      decision,
      canInstall: decision.action === 'plugin' && decision.enabled,
      canRollback: !!state.managed && !!state.previous && !busy && !restartRequired && !unavailable,
      release: release ? { ...release, plugin: { ...release.plugin, available: pluginAvailable, compatible, engineCompatible, appCompatible, reason: compatible ? undefined : reason },
        ...(release.app ? { app: { ...release.app, available: appAvailable, url: resolveUpdateUrl(release.app.url, config) } } : {}),
        ...(release.android ? { android: { ...release.android, url: resolveUpdateUrl(release.android.url, config) } } : {}) } : null,
    };
  };
  const start = (action, work) => {
    lastAction = action;
    error = '';
    task = Promise.resolve().then(work).catch(failure => {
      if (failure.code === 'UPDATE_UNPUBLISHED') { release = null; error = ''; phase = 'unpublished'; }
      else { error = failure.message; phase = 'error'; }
    }).finally(() => { task = null; });
  };
  const guard = async () => {
    if (closed) throw conflict('更新服务已关闭');
    if (task) throw conflict('更新正在进行，请稍候');
    const state = await installed();
    if (!state.managed) throw conflict(installation === 'server' ? '此主机由服务器部署管理，请由维护者更新' : '此安装需要先升级一次应用，才能独立更新插件');
    if (state.version !== version) throw conflict('请先重启主机应用，使已准备的版本生效');
    if (await isBusy()) throw conflict('有任务正在运行，结束后再更新');
    return state;
  };
  // Reserve mutation admission synchronously, before asynchronous profile/task inspection.
  let dispatching = false;
  const dispatch = async input => {
    if (input.action === 'status') return status();
    if (closed) throw conflict('更新服务已关闭');
    if (dispatching || task) throw conflict('更新正在进行，请稍候');
    dispatching = true;
    try {
      switch (input.action) {
        case 'configure': {
          const state = await installed();
          if (state.managed && state.version !== version) throw conflict('请先重启主机应用');
          const next = normalizeUpdateConfig(input);
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const temporary = `${configFile}.${randomUUID()}.tmp`;
          try { await writeFile(temporary, JSON.stringify(next), { mode: 0o600 }); await rename(temporary, configFile); }
          finally { await rm(temporary, { force: true }); }
          config = next; release = null; error = ''; phase = 'idle'; checkedAt = null;
          break;
        }
        case 'check': {
          phase = 'checking';
          start('check', async () => {
            const next = await fetchVerifiedRelease({ config, fetcher: updateFetch, publicKey });
            release = next;
            checkedAt = new Date().toISOString(); phase = 'idle';
          });
          break;
        }
        case 'install': {
          const state = await guard();
          if (phase === 'error' && lastAction === 'check') throw conflict('上次更新检查失败，请重新检查后再安装');
          const compatible = compatibility(state);
          if (!release || !compatible.compatible) throw conflict(compatible.reason);
          if (!isNewerVersion(release.plugin.version, version)) throw conflict('插件已是最新版本');
          const selected = release;
          phase = 'downloading';
          start('install', async () => {
            const archive = join(state.root, `.download-${randomUUID()}.tar.gz`);
            try {
              await mkdir(state.root, { recursive: true, mode: 0o700 });
              await fetchUpdateArtifact(selected.plugin, { file: archive, config, fetcher: updateFetch });
              if (closed) throw new Error('更新已取消');
              const prepared = await install.prepareRelease({ archive, root: state.root, version: selected.plugin.version, runtime });
              if (closed) throw new Error('更新已取消');
              if (await isBusy()) throw conflict('下载期间有新任务开始，结束后再点更新');
              await install.activateRelease({ profile, runtime, release: prepared });
              phase = 'ready';
            } finally { await rm(archive, { force: true }); }
          });
          break;
        }
        case 'rollback': {
          const state = await guard();
          if (!state.previous) throw conflict('暂无可回退版本');
          phase = 'downloading';
          start('rollback', async () => { if (await isBusy()) throw conflict('有任务正在运行'); await install.rollbackRelease({ profile, runtime }); phase = 'ready'; });
          break;
        }
        default: throw new Error('未知更新操作');
      }
      return status();
    } finally { dispatching = false; }
  };
  return { dispatch, status, settled: async () => { await task; }, close: async () => { closed = true; lifetime.abort(); await task; } };
}

export async function mountUpdates(ctx, commander, options = {}) {
  const context = ctx.get('profileContext');
  const runtime = context?.installAnchor && dirname(context.installAnchor);
  const pkg = await json(new URL('../package.json', import.meta.url));
  let engineVersion;
  try { engineVersion = (await json(join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/package.json'))).version; } catch {}
  const appVersion = context?.name === 'desktop' ? await desktopApplicationVersion() : undefined;
  const service = await createUpdates({ directory: options.directory ?? commander?.store.directory, profile: context?.dir, runtime, installation: context?.name === 'desktop' ? 'desktop' : 'server', version: pkg.version, releaseVersion: pkg.benchgo?.releaseVersion, engineVersion, appVersion,
    isBusy: () => (commander ?? ctx.get('commander'))?.list().some(session => ['running', 'connecting', 'waiting'].includes(session.status)) ||
      (ctx.get('agents')?.list?.() ?? []).some(agent => agent.status === 'running'), ...options });
  const fetch = async request => {
    try {
      assertSameOrigin(request);
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw Object.assign(new Error('Expected application/json'), { status: 415 });
      const input = JSON.parse(new TextDecoder().decode(await readLimited(request, 4096)));
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求必须为 JSON 对象');
      return Response.json(await service.dispatch(input), { headers: { 'cache-control': 'no-store' } });
    } catch (failure) { return Response.json({ error: failure.message }, { status: failure.status || 400, headers: { 'cache-control': 'no-store' } }); }
  };
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/commander/updates', methods: ['POST'], requestBody: 'buffered', fetch }));
  ctx.effect(() => () => service.close());
  return service;
}
