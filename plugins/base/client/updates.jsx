import * as Dialog from '@radix-ui/react-dialog';
import { Select } from '../../shared/client/select.jsx';
import { readJsonResponse } from './http-response.mjs';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { IconDownloadOutlineMedium, LinkIconMedium, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { Tooltip as BubbleTooltip } from '../../shared/client/ui/tooltip.jsx';
import { UIIcon } from './iconsax.jsx';
import css from './updates.css';
import { brandIcon } from '../../link/client/brand.jsx';
import { Loading } from '../../shared/client/ui/loading.jsx';

const activePhases = new Set(['checking', 'downloading']);
const updatePath = 'api/commander/updates';
const downloadPlatforms = [
  { name: 'Windows', icon: 'computer', packages: [['windows-x64', '.exe', 'x64 · EXE']] },
  { name: 'macOS', icon: 'computer', packages: [['mac-arm64', '.dmg', 'Apple 芯片'], ['mac-x64', '.dmg', 'Intel 芯片']] },
  { name: 'Android', icon: 'mobile', packages: [['android', '.apk', 'APK']] },
  { name: 'Linux 服务端', icon: 'server', packages: [['linux-server', '.tar.gz', 'x64 · TAR.GZ']] },
];
const sourceNames = { mirror: '国内加速', github: 'GitHub 直连', custom: '自定义镜像' };
const httpsUrl = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; } };
const nativeActivePhases = new Set(['checking', 'downloading', 'verifying', 'installing']);
const updateIntentKey = 'benchgo:update-intent';
function readUpdateIntent() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(updateIntentKey) || 'null');
    const age = Date.now() - value?.createdAt;
    return value && age >= 0 && age < 24 * 60 * 60 * 1000 && typeof value.plugin === 'string' ? value : null;
  } catch { return null; }
}
const nativeFailureMessages = {
  configuration: '安装器更新配置暂不可用，请重试并查看原生更新提示。',
  check: '检查安装器更新失败，请重试。',
  'check-network': '无法连接安装器更新服务，请检查网络后重试。',
  download: '应用安装包下载失败，请重试。',
  'download-network': '应用安装包下载中断，请检查网络后重试。',
  'download-space': '磁盘空间不足，请清理空间后重试下载。',
  'download-permission': '没有权限保存应用安装包，请检查目录权限后重试。',
  'download-busy': '应用安装包文件正被占用，请关闭占用程序后重试。',
  install: '应用安装未完成，请重试。',
  'install-network': '应用安装准备时网络中断，请检查网络后重试。',
  'stop-failed': '主机未能安全完成关闭，更新尚未安装。请查看原生更新窗口后重试。',
  'tasks-changed': '安装前有新任务开始，请结束任务后重试。',
  'tasks-unavailable': '暂时无法确认运行任务，请稍后重试安装。',
  'fullscreen-timeout': '暂时无法退出全屏，请退出全屏后重试安装。',
};

const progressStages = {
  downloading: '正在下载', verifying: '正在校验安装包', extracting: '正在解包功能包',
  activating: '正在准备功能包', installing: '正在准备安装应用', ready: '应用安装包已就绪',
};
const formatBytes = value => {
  if (!Number.isFinite(value) || value < 0) return '';
  const index = Math.min(3, Math.floor(Math.log2(Math.max(1, value)) / 10));
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${['B', 'KB', 'MB', 'GB'][index]}`;
};

/** Only real downloaded bytes or the Desktop's public percentage advance this indicator. */
function UpdateProgress({ phase, progress, native = false, observedAt }) {
  const [now, setNow] = useState(() => Date.now());
  const stage = native ? phase : progress?.stage || 'downloading';
  const firstSeen = useRef(Date.now());
  useEffect(() => {
    firstSeen.current = Date.now(); setNow(Date.now());
    if (stage === 'ready') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stage]);
  const total = !native && Number.isFinite(progress?.total) && progress.total > 0 ? progress.total : null;
  const transferred = !native && Number.isFinite(progress?.transferred) && progress.transferred >= 0 ? progress.transferred : null;
  const rawPercent = native ? progress?.percent : total !== null && transferred !== null ? transferred / total * 100 : null;
  const percent = Number.isFinite(rawPercent) ? Math.max(0, Math.min(100, rawPercent)) : null;
  const lastData = native ? observedAt : Date.parse(progress?.updatedAt);
  const stale = stage === 'downloading' && now - (Number.isFinite(lastData) ? lastData : firstSeen.current) >= 30_000;
  const speed = !native && !stale && Number.isFinite(progress?.bytesPerSecond) && progress.bytesPerSecond > 0 ? progress.bytesPerSecond : null;
  const title = stage === 'downloading' ? `正在下载${native ? '应用' : '功能包'}` : progressStages[stage] || '正在准备更新';
  return <div className="cmd-update-progress" data-stage={stage} data-stalled={stale}>
    <div className="cmd-update-progress-heading"><span role="status">{title}</span>{stage === 'downloading' && percent !== null && <strong>{Math.floor(percent)}%</strong>}</div>
    {stage === 'downloading' && <div className="cmd-update-progress-track" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === null ? undefined : Math.floor(percent)} aria-valuetext={percent === null ? '等待下载进度' : `${Math.floor(percent)}%`}>
      {percent !== null && <span style={{ transform: `scaleX(${percent / 100})` }} />}
    </div>}
    <p className="cmd-update-progress-detail">{stage === 'downloading'
      ? <>{transferred !== null && total !== null ? `${formatBytes(transferred)} / ${formatBytes(total)}` : percent === null ? '正在连接下载源，等待下载数据…' : '安装包正在后台下载'}{speed !== null && <> · {formatBytes(speed)}/s</>}</>
      : stage === 'ready' ? '等待在应用更新窗口确认安装。'
        : stage === 'installing' ? '正在结束任务并安全关闭主机，完成后启动安装器。'
          : '下载已完成，正在本机处理，请稍候。'}</p>
    {stale && <p className="cmd-update-progress-stalled" role="status">30 秒未收到新的下载进度，可能是网络较慢或连接停滞。可继续等待；若持续不变，请在更新窗口重试。</p>}
  </div>;
}

/** A deliberate press; the CSS fill and the command share the same duration. */
function HoldToUpdate({ disabled, onComplete, label = '长按 2 秒更新' }) {
  const [holding, setHolding] = useState(false), press = useRef(null), current = useRef({ disabled, onComplete });
  current.current = { disabled, onComplete };
  const cancel = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null; setHolding(false);
  }, []);
  useEffect(() => { if (disabled) cancel(); }, [disabled, cancel]);
  useEffect(() => {
    const release = event => { if (press.current?.pointerId === event.pointerId) cancel(); };
    const hide = () => { if (document.visibilityState === 'hidden') cancel(); };
    window.addEventListener('pointerup', release); window.addEventListener('pointercancel', release);
    window.addEventListener('blur', cancel); document.addEventListener('visibilitychange', hide);
    return () => {
      if (press.current) clearTimeout(press.current.timer);
      press.current = null;
      window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', cancel); document.removeEventListener('visibilitychange', hide);
    };
  }, [cancel]);
  const start = (node, identity) => {
    if (current.current.disabled || press.current || document.visibilityState === 'hidden') return;
    const session = { ...identity, node };
    press.current = session; setHolding(true);
    session.timer = setTimeout(() => {
      if (press.current !== session) return;
      press.current = null; setHolding(false);
      if (!current.current.disabled && node.isConnected && document.visibilityState !== 'hidden') void current.current.onComplete();
    }, 2000);
  };
  return <button type="button" className="cmd-update-button cmd-update-primary cmd-update-hold" aria-label={label} data-holding={holding} disabled={disabled}
    onPointerDown={event => { if (event.button === 0 && event.isPrimary !== false) start(event.currentTarget, { pointerId: event.pointerId }); }}
    onPointerMove={event => {
      if (press.current?.pointerId !== event.pointerId) return;
      // Touch pointers implicitly capture the button, so pointerleave alone is insufficient.
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) cancel();
    }}
    onPointerLeave={event => { if (press.current?.pointerId === event.pointerId) cancel(); }}
    onPointerUp={event => { if (press.current?.pointerId === event.pointerId) cancel(); }}
    onPointerCancel={event => { if (press.current?.pointerId === event.pointerId) cancel(); }}
    onLostPointerCapture={event => { if (press.current?.pointerId === event.pointerId) cancel(); }}
    onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); if (!event.repeat) start(event.currentTarget, { key: event.key }); } }}
    onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); if (press.current?.key === event.key) cancel(); } }}
    onBlur={cancel} onContextMenu={event => event.preventDefault()} onClick={event => event.preventDefault()}>
    <span className="cmd-update-hold-fill" aria-hidden="true" /><span className="cmd-update-hold-label"><UIIcon name="refresh" size={16} />{holding ? '松开取消' : label}</span>
  </button>;
}

// Old hosts do not yet return a decision. Keep their public status contract usable
// during the first feature update; current hosts remain the authority.
function hostDecision(data) {
  if (data?.decision) return data.decision;
  const plugin = data?.release?.plugin, app = data?.release?.app;
  const pluginAvailable = !!data?.current?.plugin && plugin?.available === true;
  const appAvailable = data?.installation !== 'server' && !!data?.current?.app && app?.available === true;
  const decide = (action, available, enabled, reason = '') => ({ action, available, enabled, reason });
  if (data?.restartRequired || data?.phase === 'ready') return decide('restart', true, !data.busy);
  if (activePhases.has(data?.phase)) return decide('check', pluginAvailable || appAvailable, false);
  if (data?.phase === 'error' && data.lastAction !== 'install') return decide('check', false, true, '暂时无法检查更新');
  if (!data?.release) return decide('check', false, true);
  if (pluginAvailable && data.installation === 'server' && !data.managed) return decide('deployment', true, false, '此主机由服务器部署管理，请由维护者更新');
  if (pluginAvailable && (!plugin.compatible || !data.managed)) return appAvailable
    ? decide('app', true, !data.busy, plugin.reason || '此更新需要新版主机应用')
    : decide('blocked', true, false, plugin.reason || '当前安装方式不支持独立更新，请先安装支持更新的新版应用');
  if (pluginAvailable) return decide('plugin', true, !!data.canInstall && !data.busy, data.busy ? '有任务正在运行，结束后即可更新。' : data.installBlockReason || (!data.canInstall ? '更新状态尚未就绪，请重新检查。' : ''));
  if (appAvailable) return decide('app', true, !data.busy);
  return decide('current', false, false);
}

export function mountUpdatesStyle(ctx) {
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  ctx.effect(() => () => style.remove());
}

function DeviceDownloads({ active }) {
  const id = useId();
  const [files, setFiles] = useState(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const url = new URL(updatePath, document.baseURI);
    setError(false);
    void (async () => {
      try {
        const response = await fetch(url, {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'downloads' }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
        });
        const catalog = await readJsonResponse(response, url);
        if (!Array.isArray(catalog.files)) throw new Error('下载目录不可用');
        if (!controller.signal.aborted) setFiles(catalog.files);
      } catch { if (!controller.signal.aborted) setError(true); }
    })();
    return () => controller.abort();
  }, [active, attempt]);

  const available = files && downloadPlatforms.flatMap(({ name, icon, packages }) => {
    const links = packages.flatMap(([target, suffix, label]) => {
      const file = files.find(item => item?.target === target && typeof item.url === 'string' && item.url.endsWith(suffix));
      return file ? [{ ...file, label }] : [];
    });
    return links.length ? [{ name, icon, links }] : [];
  });
  return <section className="cmd-download-platforms" aria-labelledby={id}>
    <div className="cmd-download-heading">
      <h3 id={id}>其他设备下载</h3>
      <a className="cmd-download-website" href="https://benchgo.cn/" target="_blank" rel="noopener noreferrer">访问官网<UIIcon name="external" size={14} /></a>
    </div>
    {!!available?.length && <ul className="cmd-download-list">
      {available.map(({ name, icon, links }) => <li key={name}>
          <span className="cmd-download-platform"><UIIcon name={icon} size={18} />{name}</span>
          <span className="cmd-download-links">{links.map(file => <a key={file.target} href={file.url} target="_blank" rel="noopener noreferrer" aria-label={`下载 ${name} ${file.label} v${file.version}`}>
            {file.label}<small>v{file.version}</small><IconDownloadOutlineMedium size={14} aria-hidden="true" />
          </a>)}</span>
        </li>)}
    </ul>}
    {!files && !error && <p className="cmd-download-message" role="status">正在读取下载列表…</p>}
    {available?.length === 0 && !error && <p className="cmd-download-message" role="status">暂无可下载的安装包</p>}
    {error && <div className="cmd-download-message" role="status">
      <span>{files ? '暂时无法刷新下载列表' : '暂时无法读取下载列表'}</span>
      <button type="button" className="cmd-update-text-button" onClick={() => setAttempt(value => value + 1)}>重试下载列表</button>
    </div>}
    <p className="cmd-download-message">iPhone 和 iPad 可通过 Safari 配对使用。</p>
  </section>;
}

/** A host update changes the connected computer; it never updates a mobile APK. */
export function UpdateLauncher({ host, wide = true }) {
  const [open, setOpen] = useState(false), [data, setData] = useState(null), [error, setError] = useState(''), [pending, setPending] = useState('');
  const [nativeState, setNativeState] = useState(null), [nativeError, setNativeError] = useState('');
  const [source, setSource] = useState('mirror'), [mirrorUrl, setMirrorUrl] = useState('');
  const mounted = useRef(false), flight = useRef(null), controllers = useRef(new Set()), retryAction = useRef({ action: 'check' }), nativeRevision = useRef(0), id = useId();
  // Only the Desktop-owned local document can update this machine. A bridge
  // carried into a remote page must never be used to update a different host.
  const localDesktop = globalThis.location?.protocol === 'dsh-app:' && globalThis.location?.hostname === 'app';
  const desktopUpdates = localDesktop ? globalThis.dshDesktop?.updates : null;
  const canOpenAppUpdates = typeof desktopUpdates?.open === 'function';
  const canAutoUpdate = data?.installation !== 'server' && typeof desktopUpdates?.apply === 'function' && typeof desktopUpdates?.restart === 'function';
  const [updatingAll, setUpdatingAll] = useState(false), [restarting, setRestarting] = useState(false);
  const intent = useRef(undefined), continuation = useRef(false), restartAttempted = useRef(false);
  if (intent.current === undefined) intent.current = localDesktop ? readUpdateIntent() : null;
  const saveIntent = value => {
    intent.current = value;
    try { if (value) globalThis.localStorage?.setItem(updateIntentKey, JSON.stringify(value)); else globalThis.localStorage?.removeItem(updateIntentKey); } catch { /* The current window can still finish if storage is unavailable. */ }
  };
  const run = useCallback(async (action, args = {}) => {
    // A read must never lock a visible action or replace a newer command's response.
    if (flight.current) {
      if (action === 'status' || flight.current.action !== 'status') return null;
      flight.current.abort();
    }
    const controller = new AbortController(); controller.action = action;
    controllers.current.add(controller); flight.current = controller;
    if (mounted.current && action !== 'status') { setPending(action); setError(''); }
    try {
      const url = new URL(updatePath, document.baseURI);
      const response = await fetch(url, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...args }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
      });
      const value = await readJsonResponse(response, url);
      if (mounted.current && !controller.signal.aborted) {
        setData(value);
        if (value.config) { setSource(value.config.source); setMirrorUrl(value.config.mirrorUrl || ''); }
      }
      return controller.signal.aborted ? null : value;
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) {
        retryAction.current = { action, args };
        const message = failure.code === 'HTTP_ERROR' ? failure.message.replace(/^请求失败：?/, '').replace(/（HTTP \d+ · [^）]*）$/, '').trim() || `请求失败（HTTP ${failure.status}）` : failure.message;
        setError(failure.name === 'TimeoutError' ? '更新请求超时，请重试。' : message);
      }
      return null;
    } finally {
      controllers.current.delete(controller);
      if (flight.current === controller) { flight.current = null; if (mounted.current && action !== 'status') setPending(''); }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void (async () => { const current = await run('status'); if (mounted.current && current && !current.restartRequired && !activePhases.has(current.phase)) await run('check'); })();
    const show = () => setOpen(true); document.addEventListener('commander:updates', show);
    return () => { mounted.current = false; for (const controller of controllers.current) controller.abort(); flight.current = null; document.removeEventListener('commander:updates', show); };
  }, [run]);
  useEffect(() => { if (open) void run('status'); }, [open, run]);
  const refreshNativeState = useCallback(async () => {
    const revision = ++nativeRevision.current;
    try {
      const value = await desktopUpdates.status?.();
      if (mounted.current && value && revision === nativeRevision.current) { setNativeState(previous => ({ ...value, observedAt: previous?.phase === value.phase && previous?.percent === value.percent && previous?.version === value.version ? previous.observedAt : Date.now() })); setNativeError(''); }
    } catch {
      if (mounted.current && revision === nativeRevision.current) setNativeError('应用更新状态暂时不可用，请重新检查。');
    }
  }, [desktopUpdates]);
  useEffect(() => {
    if (!canOpenAppUpdates) return;
    let active = true;
    const apply = value => { if (active && value) { nativeRevision.current++; setNativeState(previous => ({ ...value, observedAt: previous?.phase === value.phase && previous?.percent === value.percent && previous?.version === value.version ? previous.observedAt : Date.now() })); setNativeError(''); } };
    let unsubscribe;
    try {
      unsubscribe = desktopUpdates.subscribe?.(apply);
      void refreshNativeState();
    } catch { setNativeError('应用更新状态暂时不可用，请重新检查。'); }
    return () => { active = false; nativeRevision.current++; unsubscribe?.(); };
  }, [desktopUpdates, canOpenAppUpdates, refreshNativeState]);
  useEffect(() => {
    const awaitingInstall = open && data?.release?.plugin?.compatible && data.release.plugin.available === true && data?.managed && !data?.canInstall && !data?.restartRequired;
    if ((!activePhases.has(data?.phase) && !awaitingInstall && !(canAutoUpdate && data?.restartRequired && data?.busy) && !intent.current) || error) return;
    const timer = setInterval(() => void run('status'), 2000); return () => clearInterval(timer);
  }, [data?.phase, data?.canInstall, data?.managed, data?.release?.plugin?.version, data?.release?.plugin?.available, data?.release?.plugin?.compatible, data?.current?.plugin, data?.restartRequired, data?.busy, canAutoUpdate, open, error, run]);
  const working = updatingAll || restarting || !!pending || activePhases.has(data?.phase) || nativeActivePhases.has(nativeState?.phase), restart = !!data?.restartRequired || data?.phase === 'ready';
  const unpublished = data?.phase === 'unpublished', serverDeployment = data?.installation === 'server', serverManaged = serverDeployment && data?.managed === false;
  // The host owns semantic version comparisons; a different/unknown version is
  // never enough to advertise an update (mobile reads this same host state).
  const plugin = data?.release?.plugin, pluginAvailable = !!data?.current?.plugin && plugin?.available === true && !restart;
  const app = data?.release?.app, appAvailable = !serverDeployment && !!data?.current?.app && app?.available === true;
  const decision = hostDecision(data);
  const nativeAvailable = canOpenAppUpdates && !serverDeployment && ['available', 'ready', 'downloading', 'verifying', 'installing'].includes(nativeState?.phase);
  const appTargetVersion = appAvailable ? app.version : nativeAvailable ? nativeState.version : null;
  const useNativeApp = nativeAvailable && !restart && ['check', 'current', 'app'].includes(decision.action);
  const action = useNativeApp ? 'app' : decision.action;
  const updateAvailable = decision.available || nativeAvailable;
  const appOnHost = action === 'app' && !canOpenAppUpdates;
  const installBlockReason = appOnHost ? '请在当前连接主机上打开 BenchGo，完成应用更新。' : decision.reason || '';
  const enabled = useNativeApp ? !data?.busy : decision.enabled;
  const actionable = ['plugin', 'app'].includes(action);
  const preparing = ['verifying', 'extracting', 'activating'].includes(data?.progress?.stage) && data?.phase === 'downloading' || ['verifying', 'installing'].includes(nativeState?.phase);
  const targetVersion = data?.release?.releaseVersion;
  const sameRelease = !!targetVersion && targetVersion === data?.current?.release;
  const nativeStopFailed = !serverDeployment && !nativeError && nativeState?.phase === 'error' && nativeState.failure === 'stop-failed';
  const appUpdateFailed = nativeStopFailed && (action === 'app' || !updateAvailable);
  const status = restarting ? '正在重启' : updatingAll ? '更新中' : restart ? canAutoUpdate && data?.busy ? '等待任务结束' : '待重启' : working ? (preparing ? '准备中' : data?.phase === 'downloading' || pending === 'install' || nativeState?.phase === 'downloading' ? '下载中' : pending === 'app' ? '更新中' : '检查中') : updateAvailable ? '有更新' : '';
  const pluginStatus = restarting ? '正在重启主机应用…' : updatingAll ? '正在完成更新…' : restart ? canAutoUpdate && data?.busy ? '等待任务结束后自动重启' : '待重启' : working ? (preparing ? '正在准备更新…' : data?.phase === 'downloading' || pending === 'install' || nativeState?.phase === 'downloading' ? '正在下载…' : pending === 'app' ? '更新中…' : '正在检查…')
    : error ? (['install', 'app'].includes(retryAction.current.action) ? '更新未完成' : '暂时无法检查更新')
      : appUpdateFailed ? '应用更新未完成'
      : !data ? '尚未读取更新信息' : unpublished ? data.notice || '更新通道尚未就绪'
      : data.phase === 'error' ? (data.lastAction === 'install' ? '更新未完成' : '暂时无法检查更新') : !data.current?.plugin ? '暂无法识别插件版本'
        : updateAvailable ? canAutoUpdate ? '发现新版本' : action === 'app' ? '主机应用有更新' : sameRelease ? action === 'plugin' ? '功能包有更新' : '有可用更新' : '发现新版本'
          : !plugin ? '尚未检查更新' : action === 'blocked' ? '暂无法确认更新状态' : '已是最新版本';
  const configure = async (nextSource, nextMirror = mirrorUrl) => {
    if (nextSource === 'custom' && !httpsUrl(nextMirror)) { setError('请输入有效的 HTTPS 镜像地址。'); return; }
    const saved = await run('configure', { source: nextSource, mirrorUrl: nextMirror.trim() });
    if (saved && !saved.restartRequired) await run('check');
  };
  const openAppUpdates = async ({ allowStaged = false } = {}) => {
    if (!canOpenAppUpdates || data?.installation === 'server' || (flight.current && flight.current.action !== 'status') || data?.busy || restart && !allowStaged) return;
    flight.current?.abort();
    const operation = { action: 'app' }; flight.current = operation; setPending('app'); setError(''); setNativeError('');
    try { await desktopUpdates.open(); if (mounted.current) await refreshNativeState(); }
    catch (failure) { if (mounted.current) { retryAction.current = { action: 'app' }; setError(failure?.message || '无法打开应用更新，请重试。'); } }
    finally { if (flight.current === operation) { flight.current = null; if (mounted.current) setPending(''); } }
  };
  const check = () => run('check');
  const finishUpdate = async (current = data) => {
    if (!canAutoUpdate || flight.current || updatingAll || restarting || current?.busy || current?.installation === 'server') return;
    restartAttempted.current = true;
    setUpdatingAll(true); setError('');
    try {
      const result = await desktopUpdates.apply();
      if (!mounted.current) return;
      if (result?.phase === 'error') throw new Error(nativeFailureMessages[result.failure] || '主机应用更新未完成，请重试。');
      if (result?.phase === 'installing') { setRestarting(true); return; }
      if (result?.phase !== 'idle') throw new Error('主机应用更新尚未完成，请重试。');
      if (current?.release?.app?.available) throw new Error('应用更新通道暂未提供本次版本，请稍后重试。');
      if (current?.restartRequired || current?.phase === 'ready') {
        setRestarting(true);
        const restarted = await desktopUpdates.restart();
        if (restarted?.phase === 'error') throw new Error(nativeFailureMessages[restarted.failure] || '主机应用未能安全重启，请重试。');
      } else saveIntent(null);
    } catch (failure) {
      if (mounted.current) {
        setRestarting(false); saveIntent(null);
        retryAction.current = { action: 'all' };
        setError(failure?.message || '更新未完成，请重试。');
      }
    } finally { if (mounted.current) setUpdatingAll(false); }
  };
  const updateAll = async () => {
    if (!canAutoUpdate || working || data?.busy) return;
    saveIntent({ plugin: plugin?.version || data?.current?.plugin || '', app: appAvailable ? app.version : '', createdAt: Date.now() });
    restartAttempted.current = false;
    if (action === 'plugin' && !restart) {
      const current = await run('install');
      if (!current || current.phase === 'error') saveIntent(null);
    } else await finishUpdate();
  };
  // Preparation continues while the panel is closed. A staged package is never
  // reinstalled, and the native bridge rechecks tasks under admission lock.
  useEffect(() => {
    if (!canAutoUpdate || !restart || data?.busy || working || error || restartAttempted.current) return;
    void finishUpdate();
  }, [canAutoUpdate, restart, data?.busy, working, error]);
  useEffect(() => { if (error || data?.phase === 'error') saveIntent(null); }, [error, data?.phase]);
  useEffect(() => {
    if (canAutoUpdate || !canOpenAppUpdates || !restart || !appAvailable || data?.busy || working || error || restartAttempted.current) return;
    restartAttempted.current = true;
    void openAppUpdates({ allowStaged: true });
  }, [canAutoUpdate, canOpenAppUpdates, restart, appAvailable, data?.busy, working, error]);
  // An application/engine upgrade may have to precede the feature package.
  // Resume only the same signed target that this user already authorized.
  useEffect(() => {
    const goal = intent.current;
    if (!canAutoUpdate || !goal || continuation.current || restart || working || error || !data?.checkedAt || data.phase !== 'idle') return;
    if (pluginAvailable && plugin.version !== goal.plugin || appAvailable && app.version !== goal.app) { saveIntent(null); return; }
    if (!pluginAvailable && !appAvailable) { saveIntent(null); return; }
    if (data.busy || !enabled) return;
    continuation.current = true;
    void (async () => {
      try {
        if (action === 'plugin') {
          const current = await run('install');
          if (!current || current.phase === 'error') saveIntent(null);
        } else await finishUpdate();
      } finally { continuation.current = false; }
    })();
  }, [canAutoUpdate, restart, working, error, data, action, enabled]);
  const primary = async () => {
    if (canAutoUpdate && actionable) return updateAll();
    if (action === 'plugin') {
      const current = await run('install');
      return current;
    }
    return action === 'app' ? openAppUpdates() : check();
  };
  const retry = () => {
    const { action, args } = error ? retryAction.current : { action: data?.lastAction === 'install' ? 'install' : 'check' };
    if (action === 'status') setError('');
    return action === 'all' ? updateAll() : action === 'app' ? canAutoUpdate ? updateAll() : openAppUpdates() : action === 'check' ? check() : canAutoUpdate && action === 'install' ? updateAll() : run(action, args);
  };
  const close = () => setOpen(false);
  const holdKey = `${action}:${plugin?.version || ''}:${app?.version || nativeState?.version || ''}:${source}:${mirrorUrl}`;
  const retryInstall = ['install', 'all'].includes(error ? retryAction.current.action : data?.lastAction);
  const nativeFailureMessage = !serverDeployment && (nativeError || (nativeState?.phase === 'error' ? nativeFailureMessages[nativeState.failure] || '应用更新未完成，请重新检查。' : ''));
  // Native shutdown failures already have an owned error window. Retain their
  // full diagnostic in details while the main card keeps one recovery action.
  // A staged feature package must take effect before another update operation.
  const nativeFailureInDetails = restart || nativeStopFailed;
  const nativeFailure = nativeFailureMessage && <div className="cmd-update-error" role="alert"><span>{nativeFailureMessage}</span>{!restart && <button type="button" className="cmd-update-text-button" disabled={working || !!data?.busy} onClick={() => void openAppUpdates()}>重试应用更新</button>}</div>;
  return <>
    <Tooltip label={status ? `下载 · ${status}` : '下载'} side="top" gap={10} delayMs={450} portal>
      <button type="button" className={`cmd-update-launcher ${wide ? '' : 'cmd-update-launcher-rail'}`} data-update-available={updateAvailable || restart} aria-label={status ? `下载，${status}` : '下载'} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <UIIcon name="computer" size={16} />
        {updateAvailable && !restart && <span className="cmd-update-dot" aria-hidden="true" />}
        {wide && <><span>下载</span>{status && <small data-ready={restart}>{status}</small>}</>}
      </button>
    </Tooltip>
    <Modal open={open} headless onClose={close} title="下载" className="cmd-update-dialog">
      <header className="cmd-update-header"><h2>下载</h2><button type="button" className="cmd-update-icon-button" aria-label="关闭下载" onClick={close}><UIIcon name="close" size={16} /></button></header>
      <div className="cmd-update-content">
        <section className="cmd-update-plugin" aria-labelledby={`${id}-plugin`}>
          <Dialog.Root modal={false}>
            <div className="cmd-update-card-heading"><span className="cmd-update-plugin-mark"><img src={brandIcon} width="38" height="38" alt="" /></span><div><h3 id={`${id}-plugin`}>BenchGo</h3>{data && <p role="status">{data.current?.release && <>{`v${data.current.release}`}{targetVersion && !sameRelease && updateAvailable && !restart && <><span aria-hidden="true"> → </span><strong>v{targetVersion}</strong></>}<span aria-hidden="true"> · </span></>}{pluginStatus}</p>}</div>{data && <BubbleTooltip label="版本详情"><Dialog.Trigger asChild><button type="button" className="cmd-update-icon-button cmd-update-info" aria-label="版本详情"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></svg></button></Dialog.Trigger></BubbleTooltip>}</div>
            <Dialog.Content className="cmd-update-details" aria-label="版本详情" aria-describedby={undefined} onEscapeKeyDown={event => event.stopPropagation()}>
              <div className="cmd-update-details-heading"><Dialog.Title>版本详情</Dialog.Title><Dialog.Close asChild><button type="button" className="cmd-update-icon-button" aria-label="关闭版本详情"><UIIcon name="close" size={14} /></button></Dialog.Close></div>
              <dl><div><dt>当前主机</dt><dd>{localDesktop ? '本机' : globalThis.location?.hostname || '本机'}</dd></div><div><dt>功能包</dt><dd>{data?.current?.plugin ? `v${data.current.plugin}` : '版本未知'}{pluginAvailable && ` → v${plugin.version}`}</dd></div>{!serverDeployment && <div><dt>主机应用</dt><dd>{data?.current?.app ? `v${data.current.app}` : '版本未知'}{appTargetVersion && appTargetVersion !== data?.current?.app && ` → v${appTargetVersion}`}</dd></div>}<div><dt>引擎</dt><dd>{data?.current?.engine || '版本未知'}</dd></div></dl>
              {data?.release?.notes && <div className="cmd-update-notes"><strong>更新内容</strong><p>{data.release.notes}</p></div>}
              {nativeFailureInDetails && nativeFailure && <><p className="cmd-update-warning">应用更新尚未完成</p>{nativeFailure}{restart && !canAutoUpdate && <p className="cmd-update-warning">请先重启主机应用，使功能包生效，再重试应用更新。</p>}</>}
            </Dialog.Content>
          </Dialog.Root>
          {!data && !error ? <Loading label="正在读取更新信息" compact /> : restart ? <div className="cmd-update-notice" role="status"><UIIcon name="check" size={16} /><span>{canAutoUpdate ? restarting ? '正在重启主机应用，更新后自动返回工作台' : updatingAll ? '功能包已就绪，正在完成主机应用更新' : data?.busy ? '功能包已就绪，任务结束后自动完成更新并重启' : error ? '功能包已就绪，更新尚未完成，请重试' : '功能包已就绪，即将自动完成更新并重启' : <>功能包已就绪，重启主机{serverDeployment ? '服务' : '应用'}后生效{data?.busy && '，请先结束运行中的任务'}</>}</span></div> : <>
            {(installBlockReason && (updateAvailable || action === 'blocked' || action === 'deployment')) && <p className="cmd-update-warning" role="status">{installBlockReason}</p>}
            {data?.managed === false && !updateAvailable && <p className="cmd-update-warning">{serverManaged ? '此主机由服务器部署管理' : '当前安装方式需要新版应用才能启用功能包更新。'}</p>}
            <div className="cmd-update-actions"><BubbleTooltip label={actionable && (!enabled || appOnHost) ? installBlockReason || '当前暂不能更新' : undefined} portal><span className="cmd-update-action" tabIndex={actionable && (!enabled || appOnHost) ? 0 : undefined}>{actionable ? <HoldToUpdate key={holdKey} label={appUpdateFailed && enabled && !appOnHost ? '长按 2 秒重试' : undefined} disabled={!open || working || !enabled || appOnHost} onComplete={primary} /> : <button type="button" className="cmd-update-button cmd-update-check" disabled={working} onClick={() => void primary()}>{preparing ? '准备中…' : pending === 'install' || data?.phase === 'downloading' || nativeState?.phase === 'downloading' ? '下载中…' : pending === 'app' ? '更新中…' : working ? '检查中…' : '检查更新'}</button>}</span></BubbleTooltip>{updateAvailable && <button type="button" className="cmd-update-icon-button" aria-label="重新检查" disabled={working} onClick={() => void check()}><UIIcon name="refresh" size={16} /></button>}</div>
          </>}
        {open && (!restart || canAutoUpdate) && (data?.phase === 'downloading'
          ? <UpdateProgress phase={data.phase} progress={data.progress} />
          : !serverDeployment && ['downloading', 'verifying', 'installing', 'ready'].includes(nativeState?.phase)
            ? <UpdateProgress native phase={nativeState.phase} progress={nativeState} observedAt={nativeState.observedAt} /> : null)}
        {!nativeFailureInDetails && nativeFailure}
        {(error || (!unpublished && data?.error)) && <div className="cmd-update-error" role="alert"><span>{error || data.error}</span>{retryInstall ? <HoldToUpdate key={`retry:${holdKey}`} label="长按 2 秒重试" disabled={!open || working || !!data?.busy} onComplete={retry} /> : <button type="button" className="cmd-update-text-button" disabled={!!pending || (working && retryAction.current.action !== 'status')} onClick={() => void retry()}>重试</button>}</div>}
        <section className="cmd-update-source" aria-labelledby={`${id}-source`}>
          <div className="cmd-update-source-row"><label htmlFor={`${id}-source-select`} id={`${id}-source`}><LinkIconMedium kind="url" href="https://github.com" size={16} />更新来源</label><Select id={`${id}-source-select`} value={source} disabled={working || restart} onChange={event => { const value = event.target.value; setSource(value); setError(''); if (value !== 'custom') void configure(value); }}>{Object.entries(sourceNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></div>
          {source === 'custom' && <form className="cmd-update-custom" onSubmit={event => { event.preventDefault(); void configure('custom', event.currentTarget.elements.namedItem('mirrorUrl').value); }}><input name="mirrorUrl" type="url" required aria-label="自定义 HTTPS 镜像地址" placeholder="https://mirror.example.com/" value={mirrorUrl} disabled={working || restart} onChange={event => setMirrorUrl(event.target.value)} /><button type="submit" className="cmd-update-button" disabled={working || restart}>保存</button></form>}
        </section>
        </section>
        <DeviceDownloads active={open} />
      </div>
    </Modal>
  </>;
}
