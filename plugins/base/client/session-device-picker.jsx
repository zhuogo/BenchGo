import React, { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CustomSelect } from '../../shared/client/custom-select.jsx';
import { deviceIcon, deviceStatus } from '../../link/client/device-state.mjs';
import { UIIcon } from './iconsax.jsx';

export function SessionDevicePicker({ directory, onSelect }) {
  const [mount, setMount] = useState(null);
  const available = directory?.devices.length > 1;
  useLayoutEffect(() => {
    if (!available) return;
    const center = document.querySelector('.cmd-shell-frame [class*="centerCol"]') || document.querySelector('main');
    if (!center) return;
    const seat = document.createElement('div');
    seat.className = 'cmd-session-device';
    const attach = () => {
      // The upstream hero owns the workspace button and renders this row before the first message.
      const row = center.querySelector('[data-conversation-content]:not([class*="embeddedBody"]) [class*="heroWorkspaceRow"]');
      if (row && seat.parentNode !== row) row.prepend(seat);
      else if (!row) seat.remove();
      setMount(row ? seat : null);
    };
    const observer = new MutationObserver(attach);
    attach();
    observer.observe(center, { childList: true, subtree: true });
    return () => { observer.disconnect(); seat.remove(); };
  }, [available]);
  if (!available || !mount) return null;
  const { devices, activeId } = directory;
  return createPortal(<CustomSelect aria-label="选择设备" value={activeId} onChange={onSelect}
    options={devices.map(device => {
      const status = device.id === activeId ? '当前工作台' : deviceStatus(device);
      return {
        value: device.id,
        searchText: device.name,
        label: <span className="cmd-session-device-label"><span className="cmd-session-device-name">{device.name}</span>{status && <span className="cmd-creation-device-status">{status}</span>}</span>,
        icon: <span className="cmd-session-device-icon" data-device-available={['online', 'connected'].includes(device.status)}><UIIcon name={deviceIcon(device)} size={16} /></span>,
      };
    })} />, mount);
}
