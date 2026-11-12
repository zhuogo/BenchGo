import { Disclosure } from '../../shared/client/ui/collapsible.jsx';
import { Select } from '../../shared/client/select.jsx';
import { readJsonResponse } from './http-response.mjs';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { LinkIconMedium, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { Tooltip as BubbleTooltip } from '../../shared/client/ui/tooltip.jsx';
import { UIIcon } from './iconsax.jsx';
import css from './updates.css';
import { brandIcon } from '../../link/client/brand.jsx';
import { Loading } from '../../shared/client/ui/loading.jsx';

const activePhases = new Set(['checking', 'downloading']);
const sourceNames = { mirror: '国内加速', github: 'GitHub 直连', custom: '自定义镜像' };
const httpsUrl = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; } };
const nativeActivePhases = new Set(['checking', 'downloading', 'verifying', 'installing']);

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
  if (data?.phase === 'error' && !['install', 'rollback'].includes(data.lastAction)) return decide('check', false, true, '暂时无法检查更新');
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

/** A host update changes the connected computer; it never updates a mobile APK. */
export function UpdateLauncher({ host, wide = true }) {
  const [open, setOpen] = useState(false), [data, setData] = useState(null), [error, setError] = useState(''), [pending, setPending] = useState('');
  const [nativeState, setNativeState] = useState(null), [nativeError, setNativeError] = useState('');
  const [source, setSource] = useState('mirror'), [mirrorUrl, setMirrorUrl] = useState('');
  const mounted = useRef(false), flight = useRef(null), controllers = useRef(new Set()), retryAction = useRef({ action: 'check' }), id = useId();
  // Only the Desktop-owned local document can update this machine. A bridge
  // carried into a remote page must never be used to update a different host.
  const localDesktop = globalThis.location?.protocol === 'dsh-app:' && globalThis.location?.hostname === 'app';
  const desktopUpdates = localDesktop ? globalThis.dshDesktop?.updates : null;
  const canOpenAppUpdates = typeof desktopUpdates?.open === 'function';
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
      const response = await fetch(new URL('api/commander/updates', document.baseURI), {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...args }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
      });
      const value = await readJsonResponse(response, new URL('api/commander/updates', document.baseURI));
      if (mounted.current && !controller.signal.aborted) {
        setData(value);
        if (value.config) { setSource(value.config.source); setMirrorUrl(value.config.mirrorUrl || ''); }
      }
      return controller.signal.aborted ? null : value;
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) { retryAction.current = { action, args }; setError(failure.name === 'TimeoutError' ? '更新请求超时，请重试。' : failure.message); }
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
  useEffect(() => {
    if (!canOpenAppUpdates) return;
    let active = true, revision = 0;
    const apply = value => { if (active) { revision++; setNativeState(value); setNativeError(''); } };
    let unsubscribe;
    try {
      unsubscribe = desktopUpdates.subscribe?.(apply);
      const start = revision;
      Promise.resolve(desktopUpdates.status?.()).then(value => { if (active && value && revision === start) apply(value); }).catch(() => { if (active) setNativeError('应用更新状态暂时不可用，请重新检查。'); });
    } catch { setNativeError('应用更新状态暂时不可用，请重新检查。'); }
    return () => { active = false; unsubscribe?.(); };
  }, [desktopUpdates, canOpenAppUpdates]);
  useEffect(() => {
    const awaitingInstall = open && data?.release?.plugin?.compatible && data.release.plugin.available === true && data?.managed && !data?.canInstall && !data?.restartRequired;
    if ((!activePhases.has(data?.phase) && !awaitingInstall) || error) return;
    const timer = setInterval(() => void run('status'), 2000); return () => clearInterval(timer);
  }, [data?.phase, data?.canInstall, data?.managed, data?.release?.plugin?.version, data?.release?.plugin?.available, data?.release?.plugin?.compatible, data?.current?.plugin, data?.restartRequired, open, error, run]);
  const working = !!pending || activePhases.has(data?.phase) || nativeActivePhases.has(nativeState?.phase), restart = !!data?.restartRequired || data?.phase === 'ready';
  const unpublished = data?.phase === 'unpublished', serverDeployment = data?.installation === 'server', serverManaged = serverDeployment && data?.managed === false;
  // The host owns semantic version comparisons; a different/unknown version is
  // never enough to advertise an update (mobile reads this same host state).
  const plugin = data?.release?.plugin, pluginAvailable = !!data?.current?.plugin && plugin?.available === true && !restart;
  const app = data?.release?.app, appAvailable = !serverDeployment && !!data?.current?.app && app?.available === true;
  const decision = hostDecision(data);
  const nativeAvailable = canOpenAppUpdates && !serverDeployment && ['available', 'ready', 'downloading', 'verifying', 'installing'].includes(nativeState?.phase);
  const useNativeApp = nativeAvailable && !restart && ['check', 'current', 'app'].includes(decision.action);
  const action = useNativeApp ? 'app' : decision.action;
  const updateAvailable = decision.available || nativeAvailable;
  const appOnHost = action === 'app' && !canOpenAppUpdates;
  const installBlockReason = appOnHost ? '请在当前连接主机上打开 BenchGo，完成应用更新。' : decision.reason || '';
  const enabled = useNativeApp ? !data?.busy : decision.enabled;
  const actionable = ['plugin', 'app'].includes(action);
  const status = restart ? '待重启' : working ? (data?.phase === 'downloading' || pending === 'install' || ['downloading', 'verifying'].includes(nativeState?.phase) ? '下载中' : pending === 'app' ? '更新中' : '检查中') : updateAvailable ? '有更新' : '';
  const pluginStatus = working ? (data?.phase === 'downloading' || pending === 'install' ? '正在下载并校验…' : pending === 'app' ? '正在处理应用更新…' : '正在检查…')
    : !data ? '尚未读取更新信息' : unpublished ? data.notice || '更新通道尚未就绪'
      : data.phase === 'error' ? '暂时无法检查更新' : !data.current?.plugin ? '暂无法识别插件版本'
        : updateAvailable ? '发现新版本' : !plugin ? '尚未检查更新' : action === 'blocked' ? '暂无法确认更新状态' : '已安装当前发布的功能';
  const targetVersion = data?.release?.releaseVersion;
  const description = action === 'app' ? appOnHost ? '此次更新需要升级连接主机的应用，请到主机上完成。' : '此次更新包含应用能力，系统将接续应用更新流程。'
    : action === 'plugin' ? '此次更新可直接下载功能包，准备完成后重启主机生效。'
      : '系统自动检查所需组件，只下载需要更新的内容。';
  const configure = async (nextSource, nextMirror = mirrorUrl) => {
    if (nextSource === 'custom' && !httpsUrl(nextMirror)) { setError('请输入有效的 HTTPS 镜像地址。'); return; }
    const saved = await run('configure', { source: nextSource, mirrorUrl: nextMirror.trim() });
    if (saved && !saved.restartRequired) await run('check');
  };
  const openAppUpdates = async () => {
    if (!canOpenAppUpdates || data?.installation === 'server' || (flight.current && flight.current.action !== 'status') || data?.busy || restart) return;
    flight.current?.abort();
    const operation = { action: 'app' }; flight.current = operation; setPending('app'); setError(''); setNativeError('');
    try { await desktopUpdates.open(); if (mounted.current && desktopUpdates.status) setNativeState(await desktopUpdates.status()); }
    catch (failure) { if (mounted.current) { retryAction.current = { action: 'app' }; setError(failure?.message || '无法打开应用更新，请重试。'); } }
    finally { if (flight.current === operation) { flight.current = null; if (mounted.current) setPending(''); } }
  };
  const check = async () => {
    const current = await run('check');
    // The public native bridge intentionally owns checking, confirmation and
    // installation. Product code never supplies a package URL or authorizes it.
    if (current && !current.restartRequired && canOpenAppUpdates && !current.busy) await openAppUpdates();
  };
  const primary = () => action === 'plugin' ? run('install') : action === 'app' ? openAppUpdates() : check();
  const retry = () => {
    const { action, args } = error ? retryAction.current : { action: ['install', 'rollback'].includes(data?.lastAction) ? data.lastAction : 'check' };
    if (action === 'status') setError('');
    return action === 'app' ? openAppUpdates() : action === 'check' ? check() : run(action, args);
  };
  const close = () => setOpen(false);
  return <>
    <Tooltip label={status ? `更新 · ${status}` : '更新'} side="top" gap={10} delayMs={450} portal>
      <button type="button" className={`cmd-update-launcher ${wide ? '' : 'cmd-update-launcher-rail'}`} aria-label={status ? `更新，${status}` : '更新'} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <span className="cmd-update-icon"><UIIcon name="refresh" size={16} />{(updateAvailable || restart) && <i aria-hidden="true" />}</span>
        {wide && <><span>更新</span>{status && <small data-ready={restart}>{status}</small>}</>}
      </button>
    </Tooltip>
    <Modal open={open} headless onClose={close} title="更新" className="cmd-update-dialog">
      <header className="cmd-update-header"><div><h2>更新</h2><p>当前连接主机 · {localDesktop ? '本机' : globalThis.location?.hostname || '本机'}</p></div><button type="button" className="cmd-update-icon-button" aria-label="关闭更新" onClick={close}><UIIcon name="close" size={16} /></button></header>
      <div className="cmd-update-content">
        <section className="cmd-update-plugin" aria-labelledby={`${id}-plugin`}>
          <div className="cmd-update-card-heading"><span className="cmd-update-plugin-mark"><img src={brandIcon} width="38" height="38" alt="BenchGo" /></span><div><h3 id={`${id}-plugin`}>BenchGo</h3><p>{data?.current?.release ? `v${data.current.release}` : '按需更新'}{targetVersion && updateAvailable && !restart && <><span aria-hidden="true"> → </span><strong>v{targetVersion}</strong></>}</p></div></div>
          <p className="cmd-update-description">{description}</p>
          {!data && !error ? <Loading label="正在读取更新信息" compact /> : restart ? <div className="cmd-update-notice" role="status"><UIIcon name="check" size={16} /><div><strong>已准备好，重启主机{serverDeployment ? '服务' : '应用'}后生效</strong><p>{data?.busy ? '有任务正在运行，请先结束任务再重启。' : serverDeployment ? '请由主机维护者重启服务，然后重新连接工作台。' : '先结束任务，再退出并重新打开主机上的 BenchGo。'}</p></div></div> : <>
            {(installBlockReason && (updateAvailable || action === 'blocked' || action === 'deployment')) && <p className="cmd-update-warning" role="status">{installBlockReason}</p>}
            {data?.managed === false && !updateAvailable && <p className="cmd-update-warning">{serverManaged ? '此主机由服务器部署管理' : '当前安装方式需要新版应用才能启用功能包更新。'}</p>}
            <div className="cmd-update-actions"><span role="status">{pluginStatus}</span><span className="cmd-update-action-buttons">{updateAvailable && <button type="button" className="cmd-update-text-button" disabled={working} onClick={() => void check()}>重新检查</button>}<BubbleTooltip label={actionable && (!enabled || appOnHost) ? installBlockReason || '当前暂不能更新' : undefined} portal><button type="button" className={`cmd-update-button ${actionable ? 'cmd-update-primary' : ''}`} disabled={working || (actionable && (!enabled || appOnHost))} onClick={() => void primary()}>{pending === 'install' || data?.phase === 'downloading' ? '下载中…' : pending === 'app' ? '更新中…' : actionable ? '立即更新' : '检查更新'}</button></BubbleTooltip></span></div>
          </>}
          {data?.release?.notes && <Disclosure className="cmd-update-notes" title="更新内容"><p>{data.release.notes}</p></Disclosure>}
        </section>
        {data && <Disclosure className="cmd-update-details" title="版本详情"><dl><div><dt>功能包</dt><dd>{data.current?.plugin ? `v${data.current.plugin}` : '版本未知'}{pluginAvailable && ` → v${plugin.version}`}</dd></div>{!serverDeployment && <div><dt>主机应用</dt><dd>{data.current?.app ? `v${data.current.app}` : '版本未知'}{appAvailable && ` → v${app.version}`}</dd></div>}<div><dt>引擎</dt><dd>{data.current?.engine || '版本未知'}</dd></div></dl>{canOpenAppUpdates && !serverDeployment && !restart && <button type="button" className="cmd-update-text-button" disabled={working || !!data.busy} onClick={() => void openAppUpdates()}>检查安装器更新</button>}</Disclosure>}
        {!serverDeployment && (nativeError || nativeState?.phase === 'error') && <div className="cmd-update-error" role="alert"><span>{nativeError || '应用更新未完成，请重新检查。'}</span><button type="button" className="cmd-update-text-button" disabled={working || !!data?.busy || restart} onClick={() => void openAppUpdates()}>重试应用更新</button></div>}
        {(error || (!unpublished && data?.error)) && <div className="cmd-update-error" role="alert"><span>{error || data.error}</span><button type="button" className="cmd-update-text-button" disabled={!!pending || (working && retryAction.current.action !== 'status')} onClick={() => void retry()}>重试</button></div>}
        <section className="cmd-update-source" aria-labelledby={`${id}-source`}>
          <div className="cmd-update-source-row"><label htmlFor={`${id}-source-select`} id={`${id}-source`}><LinkIconMedium kind="url" href="https://github.com" size={16} />更新来源</label><Select id={`${id}-source-select`} value={source} disabled={working || restart} onChange={event => { const value = event.target.value; setSource(value); setError(''); if (value !== 'custom') void configure(value); }}>{Object.entries(sourceNames).map(([value, label]) => <option key={value} value={value}>{label}{value === 'mirror' ? '（默认）' : ''}</option>)}</Select></div>
          {source === 'custom' && <form className="cmd-update-custom" onSubmit={event => { event.preventDefault(); void configure('custom', event.currentTarget.elements.namedItem('mirrorUrl').value); }}><input name="mirrorUrl" type="url" required aria-label="自定义 HTTPS 镜像地址" placeholder="https://mirror.example.com/" value={mirrorUrl} disabled={working || restart} onChange={event => setMirrorUrl(event.target.value)} /><button type="submit" className="cmd-update-button" disabled={working || restart}>保存</button></form>}
          <p>功能包从 GitHub 正式发布获取；镜像仅用于下载。{canOpenAppUpdates && '应用安装器使用内置更新来源。'}</p>
        </section>
      </div>
      <footer className="cmd-update-footer"><span>此处更新连接主机；手机应用在设备页检查</span>{data?.canRollback && !restart && <button type="button" className="cmd-update-text-button" disabled={working || !!data?.busy} onClick={() => void run('rollback')}>回退上版</button>}</footer>
    </Modal>
  </>;
}
