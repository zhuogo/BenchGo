import { Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import { Tooltip } from '../../shared/client/ui/tooltip.jsx';
import { Loading } from '../../shared/client/ui/loading.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import { readJsonResponse } from '../../benchgo/client/http-response.mjs';
import { deviceIcon, deviceKind, deviceStatus, workbenchUrl } from './device-state.mjs';
import { connectDeviceSwitch, deviceSwitchFrameMessage, deviceSwitchState } from './device-switch.mjs';

const switchStyle = `.dsh-device-switch{display:flex;align-items:center;justify-content:flex-end;flex:0 1 156px;min-width:0;margin-inline-start:auto;-webkit-app-region:no-drag;color:var(--dsw-alias-label-secondary,#666);font:12px/1.4 var(--dsw-font-family,system-ui)}
html[data-windows-titlebar] .cmd-shell-sidebar:not([data-shortcut-modal=sidebar]) .cmd-sidebar-nav:has(.dsh-device-switch){padding-right:0}
.dsh-device-switch>[class]{min-width:0;max-width:100%}
.cmd-sidebar-nav .dsh-device-switch-trigger{display:flex;align-items:center;justify-content:flex-start;gap:6px;min-width:0;max-width:100%;height:32px;min-height:32px;padding:0 7px;border:0;border-radius:8px;background:color-mix(in srgb,currentColor 5%,transparent);color:inherit;font:inherit;cursor:pointer;transition:background 140ms ease,color 140ms ease,transform 140ms var(--bg-ui-ease-out,cubic-bezier(.23,1,.32,1))}
.dsh-device-switch-trigger>.cmd-ui-icon{flex:none}.dsh-device-switch-trigger>span:not(.cmd-ui-icon){min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmd-sidebar-nav .dsh-device-switch-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,#8882);color:var(--dsw-alias-label-primary,#202020)}
.dsh-device-switch-trigger>.cmd-ui-icon:last-child{margin-inline-start:auto;transition:transform 160ms var(--bg-ui-ease-out,cubic-bezier(.23,1,.32,1))}
.dsh-device-switch-trigger[aria-expanded=true]>.cmd-ui-icon:last-child{transform:rotate(180deg)}
.cmd-sidebar-nav .dsh-device-switch-trigger:hover>.cmd-ui-icon:first-child{transform:none}
.cmd-narrow .dsh-device-switch{flex:none;width:36px;margin:2px 0 0;justify-content:center}
.cmd-narrow .dsh-device-switch-trigger{width:36px;height:36px;min-height:36px;justify-content:center;padding:8px}
.cmd-narrow .dsh-device-switch-trigger>span:not(.cmd-ui-icon),.cmd-narrow .dsh-device-switch-trigger>.cmd-ui-icon:last-child{display:none}
.dsh-device-switch-menu{--dsw-menu-backdrop-filter:none;width:256px;max-width:calc(100vw - 24px);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#fff));color:var(--dsw-alias-label-primary,#202020);font:13px/1.4 var(--dsw-font-family,system-ui);opacity:1;transform:none}
.dsh-device-switch-menu>[role=presentation]{opacity:1;transform:translateY(0);transition:opacity 125ms var(--bg-ui-ease-out,cubic-bezier(.23,1,.32,1)),transform 125ms var(--bg-ui-ease-out,cubic-bezier(.23,1,.32,1))}
@starting-style{html:not([data-input-modality=keyboard]) .dsh-device-switch-menu>[role=presentation]{opacity:0;transform:translateY(-3px)}}
.dsh-device-switch-menu [role=menuitem]{min-height:48px}
.dsh-device-switch-copy{display:grid;min-width:0;gap:2px}.dsh-device-switch-copy strong,.dsh-device-switch-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-device-switch-copy strong{font-size:12px;font-weight:550}.dsh-device-switch-copy small{color:var(--dsw-alias-label-secondary,#777);font-size:11px;font-weight:400}
.dsh-device-switch-menu [data-device-available=true]{color:var(--dsw-alias-state-business-primary,#438bea)}
.dsh-device-switch-menu [data-device-available=false]{color:var(--dsw-alias-label-tertiary,#888)}
.dsh-device-switch-error{max-width:232px;margin:4px 8px 8px;color:var(--dsw-alias-state-error-primary,#b34845);font-size:12px;line-height:1.6;overflow-wrap:anywhere}
.dsh-device-switch-stage{position:fixed;z-index:30;inset:var(--dsh-windows-titlebar-height,40px) 0 0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#202020)}
.dsh-device-switch-stage iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:inherit}
.dsh-device-switch-stage[hidden],.dsh-device-switch-stage iframe[hidden]{display:none!important}
.dsh-device-switch-loading{position:absolute;inset:0;display:grid;align-content:center;justify-items:center;gap:14px;background:inherit;font:13px/1.6 var(--dsw-font-family,system-ui)}
.dsh-device-switch-loading p{max-width:min(420px,calc(100vw - 48px));margin:0;text-align:center;overflow-wrap:anywhere}
.dsh-device-switch-loading button{padding:6px 12px;border:1px solid #8883;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer}
@media(hover:hover) and (pointer:fine){.cmd-sidebar-nav .dsh-device-switch-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,#8882);color:var(--dsw-alias-label-primary,#202020)}}
@media(prefers-reduced-motion:reduce){.dsh-device-switch-menu>[role=presentation],.cmd-sidebar-nav .dsh-device-switch-trigger,.dsh-device-switch-trigger>.cmd-ui-icon:last-child{transition:none;animation:none}.cmd-sidebar-nav .dsh-device-switch-trigger:active{transform:none}@starting-style{html:not([data-input-modality=keyboard]) .dsh-device-switch-menu>[role=presentation]{opacity:1;transform:none}}}
html[data-input-modality=keyboard] .dsh-device-switch-menu>[role=presentation]{transition:none}`;

async function ownerRequest(action, args = {}) {
  const url = new URL('/api/commander-devices', location.origin);
  const response = await fetch(url, { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args, parentOrigin: location.origin }) });
  const value = await readJsonResponse(response, url);
  if (value.error) throw new Error(typeof value.error === 'string' ? value.error : value.error.message || '设备暂时无法打开');
  return value;
}

/** Render the same sidebar control in the owner and its retained remote workbenches. */
export function DeviceSwitch() {
  const root = useRef(null), frames = useRef(new Map()), bridge = useRef(null), gate = useRef(false), mounted = useRef(true), refreshing = useRef(null);
  const sidebarStates = useRef(new Map());
  const [devices, setDevices] = useState([]), [activeId, setActiveId] = useState(null), [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [urls, setUrls] = useState({}), [ready, setReady] = useState([]), [delegated, setDelegated] = useState(null);
  const [frameErrors, setFrameErrors] = useState({});
  const embedded = window.parent && window.parent !== window;
  const owner = !embedded && document.documentElement.hasAttribute('data-windows-titlebar');
  const state = deviceSwitchState(delegated ? { ...delegated, open } : { devices, activeId, open, busy, error });
  const refresh = () => {
    if (!owner) return;
    refreshing.current ??= ownerRequest('devices').then(value => { if (mounted.current && Array.isArray(value.devices)) setDevices(value.devices); return value.devices; }).catch(() => {}).finally(() => { refreshing.current = null; });
    return refreshing.current;
  };
  useEffect(() => {
    mounted.current = true;
    if (owner) void refresh();
    const changed = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    document.addEventListener('benchgo:devices-changed', changed); document.addEventListener('visibilitychange', changed); window.addEventListener('focus', changed);
    bridge.current = connectDeviceSwitch({ onChange: setDelegated, onSidebarToggle: () => root.current?.closest('.cmd-shell-frame')?.querySelector('[data-sidebar-toggle]')?.click() });
    return () => { mounted.current = false; bridge.current?.dispose(); document.removeEventListener('benchgo:devices-changed', changed); document.removeEventListener('visibilitychange', changed); window.removeEventListener('focus', changed); };
  }, [owner]);
  useEffect(() => { if (delegated?.error) setOpen(true); }, [delegated?.error]);
  useEffect(() => { if (owner && activeId && !devices.some(device => device.id === activeId)) setActiveId(null); }, [owner, devices, activeId]);
  useEffect(() => {
    if (!owner) return;
    const shell = root.current?.closest('.cmd-shell-frame'), wasInert = shell?.hasAttribute('inert');
    if (activeId && shell) shell.setAttribute('inert', '');
    return () => { if (shell && !wasInert) shell.removeAttribute('inert'); };
  }, [owner, activeId]);
  useEffect(() => {
    if (!embedded || !delegated?.desktopSidebar) return;
    const shell = root.current?.closest('.cmd-shell-frame');
    if (!shell) return;
    document.documentElement.setAttribute('data-benchgo-desktop-embedded', '');
    const publish = () => bridge.current?.sidebarState(shell.getAttribute('data-sidebar-collapsed') === 'true');
    const observer = new MutationObserver(publish);
    observer.observe(shell, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] });
    publish();
    return () => { observer.disconnect(); document.documentElement.removeAttribute('data-benchgo-desktop-embedded'); };
  }, [embedded, delegated?.desktopSidebar]);
  const selected = deviceId => document.dispatchEvent(new CustomEvent('benchgo:workbench-selected', { detail: { deviceId } }));
  const choose = async (device, { retry = false } = {}) => {
    if (!device?.id || gate.current || state.busy) return;
    setOpen(false);
    if (delegated) { bridge.current?.select(device.id); selected(device.id); return; }
    if (device.id === state.active.id && !retry && !frameErrors[device.id]) { setError(''); selected(device.id); return; }
    if (device.kind === 'local') { setActiveId(null); setError(''); selected(device.id); return; }
    gate.current = true; setBusy(device.id); setError('');
    try {
      if (retry || frameErrors[device.id] || !Object.hasOwn(urls, device.id)) {
        const value = await ownerRequest('select', { deviceId: device.id });
        if (typeof value.url !== 'string' || !value.url) throw new Error('设备未返回工作台地址');
        const url = workbenchUrl(value.url, location.origin);
        if (!mounted.current) return;
        setReady(items => items.filter(id => id !== device.id));
        setFrameErrors(current => ({ ...current, [device.id]: '' }));
        sidebarStates.current.delete(device.id);
        setUrls(current => ({ ...current, [device.id]: url }));
      }
      if (mounted.current) { setActiveId(device.id); selected(device.id); void refresh(); }
    } catch (reason) { if (mounted.current) { const message = reason.name === 'TimeoutError' ? '设备连接超时，请检查网络后重试' : reason.message; if (activeId === device.id) setFrameErrors(current => ({ ...current, [device.id]: message })); else { setError(message); setOpen(true); } } }
    finally { gate.current = false; if (mounted.current) setBusy(''); }
  };
  const publish = id => {
    const url = urls[id]; if (!url) return;
    frames.current.get(id)?.contentWindow?.postMessage({ type: 'benchgo:device-switch:init', devices: state.items, activeId: id, busy, error, desktopSidebar: true }, new URL(url).origin);
  };
  useEffect(() => {
    if (!owner) return;
    const receive = event => {
      const message = deviceSwitchFrameMessage(event, Object.entries(urls).map(([id, url]) => ({ id, url, window: frames.current.get(id)?.contentWindow })));
      if (!message) return;
      if (message.type === 'benchgo:device-switch:ready') { publish(message.id); setFrameErrors(current => current[message.id] ? { ...current, [message.id]: '' } : current); setReady(items => items.includes(message.id) ? items : [...items, message.id]); }
      else if (message.type === 'benchgo:sidebar:state' && typeof message.collapsed === 'boolean') {
        sidebarStates.current.set(message.id, message.collapsed);
        if (message.id === activeId) document.dispatchEvent(new CustomEvent('benchgo:desktop-sidebar-state', { detail: { collapsed: message.collapsed } }));
      }
      else if (message.id === activeId) void choose(state.items.find(item => item.id === message.deviceId));
    };
    window.addEventListener('message', receive);
    for (const id of Object.keys(urls)) publish(id);
    return () => window.removeEventListener('message', receive);
  }, [owner, urls, devices, activeId, busy, error]);
  useEffect(() => {
    if (!owner) return;
    document.dispatchEvent(new CustomEvent('benchgo:desktop-sidebar-state', { detail: { collapsed: activeId ? sidebarStates.current.get(activeId) : null } }));
    const toggle = event => {
      if (!activeId) return;
      event.preventDefault();
      if (ready.includes(activeId) && !frameErrors[activeId]) frames.current.get(activeId)?.contentWindow?.postMessage({ type: 'benchgo:sidebar:toggle' }, new URL(urls[activeId]).origin);
    };
    document.addEventListener('benchgo:sidebar-toggle', toggle);
    return () => document.removeEventListener('benchgo:sidebar-toggle', toggle);
  }, [owner, activeId, ready, frameErrors, urls]);
  useEffect(() => {
    if (!owner) return;
    const select = async event => {
      const id = event.detail?.deviceId;
      if (typeof id !== 'string' || !id) return;
      let device = state.items.find(item => item.id === id);
      if (!device) device = (await refresh())?.find(item => item.id === id);
      if (!device) { setError('设备已不可用，请在设备中心重新连接'); setOpen(true); return; }
      void choose(device);
    };
    document.addEventListener('benchgo:device-select', select);
    return () => document.removeEventListener('benchgo:device-select', select);
  }, [owner, devices, activeId, delegated, busy, urls, frameErrors]);
  useEffect(() => {
    if (!owner || !activeId || !urls[activeId] || ready.includes(activeId) || frameErrors[activeId]) return;
    const timeout = setTimeout(() => setFrameErrors(current => ({ ...current, [activeId]: '设备工作台未响应，请重试或检查设备连接与插件版本。' })), 15_000);
    return () => clearTimeout(timeout);
  }, [owner, activeId, urls, ready, frameErrors]);
  if ((!owner && !delegated) || !state.multiple) return null;
  const show = () => { setOpen(true); if (!delegated) void refresh(); };
  return <>
    <style>{switchStyle}</style>
    <div className="dsh-device-switch" ref={root}>
      <Menu open={state.open} onClose={() => setOpen(false)} portal autoFocus compact align="end" listClassName="dsh-device-switch-menu" selectedId={state.active.id} onSelect={id => void choose(state.items.find(item => item.id === id))}
        items={[{ type: 'label', id: 'device-heading', text: '切换设备' }, ...state.items.map(device => ({ id: device.id, disabled: !!state.busy, icon: <span data-device-available={['online', 'connected'].includes(device.status)}><UIIcon name={deviceIcon(device)} size={16} /></span>, label: <span className="dsh-device-switch-copy"><strong>{device.name}</strong><small>{[deviceKind(device), state.active.id === device.id ? '当前工作台' : deviceStatus(device)].filter(Boolean).join(' · ')}</small></span> }))]}
        anchor={<Tooltip label={'切换设备 · ' + state.active.name} disabled={state.open}><button type="button" className="dsh-device-switch-trigger" aria-haspopup="menu" aria-expanded={state.open} aria-label={'当前工作台：' + state.active.name} aria-busy={!!state.busy} disabled={!!state.busy} onClick={() => open ? setOpen(false) : show()} onKeyDown={event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); show(); } }}>
          <UIIcon name={deviceIcon(state.active)} size={15} /><span>{state.busy ? '正在连接…' : state.active.name}</span><UIIcon name="chevronDown" size={11} />
        </button></Tooltip>}>
        {state.error && <p className="dsh-device-switch-error" role="alert">{state.error}，请选择设备重试。</p>}
      </Menu>
    </div>
    {owner && createPortal(<div className="dsh-device-switch-stage" hidden={!activeId}>{Object.entries(urls).map(([id, url]) => <iframe key={id} ref={node => { if (node) frames.current.set(id, node); else frames.current.delete(id); }} src={url} title={(devices.find(item => item.id === id)?.name || '设备') + '工作台'} hidden={activeId !== id} onLoad={() => { setReady(items => items.filter(item => item !== id)); frames.current.get(id)?.contentWindow?.postMessage({ type: 'benchgo:device-switch:probe' }, new URL(url).origin); }} onError={() => setFrameErrors(current => ({ ...current, [id]: '设备工作台加载失败，请检查连接后重试' }))} allow="clipboard-read; clipboard-write; microphone" referrerPolicy="no-referrer" />)}
      {activeId && (!ready.includes(activeId) || frameErrors[activeId]) && <div className="dsh-device-switch-loading">{frameErrors[activeId] ? <><p role="alert">{frameErrors[activeId]}</p><button type="button" disabled={!!busy} onClick={() => void choose(state.items.find(item => item.id === activeId), { retry: true })}>{busy ? '正在重试…' : '重试'}</button></> : <Loading compact label="正在打开设备工作台…" />}<button type="button" onClick={() => { setActiveId(null); setOpen(false); selected(state.items[0].id); }}>返回本机</button></div>}
    </div>, document.body)}
  </>;
}
