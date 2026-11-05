import { Select } from '../../shared/client/select.jsx';
import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import { managementCall as call } from './api.mjs';
import { PairQr } from './qr.jsx';
import { connectionDefaults, pairingConnection } from './connection-mode.mjs';
import css from './style.css';
import { deviceIcon } from './device-state.mjs';
import { DeviceLoading } from './device-loading.jsx';
import { Button as SharedButton } from '../../shared/client/ui/button.jsx';
import { Disclosure } from '../../shared/client/ui/collapsible.jsx';


export function useLinkStyle() {
  useEffect(() => { if (document.getElementById('dsh-link-style')) return; const node = document.createElement('style'); node.id = 'dsh-link-style'; node.textContent = css; document.head.append(node); return () => node.remove(); }, []);
}
export function Button({ children, icon, onClick, disabled, kind = 'quiet', type = 'button', className = '' }) {
  return <SharedButton type={type} variant={kind === 'primary' ? 'default' : 'ghost'} className={`link-button link-button-${kind} ${className}`.trim()} onClick={onClick} disabled={disabled}>{icon && <UIIcon name={icon} size={16} />}{children}</SharedButton>;
}
export function StatusDot({ state }) { return <span className={`link-status-dot link-status-${state}`} aria-hidden="true" />; }
export function ErrorText({ children }) { return children ? <p className="link-error" role="alert">{children}</p> : null; }

export function LinkSettings({ ctx, management = call, embedded = false, refreshToken = 0, detailsTarget = null }) {
  useLinkStyle();
  const defaults = useRef(connectionDefaults(globalThis.location)).current;
  const [status, setStatus] = useState(null), [error, setError] = useState(''), [pairing, setPairing] = useState(null);
  const [form, setForm] = useState({ host: '0.0.0.0', port: 48721, publicUrl: defaults.publicUrl });
  const [busy, setBusy] = useState(''), [lanAddress, setLanAddress] = useState('');
  const [statusError, setStatusError] = useState(''), [loading, setLoading] = useState(true), [diagnostic, setDiagnostic] = useState('');
  const [editingDevice, setEditingDevice] = useState(null);
  const renamingDevice = useRef(false), composingDeviceName = useRef(false);
  const request = useRef(0), initialized = useRef(false), retryPolling = useRef(null);
  const applyStatus = (value, syncForm = false) => {
    setStatus(value);
    if (!value.enabled) setPairing(null);
    if (syncForm || !initialized.current) {
      setForm({ host: value.host || '0.0.0.0', port: value.port ?? 48721, publicUrl: value.publicUrl || defaults.publicUrl });
      initialized.current = true;
    }
  };
  const refresh = async (syncForm = false, signal) => {
    const id = ++request.current, value = await management('status', {}, signal);
    if (id === request.current) { applyStatus(value, syncForm); setStatusError(''); setDiagnostic(''); setLoading(false); }
    return value;
  };
  useEffect(() => {
    const controller = new AbortController(); let timer;
    const poll = async () => {
      let succeeded = false;
      try { await refresh(false, controller.signal); succeeded = true; }
      catch (e) { if (!controller.signal.aborted) { setStatusError(e.message); setDiagnostic(e.detail || ''); setLoading(false); setPairing(null); } }
      finally { if (!controller.signal.aborted && succeeded) timer = setTimeout(poll, pairing ? 1_500 : 10_000); }
    };
    const retry = async () => { clearTimeout(timer); await poll(); };
    retryPolling.current = retry;
    poll(); return () => { retryPolling.current = null; controller.abort(); clearTimeout(timer); };
  }, [refreshToken, !!pairing]);
  useEffect(() => { if (lanAddress && !status?.addresses?.includes(lanAddress)) setLanAddress(''); }, [status?.addresses, lanAddress]);
  const saveConfig = async (input, syncForm = false) => {
    setPairing(null);
    const value = await management('configure', input);
    ++request.current; applyStatus(value, syncForm);
    return value;
  };
  const configure = async event => { event.preventDefault(); setBusy('saving'); setError(''); try { await saveConfig({ ...form, port: Number(form.port) }, true); } catch (e) { setError(e.message); } finally { setBusy(''); } };
  const beginPairing = async () => {
    if (loading || !status || statusError) return;
    setBusy('pairing'); setError(''); setPairing(null);
    try {
      const { mode, publicUrl } = pairingConnection(status, defaults);
      const current = !status.enabled || (mode === 'public' && status.publicUrl !== publicUrl) ? await saveConfig({ enabled: true, ...(mode === 'public' && publicUrl ? { publicUrl } : {}) }) : status;
      const address = mode === 'lan' && current.addresses?.includes(lanAddress) ? lanAddress : '';
      setPairing(await management('pairing', { mode, ...(address ? { address } : {}) }));
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const confirm = async (id, action) => { setBusy(action); setError(''); try { const value = await management(action, { id }); ++request.current; applyStatus(value); } catch (e) { setError(e.message); } finally { setBusy(''); } };
  const renameDevice = async event => {
    event.preventDefault();
    if (busy || renamingDevice.current || composingDeviceName.current || !editingDevice?.name.trim()) return;
    renamingDevice.current = true;
    setBusy('rename-device'); setError('');
    try { const value = await management('rename-device', { id: editingDevice.id, name: editingDevice.name.trim() }); ++request.current; applyStatus(value); setEditingDevice(null); }
    catch (e) { setError(e.message); } finally { renamingDevice.current = false; setBusy(''); }
  };
  const cancelDeviceRename = () => { if (!busy && !renamingDevice.current) { setEditingDevice(null); composingDeviceName.current = false; setError(''); } };
  const deviceNameKeyDown = event => {
    if (event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229 || composingDeviceName.current) { if (event.key === 'Enter') event.preventDefault(); return; }
    if (event.key === 'Enter') return renameDevice(event);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelDeviceRename(); }
  };
  const refreshStatus = async () => { setBusy('refresh'); setLoading(true); setError(''); try { if (retryPolling.current) await retryPolling.current(); else await refresh(); } catch (e) { setStatusError(e.message); setDiagnostic(e.detail || ''); setPairing(null); } finally { setBusy(''); setLoading(false); } };
  const unavailable = !!busy || loading || !status || !!statusError;
  if (loading && !status && !statusError) return <section className="link-settings"><DeviceLoading label="正在读取连接状态…" skeleton /></section>;
  const pairButton = <Button kind="primary" icon="scan" onClick={beginPairing} disabled={unavailable}>{busy === 'pairing' ? '正在准备…' : '生成连接信息'}</Button>;
  const details = <>
    <Disclosure className="link-advanced" title="高级设置">
      <form className="link-form" onSubmit={configure}>
        <label className="link-field"><span>监听地址</span><input value={form.host} onChange={e => setForm(v => ({ ...v, host: e.target.value }))} placeholder="0.0.0.0" disabled={unavailable} /></label>
        <label className="link-field"><span>端口</span><input inputMode="numeric" value={form.port} onChange={e => setForm(v => ({ ...v, port: e.target.value }))} disabled={unavailable} /></label>
        <label className="link-field link-field-wide"><span>公网 HTTPS 地址 <small>可选，需自行配置有效证书，并确保手机可以访问。</small></span><input value={form.publicUrl} onChange={e => setForm(v => ({ ...v, publicUrl: e.target.value }))} placeholder="https://desk.example.com" disabled={unavailable} /></label>
        <div className="link-form-actions"><Button kind="primary" icon="check" disabled={unavailable} type="submit">{busy === 'saving' ? '正在保存…' : '保存高级设置'}</Button></div>
      </form>
      {pairingConnection(status, defaults).mode === 'lan' && status?.addresses?.length > 1 && <div className="link-advanced-controls"><label className="link-field"><span>手动指定连接地址 <small>通常保持自动即可；连接失败时再尝试其他地址。</small></span><Select aria-label="局域网地址" value={lanAddress} disabled={unavailable} onChange={e => { setLanAddress(e.target.value); setPairing(null); }}><option value="">自动选择地址</option>{status.addresses.map(address => <option key={address} value={address}>{address}</option>)}</Select></label></div>}
      <div className="link-diagnostics"><div className="link-panel-head"><h4>连接诊断</h4><Button icon="refresh" onClick={refreshStatus} disabled={!!busy}>{busy === 'refresh' ? '正在刷新…' : '刷新状态'}</Button></div><p>Link 运行在哪台电脑，就连接哪台电脑。云服务器不属于手机本地局域网，请使用受信任的 HTTPS 地址；本地连接失败时，检查同一 Wi-Fi、网络隔离和电脑防火墙。</p>{status?.relay?.configured && <p role="status">自有中继：{status.relay.connected ? '主机通道已连接（需从访问端验证可达性）' : status.relay.lastError || '正在连接…'}</p>}<div className="link-addresses">{(status?.addresses || []).map(address => <code key={address}>{address}</code>)}{status?.publicUrl && <code>{status.publicUrl}</code>}{status && !status.addresses?.length && <span>未发现可用连接地址，请检查网络或指定监听地址。</span>}</div></div>
    </Disclosure>
    {!!status?.pending?.length && !pairing && <div className="link-pending-list">{status.pending.map(device => <div className="link-device" key={device.id}><div><strong>{device.name || '新设备'}</strong><small>请求连接工作台</small></div><Button kind="primary" icon="check" className="link-button-success" onClick={() => confirm(device.id, 'confirm')} disabled={unavailable}>允许</Button><Button icon="close" className="link-button-danger" onClick={() => confirm(device.id, 'reject')} disabled={unavailable}>拒绝</Button></div>)}</div>}
    <div className="link-device-list"><div className="link-panel-head"><div><h3>已授权访问此设备</h3></div><span>{status ? `${status.devices?.length || 0} 台` : '—'}</span></div>{status?.devices?.length ? status.devices.map(device => <div className="link-device" key={device.id}><UIIcon name={deviceIcon(device)} size={18} /><div className="link-authorized-device-info">
      {editingDevice?.id === device.id ? <form className="link-device-rename" onSubmit={renameDevice}>
        <input aria-label="设备备注名称" autoFocus value={editingDevice.name} maxLength={100} disabled={unavailable} onFocus={event => event.currentTarget.select()} onChange={event => setEditingDevice(value => ({ ...value, name: event.target.value }))} onCompositionStart={() => { composingDeviceName.current = true; }} onCompositionEnd={() => { composingDeviceName.current = false; }} onKeyDown={deviceNameKeyDown} />
        <button type="button" className="link-name-action link-name-cancel" title="取消修改" aria-label="取消修改设备备注" onClick={cancelDeviceRename} disabled={unavailable}><UIIcon name="close" size={15} /></button>
        <button type="submit" className="link-name-action link-name-confirm" title="保存备注" aria-label="保存设备备注" disabled={unavailable || !editingDevice.name.trim()}><UIIcon name="check" size={15} /></button>
      </form> : <div className="link-device-name"><strong>{device.name || '未命名设备'}</strong><button type="button" className="link-name-action" title="编辑备注" aria-label="编辑设备备注" onClick={() => { composingDeviceName.current = false; setEditingDevice({ id: device.id, name: device.name || '' }); setError(''); }} disabled={unavailable}><UIIcon name="edit" size={14} /></button></div>}
      <small>最近连接 {formatTime(device.lastSeenAt)}</small>
    </div><Button icon="trash" className="link-button-danger" onClick={() => confirm(device.id, 'revoke')} disabled={unavailable}>撤销</Button></div>) : <p className="link-empty">{loading ? '正在连接…' : statusError ? '暂不可用' : '还没有配对设备'}</p>}</div>
  </>;
  return <section className={`link-settings${embedded ? ' link-settings-embedded' : ''}`} aria-label="Link 远程连接">
    {!embedded && <div className="link-heading"><h2>允许其他设备连接</h2></div>}
    <div className="link-status-panel"><div className="link-panel-head">{!embedded && <h3>{status?.hostName || globalThis.location?.hostname || '本机工作台'}</h3>}<div className="link-host-actions link-connection-controls">{statusError && <Button icon="refresh" onClick={refreshStatus} disabled={!!busy}>{loading ? '重试中…' : '重试'}</Button>}{embedded && pairButton}</div></div></div>
    {!embedded && <div className="link-pair-row">{pairButton}</div>}
    <ErrorText>{error || statusError || status?.error}</ErrorText>
    {diagnostic && <Disclosure className="link-error-detail" title="查看详情"><p>{diagnostic}</p></Disclosure>}
    {detailsTarget ? createPortal(details, detailsTarget) : details}
    {pairing && <PairingDialog pairing={pairing} pending={status?.pending || []} onClose={() => setPairing(null)} onConfirm={confirm} busy={busy} error={error} />}
  </section>;
}
export function PairingDialog({ pairing, pending = [], onClose, onConfirm, busy, error }) {
  const dialog = useRef(null), approval = useRef(null), controls = useRef(null);
  const titleId = useId(), warningId = useId(), approvalTitleId = useId(), approvalDescriptionId = useId();
  const [feedback, setFeedback] = useState(null);
  const [dismissedPending, setDismissedPending] = useState('');
  const pendingKey = JSON.stringify(pending.map(device => device.id));
  const approvalOpen = pending.length > 0 && dismissedPending !== pendingKey;
  const dismissApproval = () => { if (!busy) setDismissedPending(pendingKey); };
  controls.current = { approvalOpen, busy, close: approvalOpen ? dismissApproval : onClose };
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector('button')?.focus();
    const keydown = event => {
      if (event.isComposing || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat && !controls.current.busy) controls.current.close();
      }
      const activeDialog = controls.current.approvalOpen ? approval.current : dialog.current;
      if (event.key === 'Tab' && activeDialog) {
        // This is a body portal above the settings modal; keep its keyboard
        // listener from pulling focus back into the settings behind it.
        event.stopPropagation();
        const elements = [...activeDialog.querySelectorAll('button:not(:disabled), a[href], summary, [tabindex="0"]')].filter(element => !element.closest('details:not([open])') || element.tagName === 'SUMMARY');
        const first = elements[0] || activeDialog, last = elements.at(-1) || first;
        if (!activeDialog.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault(); (event.shiftKey ? last : first).focus();
        }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => { document.removeEventListener('keydown', keydown, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    if (!approvalOpen) return;
    const previous = document.activeElement;
    (approval.current?.querySelector('button:not(:disabled)') || approval.current)?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [approvalOpen]);
  const publicPairing = pairing.mode === 'public' || pairing.mode === 'relay';
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(pairing.uri);
      setFeedback({ ok: true, text: '连接信息已复制' });
    } catch { setFeedback({ ok: false, text: '复制失败，请检查浏览器剪贴板权限后重试。' }); }
  };
  return createPortal(<><div className="link-dialog-backdrop" role="presentation" aria-hidden={approvalOpen || undefined} inert={approvalOpen ? '' : undefined} onClick={event => { if (!approvalOpen && !busy && event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="link-dialog link-pair-dialog" role="dialog" aria-modal={approvalOpen ? undefined : 'true'} aria-labelledby={titleId} aria-describedby={warningId} tabIndex={-1}>
      <button type="button" className="link-dialog-close" onClick={onClose} aria-label="关闭配对窗口"><UIIcon name="close" size={20} /></button>
      <h3 id={titleId} className="link-pair-title"><UIIcon name="scan" size={20} />连接此设备</h3>
      <PairQr value={publicPairing ? pairing.webUrl : pairing.uri} size={224} />
      <small className="link-expiry">有效期至 {formatTime(pairing.expiresAt)}</small>
      <p id={warningId} className="link-pair-warning">仅授权你信任的设备，不要分享此二维码。</p>
      <Button icon="copy" onClick={copy}>复制连接信息</Button>
      <p className={feedback?.ok === false ? 'link-copy-feedback link-error' : 'link-copy-feedback'} role="status" aria-live="polite">{feedback?.text || ''}</p>
      {!approvalOpen && <ErrorText>{error}</ErrorText>}
      {!!pending.length && <div className="link-pair-requests"><Button kind="primary" icon="devices" onClick={() => setDismissedPending('')} disabled={!!busy}>查看连接请求（{pending.length}）</Button></div>}
    </div>
  </div>{approvalOpen && <div className="link-dialog-backdrop link-approval-backdrop" role="presentation" onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) dismissApproval(); }}>
    <div ref={approval} className="link-dialog link-approval-dialog" role="alertdialog" aria-modal="true" aria-labelledby={approvalTitleId} aria-describedby={approvalDescriptionId} aria-busy={!!busy} tabIndex={-1}>
      <button type="button" className="link-dialog-close" onClick={dismissApproval} disabled={!!busy} aria-label="暂时关闭连接请求"><UIIcon name="close" size={20} /></button>
      <span className="link-dialog-symbol"><UIIcon name="devices" size={24} /></span>
      <h3 id={approvalTitleId}>允许设备连接？</h3>
      <p id={approvalDescriptionId}>仅允许你认识并信任的设备访问此工作台。</p>
      <div className="link-pending-list">{pending.map(device => <div className="link-device" key={device.id}>
        <UIIcon name={deviceIcon(device)} size={20} /><div className="link-device-info"><strong>{device.name || '新设备'}</strong><small>请求连接工作台</small></div>
        <div className="link-device-actions"><Button icon="close" className="link-button-danger" onClick={() => onConfirm(device.id, 'reject')} disabled={!!busy}>{busy === 'reject' ? '正在拒绝…' : '拒绝'}</Button><Button kind="primary" icon="check" className="link-button-success" onClick={() => onConfirm(device.id, 'confirm')} disabled={!!busy}>{busy === 'confirm' ? '正在允许…' : '允许'}</Button></div>
      </div>)}</div>
      <ErrorText>{error}</ErrorText>
    </div>
  </div>}</>, document.body);
}

function formatTime(value) { if (!value) return '刚刚'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
