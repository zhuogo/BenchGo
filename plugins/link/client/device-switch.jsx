import { Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import { Tooltip } from '../../shared/client/ui/tooltip.jsx';
import { Loading } from '../../shared/client/ui/loading.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UIIcon } from '../../base/client/iconsax.jsx';
import { readJsonResponse } from '../../base/client/http-response.mjs';
import { deviceIcon, deviceKind, deviceStatus, workbenchUrl } from './device-state.mjs';
import { connectDeviceSwitch, defaultWorkbench, defaultWorkbenchDevice, deviceSwitchFrameMessage, deviceSwitchState, saveDefaultWorkbench } from './device-switch.mjs';
import { observeHostTheme, sendWorkbenchTheme, themedWorkbenchUrl } from './device-theme.mjs';

const switchStyle = `.dsh-device-switch{display:flex;align-items:center;justify-content:flex-end;flex:0 1 156px;min-width:0;margin-inline-start:auto;-webkit-app-region:no-drag;color:var(--dsw-alias-label-secondary,#666);font:12px/1.4 var(--dsw-font-family,system-ui)}
html[data-windows-titlebar] .cmd-shell-sidebar:not([data-shortcut-modal=sidebar]) .cmd-sidebar-nav:has(.dsh-device-switch){padding-right:0}
.dsh-device-switch>[class]{min-width:0;max-width:100%}
.cmd-sidebar-nav .dsh-device-switch-trigger{position:relative;display:flex;align-items:center;justify-content:flex-start;gap:6px;min-width:0;max-width:100%;height:32px;min-height:32px;padding:0 7px;border:0;border-radius:8px;background:color-mix(in srgb,currentColor 5%,transparent);color:inherit;font:inherit;cursor:pointer;transition:background 140ms ease,color 140ms ease,transform 140ms var(--bg-ui-ease-out,cubic-bezier(.23,1,.32,1))}
.dsh-device-switch-trigger[data-connection-error]::after{content:"";position:absolute;inset-block-start:2px;inset-inline-end:2px;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#b34845);pointer-events:none}
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
.dsh-device-switch-loading button{padding:6px 12px;border:1px solid #8883;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer}
@media(hover:hover) and (pointer:fine){.cmd-sidebar-nav .dsh-device-switch-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,#8882);color:var(--dsw-alias-label-primary,#202020)}}
@media(prefers-reduced-motion:reduce){.dsh-device-switch-menu>[role=presentation],.cmd-sidebar-nav .dsh-device-switch-trigger,.dsh-device-switch-trigger>.cmd-ui-icon:last-child{transition:none;animation:none}.cmd-sidebar-nav .dsh-device-switch-trigger:active{transform:none}@starting-style{html:not([data-input-modality=keyboard]) .dsh-device-switch-menu>[role=presentation]{opacity:1;transform:none}}}
html[data-input-modality=keyboard] .dsh-device-switch-menu>[role=presentation]{transition:none}`;

async function ownerRequest(action, args = {}) {
  const url = new URL('/api/commander-devices', location.origin);
  const response = await fetch(url, { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args, parentOrigin: location.origin }) });
  const failed = response.ok ? null : response.clone();
  const value = await readJsonResponse(response, url).catch(async error => {
    const body = await failed?.json().catch(() => null);
    if (typeof body?.code === 'string') error.code = body.code;
    throw error;
  });
  if (value.error) throw Object.assign(new Error(typeof value.error === 'string' ? value.error : value.error.message || '设备暂时无法打开'), { code: value.code });
  return value;
}

/** Render the same sidebar control in the owner and its retained remote workbenches. */
export function DeviceSwitch() {
  const root = useRef(null), frames = useRef(new Map()), bridge = useRef(null), gate = useRef(false), mounted = useRef(true), refreshing = useRef(null);
  const initialized = useRef(false), pendingResource = useRef(null), activeFrame = useRef(null), previousWorkbench = useRef(null);
  const resourceReady = useRef(new Set());
  const sidebarStates = useRef(new Map());
  const [devices, setDevices] = useState([]), [activeId, setActiveId] = useState(null), [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(''), [failure, setFailure] = useState(null), [urls, setUrls] = useState({}), [ready, setReady] = useState([]), [delegated, setDelegated] = useState(null);
  activeFrame.current = activeId;
  const [groupEnabled, setGroupEnabled] = useState(false);
  const embedded = window.parent && window.parent !== window;
  const owner = !embedded && document.documentElement.hasAttribute('data-windows-titlebar');
  useEffect(() => {
    if (owner) return observeHostTheme(theme => {
      for (const [id, url] of Object.entries(urls)) sendWorkbenchTheme(frames.current.get(id), url, theme);
    });
  }, [owner, urls]);
  const failedDevice = failure?.deviceId && devices.find(device => device.id === failure.deviceId);
  const error = failedDevice ? failedDevice.name + '：' + failure.message : failure?.message;
  const state = deviceSwitchState(delegated ? { ...delegated, open } : { devices, activeId, open, busy, error });
  const refresh = () => {
    if (!owner) return;
    refreshing.current ??= ownerRequest('devices').then(value => {
      if (!mounted.current || !Array.isArray(value.devices)) return;
      const savedId = defaultWorkbench(window);
      const local = value.devices.find(device => device.kind === 'local');
      if (savedId && local && !defaultWorkbenchDevice(value.devices, savedId)) saveDefaultWorkbench(local, window);
      setDevices(value.devices);
      setGroupEnabled(value.groupEnabled === true);
      return value.devices;
    }).catch(() => {}).finally(() => { refreshing.current = null; });
    return refreshing.current;
  };
  useEffect(() => {
    mounted.current = true;
    if (owner) void refresh();
    const changed = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    document.addEventListener('benchgo:devices-changed', changed); document.addEventListener('visibilitychange', changed); window.addEventListener('focus', changed);
    bridge.current = connectDeviceSwitch({ onChange: setDelegated, onSidebarToggle: () => root.current?.closest('.cmd-shell-frame')?.querySelector('[data-sidebar-toggle]')?.click() });
    return () => { mounted.current = false; clearTimeout(pendingResource.current?.timer); pendingResource.current = null; bridge.current?.dispose(); document.removeEventListener('benchgo:devices-changed', changed); document.removeEventListener('visibilitychange', changed); window.removeEventListener('focus', changed); };
  }, [owner]);
  useEffect(() => {
    if (!owner || !groupEnabled) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh();
    }, 4000);
    return () => clearInterval(timer);
  }, [owner, groupEnabled]);
  useEffect(() => {
    if (!owner) return;
    const available = new Set(devices.map(device => device.id));
    if (activeId && !available.has(activeId)) setActiveId(null);
    if (previousWorkbench.current && !available.has(previousWorkbench.current)) previousWorkbench.current = null;
    setFailure(current => current?.deviceId && !available.has(current.deviceId) ? null : current);
    const removed = Object.keys(urls).filter(id => !available.has(id));
    if (!removed.length) return;
    setUrls(current => Object.fromEntries(Object.entries(current).filter(([id]) => available.has(id))));
    setReady(current => current.filter(id => available.has(id)));
    for (const id of removed) sidebarStates.current.delete(id);
  }, [owner, devices, activeId, urls]);
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
  const clearFailure = deviceId => setFailure(current => current?.deviceId === deviceId || current?.deviceId === null ? null : current);
  const failWorkbench = (deviceId, message) => {
    setUrls(current => {
      const next = { ...current };
      delete next[deviceId];
      return next;
    });
    setReady(items => items.filter(id => id !== deviceId));
    resourceReady.current.delete(deviceId);
    sidebarStates.current.delete(deviceId);
    if (previousWorkbench.current === deviceId) previousWorkbench.current = null;
    if (activeFrame.current !== deviceId) return;

    pendingResource.current?.finish(message, false);
    const previous = previousWorkbench.current;
    const fallback = ready.includes(previous) && state.items.some(item => item.id === previous) ? previous : null;
    setActiveId(fallback);
    setFailure({ deviceId, message });
    selected(fallback ?? state.items[0].id);
  };
  const choose = async (device, { requestedResource, admitted = () => true } = {}) => {
    if (!device?.id || gate.current || state.busy) {
      if (requestedResource) throw Error('工作台正在连接，请重试');
      return;
    }
    setOpen(false);
    if (delegated) { bridge.current?.select(device.id); selected(device.id); return; }
    if (!requestedResource) pendingResource.current?.finish('已切换工作台，请重新打开资源', false);
    if (device.kind === 'local') {
      saveDefaultWorkbench(device, window);
      pendingResource.current = requestedResource ?? null;
      setActiveId(null); selected(device.id);
      clearFailure(device.id);
      return;
    }
    if (device.id === state.active.id && !requestedResource) { selected(device.id); return; }
    gate.current = true; setBusy(device.id);
    try {
      const needsEntry = !Object.hasOwn(urls, device.id);
      if (needsEntry) {
        const value = await ownerRequest('select', { deviceId: device.id });
        if (typeof value.url !== 'string' || !value.url) throw new Error('设备未返回工作台地址');
        if (!mounted.current || !admitted()) throw Error('来源工作台已切换，请重试');
        const entry = new URL(workbenchUrl(value.url, location.origin));
        entry.hash = new URLSearchParams({ deviceParentOrigin: location.origin }).toString();
        const url = themedWorkbenchUrl(entry.href);
        resourceReady.current.delete(device.id);
        setReady(items => items.filter(id => id !== device.id));
        sidebarStates.current.delete(device.id);
        setUrls(current => ({ ...current, [device.id]: url }));
      }
      if (mounted.current) {
        if (activeId !== device.id && (!activeId || ready.includes(activeId))) previousWorkbench.current = activeId;
        if (!needsEntry && ready.includes(device.id)) {
          saveDefaultWorkbench(device, window);
          clearFailure(device.id);
        }
        pendingResource.current = requestedResource ?? null;
        setActiveId(device.id); selected(device.id); void refresh();
      }
    } catch (reason) {
      if (requestedResource) throw reason;
      if (!mounted.current) return;
      const message = reason.name === 'TimeoutError' ? '设备连接超时，请检查网络后重试' : reason.message;
      setFailure({ deviceId: device.id, message });
      if (reason.code === 'SSH_AUTH_REQUIRED') {
        document.dispatchEvent(new CustomEvent('benchgo:device-ssh-auth', { detail: { deviceId: device.id } }));
      }
    }
    finally { gate.current = false; if (mounted.current) setBusy(''); }
  };
  useEffect(() => {
    if (!owner || initialized.current || !devices.length) return;
    initialized.current = true;
    const device = defaultWorkbenchDevice(devices, defaultWorkbench(window));
    if (device) void choose(device);
  }, [owner, devices]);
  const publish = id => {
    const url = urls[id]; if (!url) return;
    frames.current.get(id)?.contentWindow?.postMessage({ type: 'benchgo:device-switch:init', devices: state.items, activeId: id, busy, error, desktopSidebar: true }, new URL(url).origin);
  };
  const openPendingResource = id => {
    const request = pendingResource.current;
    if (id !== activeFrame.current || request?.targetId !== id || request.sent) return;
    if (id === null) {
      request.sent = true;
      document.dispatchEvent(new CustomEvent('benchgo:device-resource', { detail: { requestId: request.requestId, resource: request.resource } }));
      return;
    }
    if (!resourceReady.current.has(id) || !urls[id]) return;
    const frame = frames.current.get(id)?.contentWindow;
    if (!frame) return;
    request.sent = true;
    frame.postMessage({ type: 'benchgo:resource:open', requestId: request.requestId, resource: request.resource }, new URL(urls[id]).origin);
  };
  useEffect(() => { if (owner) openPendingResource(activeId); }, [owner, activeId, urls]);
  useEffect(() => {
    if (!owner) return;
    const complete = (targetId, result) => {
      const request = pendingResource.current;
      if (request?.sent && request.targetId === targetId && result?.requestId === request.requestId) {
        request.finish(typeof result.error === 'string' ? result.error : undefined);
      }
    };
    const localComplete = event => complete(null, event.detail);
    const receive = event => {
      const message = deviceSwitchFrameMessage(event, Object.entries(urls).map(([id, url]) => ({ id, url, window: frames.current.get(id)?.contentWindow })));
      if (!message) return;
      if (message.type === 'benchgo:device-switch:ready') {
        publish(message.id);
        const device = state.items.find(item => item.id === message.id);
        if (device && activeFrame.current === message.id) {
          saveDefaultWorkbench(device, window);
          clearFailure(message.id);
        }
        setReady(items => items.includes(message.id) ? items : [...items, message.id]);
      }
      else if (message.type === 'benchgo:resource:ready') { resourceReady.current.add(message.id); openPendingResource(message.id); }
      else if (message.type === 'benchgo:resource:opened') complete(message.id, event.data);
      else if (message.type === 'benchgo:device-switch:resource') {
        const { hostId, requestId, resource } = event.data;
        const admitted = () => mounted.current && activeFrame.current === message.id && frames.current.get(message.id)?.contentWindow === event.source;
        const source = state.items.find(item => item.id === message.id && item.groupMember === true);
        if (!admitted() || !source
          || typeof requestId !== 'string' || !/^[0-9a-f]{32}$/.test(requestId) || typeof hostId !== 'string'
          || !['projects', 'sessions'].includes(resource?.kind) || resource.intent && (resource.kind !== 'projects' || resource.intent !== 'newSession')
          || typeof resource.resourceId !== 'string' || !resource.resourceId || resource.resourceId.length > 200) return;
        const target = state.items.find(item => item.hostId === hostId && item.groupMember === true);
        const reply = error => { if (frames.current.get(message.id)?.contentWindow === event.source) event.source.postMessage({ type: 'benchgo:device-switch:resource-result', requestId, error }, event.origin); };
        if (!target) { reply('目标已不在当前设备组中，请刷新后重试'); return; }
        if (pendingResource.current) { reply('工作台正在打开资源，请重试'); return; }
        const reference = { kind: resource.kind, resourceId: resource.resourceId, ...(resource.kind === 'sessions' && resource.native === true ? { native: true } : {}), ...(resource.intent ? { intent: resource.intent } : {}) };
        const request = { requestId, resource: reference, targetId: target.kind === 'local' ? null : target.id, sent: false,
          finish(error, restore = true) {
            if (pendingResource.current !== request) return;
            clearTimeout(request.timer);
            pendingResource.current = null;
            if (error && restore && activeFrame.current === request.targetId && frames.current.get(source.id)?.contentWindow === event.source) {
              saveDefaultWorkbench(source, window);
              setActiveId(source.id);
              selected(source.id);
            }
            reply(error);
          },
        };
        void choose(target, { admitted, requestedResource: request }).then(() => {
          if (pendingResource.current === request) request.timer = setTimeout(() => request.finish('目标工作台未响应，请重试'), 15_000);
        }, reason => reply(reason.name === 'TimeoutError' ? '设备连接超时，请检查网络后重试' : reason.message));
      }
      else if (message.type === 'benchgo:sidebar:state' && typeof message.collapsed === 'boolean') {
        sidebarStates.current.set(message.id, message.collapsed);
        if (message.id === activeId) document.dispatchEvent(new CustomEvent('benchgo:desktop-sidebar-state', { detail: { collapsed: message.collapsed } }));
      }
      else if (message.type === 'benchgo:device-switch:select' && message.id === activeId) {
        const device = state.items.find(item => item.id === message.deviceId);
        void choose(device);
      }
    };
    window.addEventListener('message', receive);
    window.addEventListener('benchgo:device-resource-opened', localComplete);
    for (const id of Object.keys(urls)) publish(id);
    return () => { window.removeEventListener('message', receive); window.removeEventListener('benchgo:device-resource-opened', localComplete); };
  }, [owner, urls, devices, activeId, busy, error, ready]);
  useEffect(() => {
    if (!owner) return;
    document.dispatchEvent(new CustomEvent('benchgo:desktop-sidebar-state', { detail: { collapsed: activeId ? sidebarStates.current.get(activeId) : null } }));
    const toggle = event => {
      if (!activeId) return;
      event.preventDefault();
      if (ready.includes(activeId)) frames.current.get(activeId)?.contentWindow?.postMessage({ type: 'benchgo:sidebar:toggle' }, new URL(urls[activeId]).origin);
    };
    document.addEventListener('benchgo:sidebar-toggle', toggle);
    return () => document.removeEventListener('benchgo:sidebar-toggle', toggle);
  }, [owner, activeId, ready, urls]);
  useEffect(() => {
    if (!owner) return;
    const select = async event => {
      const id = event.detail?.deviceId;
      if (typeof id !== 'string' || !id) return;
      let device = state.items.find(item => item.id === id);
      if (!device) device = (await refresh())?.find(item => item.id === id);
      if (!device) { setFailure({ deviceId: null, message: '设备已不可用，请在设备中心重新连接' }); return; }
      void choose(device);
    };
    document.addEventListener('benchgo:device-select', select);
    return () => document.removeEventListener('benchgo:device-select', select);
  }, [owner, devices, activeId, delegated, busy, urls, ready]);
  const loadingWorkbench = activeId && !ready.includes(activeId);
  useEffect(() => {
    if (!owner || !loadingWorkbench) return;
    const timeout = setTimeout(() => failWorkbench(activeId, '设备工作台未响应，请检查设备连接与插件版本'), 15_000);
    return () => clearTimeout(timeout);
  }, [owner, activeId, loadingWorkbench]);
  if ((!owner && !delegated) || !state.multiple) return null;
  const show = () => { setOpen(true); if (!delegated) void refresh(); };
  return <>
    <style>{switchStyle}</style>
    <div className="dsh-device-switch" ref={root}>
      <Menu open={state.open} onClose={() => setOpen(false)} portal autoFocus compact align="end" listClassName="dsh-device-switch-menu" selectedId={state.active.id} onSelect={id => void choose(state.items.find(item => item.id === id))}
        items={[{ type: 'label', id: 'device-heading', text: '切换设备' }, ...state.items.map(device => ({ id: device.id, disabled: !!state.busy, icon: <span data-device-available={['online', 'connected'].includes(device.status)}><UIIcon name={deviceIcon(device)} size={16} /></span>, label: <span className="dsh-device-switch-copy"><strong>{device.name}</strong><small>{[deviceKind(device), state.active.id === device.id ? '当前工作台' : deviceStatus(device)].filter(Boolean).join(' · ')}</small></span> }))]}
        anchor={<Tooltip label={state.error || '切换设备 · ' + state.active.name} disabled={state.open}><button type="button" className="dsh-device-switch-trigger" data-connection-error={state.error ? '' : undefined} aria-haspopup="menu" aria-expanded={state.open} aria-label={'当前工作台：' + state.active.name + (state.error ? '，设备切换失败' : '')} aria-busy={!!state.busy} disabled={!!state.busy} onClick={() => open ? setOpen(false) : show()} onKeyDown={event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); show(); } }}>
          <UIIcon name={deviceIcon(state.active)} size={15} /><span>{state.busy ? '正在连接…' : state.active.name}</span><UIIcon name="chevronDown" size={11} />
        </button></Tooltip>}>
        {state.error && <p className="dsh-device-switch-error" role="alert">{state.error.replace(/[。！？]$/, '')}。可重新选择设备重试。</p>}
      </Menu>
    </div>
    {owner && createPortal(<div className="dsh-device-switch-stage" hidden={!activeId}>{Object.entries(urls).map(([id, url]) => <iframe key={id} ref={node => { if (node) frames.current.set(id, node); else frames.current.delete(id); }} src={url} title={(devices.find(item => item.id === id)?.name || '设备') + '工作台'} hidden={activeId !== id} onLoad={event => {
      resourceReady.current.delete(id);
      setReady(items => items.filter(item => item !== id));
      sendWorkbenchTheme(event.currentTarget, url);
      event.currentTarget.contentWindow?.postMessage({ type: 'benchgo:device-switch:probe' }, new URL(url).origin);
      event.currentTarget.contentWindow?.postMessage({ type: 'benchgo:resource:probe' }, new URL(url).origin);
    }} onError={() => failWorkbench(id, '设备工作台加载失败，请检查连接后重试')} allow="clipboard-read; clipboard-write; microphone" referrerPolicy="no-referrer" />)}
      {loadingWorkbench && <div className="dsh-device-switch-loading"><Loading compact label="正在打开设备工作台…" /><button type="button" disabled={!!busy} onClick={() => void choose(state.items[0])}>返回本机</button></div>}
    </div>, document.body)}
  </>;
}
