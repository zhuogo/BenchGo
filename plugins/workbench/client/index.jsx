import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '../../shared/client/ui/index.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import { DeviceLauncher } from '../../link/client/device-launcher.jsx';
import * as sidebar from 'benchgo-workbench-vendor:sidebar';
import * as ssh from 'benchgo-workbench-vendor:ssh';
import { contextFacade } from '../src/boundary.mjs';
import css from './style.css';
import { localWorkbenchPage } from './local-surface.mjs';

const PANEL = 'benchgo-workbench';
const localPage = host => localWorkbenchPage(location, host.connection);
async function api(input) {
  const response = await fetch(new URL('api/benchgo/workbench', document.baseURI), { credentials: 'same-origin', ...(input ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(20000) });
  let value; try { value = await response.json(); } catch { throw new Error('工作台暂时不可用，请检查服务连接'); }
  if (!response.ok) throw new Error(value.error || '工作台请求失败'); return value;
}
export function WorkbenchPage({ host, runtime }) {
  const [state, setState] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false), [address, setAddress] = useState(''), [port, setPort] = useState('22'), [candidate, setCandidate] = useState(null);
  const [operationError, setOperationError] = useState('');
  const serviceState = useSyncExternalStore(runtime.subscribe, runtime.snapshot);
  const refresh = async () => { setLoading(true); setError(''); try { setState(await api()); } catch (e) { setError(e.message); } finally { setLoading(false); } };
  useEffect(() => { if (localPage(host)) refresh(); else setLoading(false); }, []);
  const open = type => {
    setOperationError('');
    try {
      const sessions = host.sessions.list.getSnapshot();
      const id = Object.keys(sessions.byId ?? {}).find(key => (sessions.byId[key].retainedBy?.mainView ?? 0) > 0);
      if (!id) throw new Error('请先打开一个项目对话，再使用文件、Git 或终端');
      if (!runtime.sidebar) throw new Error('工作台界面尚未就绪，请稍后重试');
      const tab = runtime.sidebar.getTab(type);
      if (!tab || tab.available && !tab.available(host)) throw new Error('当前宿主尚未提供此工作台能力');
      host.layout.selectPanel(null);
      runtime.sidebar.openTab({ type }, { sessionId: id });
    } catch (e) { setOperationError(e.message); }
  };
  const probe = async event => {
    event.preventDefault(); setBusy(true); setCandidate(null); setOperationError('');
    try { setCandidate(await api({ action: 'ssh.probe', host: address, port: Number(port) })); }
    catch (e) { setOperationError(e.message); } finally { setBusy(false); }
  };
  const confirm = async () => {
    setBusy(true); setOperationError('');
    try { await api({ action: 'ssh.confirm', challenge: candidate.challenge, fingerprint: candidate.fingerprint }); setCandidate(null); await refresh(); }
    catch (e) { setOperationError(e.message); } finally { setBusy(false); }
  };
  return <section className="bg-workbench"><style>{css}</style><header><div><h1>工作台</h1><p>编辑项目文件、查看 Git 变更和管理远程服务器。</p></div><DeviceLauncher /></header>
    {!localPage(host) ? <div className="bg-workbench-empty"><UIIcon name="devices" size={28} /><h2>从本机打开运维工作台</h2><p>远程连接继续使用设备中心和当前会话的官方工具。</p></div> : loading ? <div className="bg-workbench-empty" role="status"><UIIcon name="refresh" size={24} /><p>正在读取工作台状态…</p></div> : error ? <div className="bg-workbench-empty" role="alert"><h2>工作台暂时不可用</h2><p>{error}</p><Button onClick={refresh}>重试</Button></div> : <>
      <section><h2>项目</h2><p>文件、Git 和终端跟随当前项目对话。</p><div className="bg-workbench-actions">{[['editor', '文件'], ['git', 'Git 变更'], ['terminal-bottom', '终端']].map(([type, label]) => <Button key={type} variant="outline" disabled={!state.sidebar.available || !serviceState.sidebar} onClick={() => open(type)}>{label}</Button>)}</div>{(!state.sidebar.available || serviceState.error) && <p role="status">{state.sidebar.error || serviceState.error || '工作台组件正在连接…'}</p>}</section>
      <section><h2>远程运维</h2><p>先核对服务器的 SHA256 指纹，再在运维面板配置认证、终端、SFTP 和端口转发。</p>
        <form onSubmit={probe}><label>服务器地址<input required value={address} onChange={e => { setAddress(e.target.value); setCandidate(null); }} placeholder="服务器 IP 或域名" autoComplete="off" /></label><label className="bg-workbench-port">SSH 端口<input required type="number" min="1" max="65535" value={port} onChange={e => { setPort(e.target.value); setCandidate(null); }} /></label><Button type="submit" variant="outline" disabled={busy}>{busy ? '正在处理…' : '读取指纹'}</Button></form>
        {candidate && <div className="bg-workbench-trust"><strong>{candidate.host}:{candidate.port}</strong><code>{candidate.fingerprint}</code><p>请与服务器管理员或控制台提供的指纹核对。</p><div className="bg-workbench-actions"><Button disabled={busy} onClick={confirm}>确认并信任此指纹</Button><Button variant="ghost" disabled={busy} onClick={() => setCandidate(null)}>取消</Button></div></div>}
        {state.trustedHosts.length ? <ul className="bg-workbench-hosts">{state.trustedHosts.map(item => <li key={item.id}><span>{item.host}:{item.port}</span><code>{item.fingerprint}</code><span>已确认</span></li>)}</ul> : <div className="bg-workbench-empty bg-workbench-empty-compact"><UIIcon name="link" size={24} /><h3>尚未确认服务器</h3><p>读取并确认指纹后，即可连接服务器。</p></div>}
        <Button disabled={!state.ssh.available || !serviceState.ssh} onClick={() => host.layout.selectPanel('ssh')}>打开远程运维</Button>{!state.ssh.available && <p role="status">{state.ssh.error || 'SSH 组件正在连接…'}</p>}
      </section>
    </>}{operationError && <div role="alert" className="bg-workbench-error">{operationError}<Button variant="ghost" onClick={() => setOperationError('')}>关闭</Button></div>}
  </section>;
}

export function mountWorkbenchClient(ctx) {
  let version = { sidebar: false, ssh: false, error: '' }; const listeners = new Set();
  const runtime = { sidebar: null, snapshot: () => version, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  const update = patch => { version = { ...version, ...patch }; listeners.forEach(fn => fn()); };
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 35, label: () => '工作台' }, () => <UIIcon name="folder" size={16} />));
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, inject: () => ({ host: ctx, runtime }) }, WorkbenchPage));
  if (!localPage(ctx)) return;
  ctx.inject(sidebar.inject, child => {
    const provide = (name, service) => {
      if (name === 'betterSidebar') {
        const register = service.registerTab.bind(service);
        service.registerTab = descriptor => ['sidechat', 'subagent'].includes(descriptor.id) ? () => {} : register(descriptor);
        runtime.sidebar = service; update({ sidebar: true });
      }
      return child.provide(name, service);
    };
    try { sidebar.apply(contextFacade(child, { provide })); }
    catch (error) { update({ error: error.message, sidebar: false }); }
    child.effect(() => () => { runtime.sidebar = null; update({ sidebar: false }); });
  });
  ctx.inject(ssh.inject, child => {
    const slots = new Proxy(child.slots, { get(target, key) {
      if (key === 'register') return (options, component) => options.name === 'sidebar.panellist' ? () => {} : target.register(options, component);
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    try { ssh.apply(contextFacade(child, { slots })); update({ ssh: true }); }
    catch (error) { update({ error: error.message, ssh: false }); }
    child.effect(() => () => update({ ssh: false }));
  });
}
