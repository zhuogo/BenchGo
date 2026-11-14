/** Sidebar device switcher state. Local drafts stay on the host page. */
const labelOf = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 100) : '';

export function deviceSwitchItems(devices) {
  const rows = Array.isArray(devices) ? devices.filter(item => item && typeof item.id === 'string' && item.id && labelOf(item.name)) : [];
  const local = rows.find(item => item.kind === 'local') || { id: 'local', name: '本机', kind: 'local', status: 'online' };
  const seen = new Set([local.id]);
  const remote = rows.filter(item => item.kind !== 'local' && !seen.has(item.id) && seen.add(item.id));
  return [{ ...local, name: labelOf(local.name) || '本机' }, ...remote.map(item => ({ ...item, name: labelOf(item.name) }))];
}

/** Embedded workbenches receive public device labels, never owner credentials. */
export function connectDeviceSwitch({ host = globalThis, onChange = () => {}, onSidebarToggle = () => {} } = {}) {
  const parent = host.parent;
  if (!parent || parent === host) return null;
  let origin = '', desktopSidebar = false;
  const ready = () => parent.postMessage({ type: 'benchgo:device-switch:ready' }, origin || '*');
  const receive = event => {
    if (event.source !== parent || (origin && origin !== event.origin)) return;
    if (event.data?.type === 'benchgo:device-switch:probe') { ready(); return; }
    if (event.data?.type === 'benchgo:sidebar:toggle') { if (origin && desktopSidebar) onSidebarToggle(); return; }
    if (event.data?.type !== 'benchgo:device-switch:init' || !Array.isArray(event.data.devices)) return;
    try {
      const url = new URL(event.origin);
      if (!['http:', 'https:', 'dsh-app:'].includes(url.protocol) || (url.origin !== event.origin && 'dsh-app://' + url.host !== event.origin)) return;
    } catch { return; }
    origin = event.origin;
    desktopSidebar = event.data.desktopSidebar === true;
    onChange({ devices: deviceSwitchItems(event.data.devices), activeId: event.data.activeId, busy: event.data.busy, error: event.data.error, desktopSidebar });
  };
  host.addEventListener('message', receive); ready();
  return {
    select(deviceId) { if (origin) parent.postMessage({ type: 'benchgo:device-switch:select', deviceId }, origin); },
    sidebarState(collapsed) { if (origin && desktopSidebar && typeof collapsed === 'boolean') parent.postMessage({ type: 'benchgo:sidebar:state', collapsed }, origin); },
    dispose() { host.removeEventListener('message', receive); },
  };
}

/** Only the mounted active frame can ask its owner to select a saved device. */
export function deviceSwitchFrameMessage(event, frames) {
  if (!['benchgo:device-switch:ready', 'benchgo:device-switch:select', 'benchgo:sidebar:state'].includes(event.data?.type)) return null;
  const frame = frames.find(item => item.window === event.source && new URL(item.url).origin === event.origin);
  return frame ? { id: frame.id, type: event.data.type, deviceId: event.data.deviceId, ...(event.data.type === 'benchgo:sidebar:state' ? { collapsed: event.data.collapsed } : {}) } : null;
}

export function deviceSwitchState({ devices = [], activeId = null, open = false, busy = '', error = '' } = {}) {
  const items = deviceSwitchItems(devices);
  const active = items.find(item => item.id === activeId) || items[0];
  return {
    items,
    active,
    open: Boolean(open && items.length > 1 && !busy),
    busy: typeof busy === 'string' ? busy : '',
    error: typeof error === 'string' ? error : '',
    multiple: items.length > 1,
  };
}
