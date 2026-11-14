import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CustomSelect } from '../../shared/client/custom-select.jsx';
import { Button } from '../../shared/client/ui/index.jsx';
import { Loading } from '../../shared/client/ui/loading.jsx';
import { createProjectBridge } from '../../link/client/project-bridge.mjs';
import { deviceIcon, deviceStatus } from '../../link/client/device-state.mjs';
import { ProjectDialog, ProjectPicker } from './project-picker.jsx';
import { UIIcon } from './iconsax.jsx';

function RemoteProjectPicker({ device, ...props }) {
  const frame = useRef(null), [url, setUrl] = useState('');
  const bridge = useMemo(() => createProjectBridge({ deviceId: device.id, onEntry: setUrl, getFrame: () => frame.current }), [device.id]);
  useEffect(() => () => bridge.dispose(), [bridge]);
  return <><ProjectPicker {...props} api={bridge.api} allowDesktop={false} />{url && <iframe hidden ref={frame} src={url} title={device.name + '的项目连接'} onLoad={() => bridge.probe()} referrerPolicy="no-referrer" />}</>;
}

/** Creation belongs to the chosen device; display scope only supplies the initial choice. */
export function ResourceCreationDialog({ action, navigation: n, api, onClose, onSelected, onNewSession }) {
  const localOnly = n.enabled === false;
  const devices = localOnly ? [{ id: n.activeId, name: '当前设备', kind: 'local', status: 'online' }] : n.devices;
  const preferred = n.selected.length === 1 ? n.selected[0].id : devices.find(device => device.id === n.activeId)?.id || devices[0]?.id || '';
  const [chosen, setChosen] = useState(preferred || null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [draft, setDraft] = useState({ tab: 'browse', url: '' });
  const gate = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (chosen === null && preferred) setChosen(preferred); }, [chosen, preferred]);
  const device = devices.find(item => item.id === (chosen ?? preferred));
  const local = device?.id === n.activeId;
  useEffect(() => { if (!device) setBusy(false); }, [device]);
  const deviceControl = locked => <div className="cmd-creation-device">
    <CustomSelect id="cmd-creation-device" aria-label="目标设备" value={device?.id || ''} placeholder="选择设备" disabled={locked || !devices.length || (devices.length === 1 && !!device)} onChange={id => { setChosen(id); setError(''); }} options={devices.map(item => ({ value: item.id, label: <>{item.name}{(item.id === n.activeId || deviceStatus(item)) && <span className="cmd-creation-device-status"> · {item.id === n.activeId ? '当前工作台' : deviceStatus(item)}</span>}</>, searchText: item.name, icon: <span data-device-available={['online', 'connected'].includes(item.status)}><UIIcon name={deviceIcon(item)} size={16} /></span> }))} />
  </div>;
  const start = async () => {
    if (!device || gate.current) return;
    gate.current = true; setBusy(true); setError('');
    try { await onNewSession(device); if (mounted.current) onClose(); }
    catch (cause) { if (mounted.current) setError(cause.message); }
    finally { gate.current = false; if (mounted.current) setBusy(false); }
  };
  const pickerProps = { embedded: true, onBusyChange: setBusy, draft, onDraftChange: setDraft, onClose, onSelected: project => onSelected(project, device), toolbarEnd: deviceControl(busy) };
  const key = JSON.stringify([device?.id, device?.hostId, device?.authorizationId]);
  return <ProjectDialog title={action === 'addProject' ? '添加项目' : '新会话'} className={action === 'newSession' ? 'cmd-creation-session-dialog' : ''} busy={busy} onClose={onClose}>
    {(action === 'newSession' || !device) && <div className="cmd-creation-device-row"><label htmlFor="cmd-creation-device">设备</label>{deviceControl(busy)}</div>}
    {action === 'addProject' && device && (local ? <ProjectPicker key={key} {...pickerProps} api={api} /> : <RemoteProjectPicker key={key} {...pickerProps} device={device} />)}
    {!device && <div className="cmd-creation-empty">{n.ready === false ? <Loading label="正在读取设备…" /> : <><UIIcon name="devices" size={24} /><strong>{devices.length ? '目标设备已移除' : n.error ? '无法读取设备' : '暂无可用设备'}</strong><p>{devices.length ? '请重新选择设备，或在设备中心检查连接。' : n.error || '在设备中心连接设备后，即可在这里创建。'}</p>{n.error && <Button variant="ghost" onClick={n.retry}>重试</Button>}<Button variant="ghost" onClick={() => { onClose(); document.querySelector('.dsh-device-launcher')?.click(); }}>打开设备中心</Button></>}</div>}
    {error && <p className="cmd-project-error" role="alert">{error}</p>}
    {action === 'newSession' && <div className="cmd-project-submit"><Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button><Button className="cmd-dialog-button cmd-dialog-primary" disabled={busy || !device} onClick={() => void start()}>{busy ? '创建中…' : '创建会话'}</Button></div>}
  </ProjectDialog>;
}
