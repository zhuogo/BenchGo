import React, { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../shared/client/ui/button.jsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../../shared/client/ui/dialog.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import css from './action-permissions.css';

const categoryNames = { login: '登录', 'private-upload': '上传私有内容' };
const phaseNames = { created: '已创建', granted: '已授权', revoked: '已撤销', 'grant-created': '已创建站点许可', 'grant-revoked': '已撤销站点许可', prepared: '待审批', approved: '已批准单次', denied: '已拒绝', submitted: '已提交', completed: '已完成', uncertain: '效果待核实', matched: '许可已匹配' };
const stamp = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未记录';
const actorName = actor => actor?.label || actor?.id || '已认证授权人';
const localDate = value => { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
const requestId = () => globalThis.crypto?.randomUUID?.() || `permission-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const grantStatus = (grant, now) => grant.revokedAt ? '已撤销' : Date.parse(grant.expiresAt) > now ? '有效' : '已过期';

function permissionOrigin(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('请输入完整站点，例如 https://example.com。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('站点只填写协议、主机和端口，不包含路径、查询、片段或凭据。');
  return url.origin;
}

function PermissionState({ state, error, filtered, hasHistory }) {
  const loading = state === 'loading', failed = state === 'error';
  return <div className="ba-permission-placeholder" role={failed ? 'alert' : 'status'} aria-busy={loading}>
    <span className="ba-permission-placeholder-icon"><UIIcon name={loading ? 'refresh' : failed ? 'close' : 'link'} size={26} /></span>
    <strong>{loading ? '正在读取授权' : failed ? '授权暂时无法读取' : filtered === 'history' ? '暂无历史许可' : filtered === 'active' ? '暂无有效许可' : '还没有站点许可'}</strong>
    <p>{loading ? '正在同步站点、动作类别和有效期限。' : failed ? error : filtered === 'history' ? '过期或撤销的许可会保留在这里。' : hasHistory ? '以往许可已过期或撤销，可切换到历史许可查看。' : '可为明确站点的登录或私有内容上传设置有效期。'}</p>
    {loading && <div className="ba-permission-skeleton" aria-hidden="true"><span /><span /><span /></div>}
  </div>;
}

/** Presentational surface also used to inspect the four real browser states. */
export function ActionPermissionsView({ state = 'data', grants = [], audit = [], error = '', loadError = '', busy = false, creating = false, notice = '', onRetry, onCreate, onRevoke, createTriggerRef, now = Date.now(), children }) {
  const [filter, setFilter] = useState('active'), filterRef = useRef(null);
  const readable = !['loading', 'error'].includes(state), refreshing = state === 'refreshing', failed = ['error', 'stale'].includes(state);
  const active = grants.filter(grant => grantStatus(grant, now) === '有效'), history = grants.filter(grant => grantStatus(grant, now) !== '有效');
  const rows = filter === 'active' ? active : history;
  return <section className="ba-action-permissions" aria-label="授权管理">
    <style>{css}</style>
    <header className="ba-permission-header"><h2>授权管理</h2><div className="ba-permission-toolbar">
      <Dialog><DialogTrigger asChild><Button variant="ghost" aria-label="授权与动作记录" disabled={!readable}><UIIcon name="schedules" size={16} />动作记录</Button></DialogTrigger><DialogContent className="ba-permission-dialog ba-permission-audit-dialog" closeLabel="关闭记录">
        <DialogTitle>授权与动作记录</DialogTitle><DialogDescription>审批、许可使用与撤销记录。</DialogDescription>
        <div className="ba-permission-audit" tabIndex={0} aria-label="授权与动作记录列表">{audit.length ? <ol>{audit.map(item => <li key={item.id}><div><strong>{phaseNames[item.phase] || item.phase}</strong><time>{stamp(item.createdAt)}</time></div><p>{[item.origin, categoryNames[item.category] || item.category, item.actor ? actorName(item.actor) : null].filter(Boolean).join(' · ') || '已记录动作状态'}{item.actionId && <span className="ba-permission-audit-id">动作 {item.actionId}</span>}</p></li>)}</ol> : <p className="ba-permission-muted">尚无授权或动作记录。</p>}</div>
      </DialogContent></Dialog>
      <Button variant="ghost" disabled={busy || state === 'loading' || refreshing} onClick={onRetry}><UIIcon name="refresh" size={16} />{failed ? '重试' : refreshing ? '刷新中' : '刷新'}</Button>
      <Button ref={createTriggerRef} disabled={busy || !readable || refreshing || creating} onClick={() => { setFilter('active'); onCreate?.(); }}><UIIcon name="plus" size={16} />新建站点许可</Button>
    </div></header>
    <p className="ba-permission-boundary"><UIIcon name="check" size={18} /><span>站点许可仅覆盖登录与私有内容上传，高风险动作仍逐次审批。</span></p>
    {readable && <div className="ba-permission-filters" role="group" aria-label="许可状态">{[['active', '有效许可', active.length], ['history', '历史许可', history.length]].map(([key, label, count]) => <Button key={key} ref={filter === key ? filterRef : undefined} variant="ghost" aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}<span>{count}</span></Button>)}</div>}
    {readable && <div className="ba-permission-refresh-status" role={state === 'stale' ? 'alert' : 'status'}>{refreshing ? '正在刷新，当前显示上次读取的许可。' : state === 'stale' ? `刷新失败，当前显示上次读取的许可。${loadError}` : ''}</div>}
    {!readable || !rows.length ? <PermissionState state={readable ? 'empty' : state} error={loadError || error} filtered={readable && (filter === 'history' || grants.length) ? filter : undefined} hasHistory={history.length > 0} /> : <div className="ba-permission-list" aria-label="站点许可列表" aria-busy={refreshing}>
      {rows.map(grant => {
        const status = grantStatus(grant, now);
        return <article className="ba-permission-row" key={grant.id}>
          <div className="ba-permission-row-main"><div className="ba-permission-origin"><strong>{grant.origin}</strong><span className="ba-permission-status" data-state={status === '有效' ? 'active' : 'inactive'}>{status}</span></div>
            <div className="ba-permission-categories">{(grant.categories || []).map(category => <span key={category}>{categoryNames[category] || category}</span>)}</div>
            <p>到期 {stamp(grant.expiresAt)} · 授权人 {actorName(grant.actor)}</p><small>创建 {stamp(grant.createdAt)}{grant.revokedAt ? ` · 撤销 ${stamp(grant.revokedAt)}` : ''}</small>
          </div>
          {status === '有效' && <Button variant="destructive" size="sm" disabled={busy || refreshing} aria-label={`撤销 ${grant.origin} 的许可`} onClick={async () => { if (await onRevoke?.(grant.id)) filterRef.current?.focus({ preventScroll: true }); }}>撤销许可</Button>}
        </article>;
      })}
    </div>}
    {notice && <p className="ba-permission-notice" role="status">{notice}</p>}
    {error && !creating && <div className="ba-permission-error" role="alert"><UIIcon name="close" size={18} /><span>{error}</span></div>}
    {children}
  </section>;
}

export function ActionPermissions({ api }) {
  const [state, setState] = useState('loading'), [value, setValue] = useState({ grants: [], audit: [] });
  const [error, setError] = useState(''), [loadError, setLoadError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [creating, setCreating] = useState(false);
  const [origin, setOrigin] = useState(''), [categories, setCategories] = useState(['login']), [expiresAt, setExpiresAt] = useState(() => localDate(Date.now() + 7 * 86400_000));
  const generation = useRef(0), loaded = useRef(false), pendingCreate = useRef(null), pendingRevokes = useRef(new Map()), createTriggerRef = useRef(null), id = useId();
  async function load() {
    const serial = ++generation.current; setState(loaded.current ? 'refreshing' : 'loading'); setLoadError('');
    try {
      const next = await api('actionPermissions');
      if (generation.current !== serial) return;
      loaded.current = true; setValue({ grants: next.grants || [], audit: next.audit || [] }); setState('data');
    } catch (cause) { if (generation.current === serial) { setLoadError(cause.message || '读取授权失败，请重试。'); setState(loaded.current ? 'stale' : 'error'); } }
  }
  useEffect(() => { loaded.current = false; setValue({ grants: [], audit: [] }); void load(); return () => { generation.current++; }; }, [api]);
  const showCreate = () => { setCreating(true); };
  async function create(event) {
    event.preventDefault(); if (busy) return;
    setError(''); setNotice('');
    let input;
    try {
      const normalized = permissionOrigin(origin), expiry = new Date(expiresAt);
      if (!categories.length) throw new Error('请至少选择一个动作类别。');
      if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) throw new Error('有效期限必须晚于当前时间。');
      input = { origin: normalized, categories: [...categories].sort(), expiresAt: expiry.toISOString() };
    } catch (cause) { setError(cause.message); return; }
    const signature = JSON.stringify(input);
    if (pendingCreate.current?.signature !== signature) pendingCreate.current = { signature, requestId: requestId() };
    setBusy(true);
    try {
      const grant = await api('actionPermissionCreate', { ...input, requestId: pendingCreate.current.requestId });
      setValue(current => ({ ...current, grants: [grant, ...current.grants.filter(row => row.id !== grant.id)] }));
      pendingCreate.current = null; setOrigin(''); setNotice('站点许可已保存。高风险动作仍需逐次审批。'); await load(); setCreating(false);
    } catch (cause) { setError(cause.message || '许可未能保存，请重试。'); }
    finally { setBusy(false); }
  }
  async function revoke(grantId) {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    if (!pendingRevokes.current.has(grantId)) pendingRevokes.current.set(grantId, requestId());
    try {
      const revoked = await api('actionPermissionRevoke', { id: grantId, requestId: pendingRevokes.current.get(grantId) });
      setValue(current => ({ ...current, grants: current.grants.map(row => row.id === grantId ? { ...row, revokedAt: revoked.revokedAt } : row) }));
      pendingRevokes.current.delete(grantId); setNotice('许可已撤销，尚未提交的动作将重新校验授权。'); await load(); return true;
    } catch (cause) { setError(cause.message || '撤销失败，请重试。'); return false; }
    finally { setBusy(false); }
  }
  return <ActionPermissionsView {...value} state={state} busy={busy} creating={creating} error={error} loadError={loadError} notice={notice} onRetry={load} onCreate={showCreate} onRevoke={revoke} createTriggerRef={createTriggerRef}>
    <Dialog open={creating} onOpenChange={open => { if (!busy) { setCreating(open); setError(''); } }}><DialogContent className="ba-permission-dialog" closeLabel="关闭许可表单" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => event.preventDefault()} onCloseAutoFocus={event => { event.preventDefault(); createTriggerRef.current?.focus(); }}>
      <DialogTitle>新建站点许可</DialogTitle><DialogDescription>许可只适用于精确站点、所选动作和有效期限。支付或购买、修改密码、删除账号、另行对外发送始终逐次审批；此许可不会创建新任务。</DialogDescription>
      <form className="ba-permission-form" onSubmit={create} aria-label="新建站点许可">
      <fieldset disabled={busy || state === 'loading'}>
        <div className="ba-permission-field"><label htmlFor={`${id}-origin`}>精确站点</label><input id={`${id}-origin`} required type="url" value={origin} onChange={event => setOrigin(event.target.value)} placeholder="https://example.com:8443" autoComplete="off" aria-describedby={`${id}-origin-hint`} /><small id={`${id}-origin-hint`}>协议、主机与端口必须匹配；子域名和跳转后的其他站点不沿用许可。</small></div>
        <div className="ba-permission-category-fields"><span id={`${id}-categories`}>动作类别</span><div role="group" aria-labelledby={`${id}-categories`}>{Object.entries(categoryNames).map(([category, label]) => <label key={category}><input type="checkbox" checked={categories.includes(category)} onChange={event => setCategories(current => event.target.checked ? [...current, category] : current.filter(item => item !== category))} />{label}</label>)}</div></div>
        <label htmlFor={`${id}-expires`}>有效期限<input id={`${id}-expires`} type="datetime-local" required value={expiresAt} onChange={event => setExpiresAt(event.target.value)} /></label>
      </fieldset>{error && <div className="ba-permission-error" role="alert"><UIIcon name="close" size={18} /><span>{error}</span></div>}<footer><Button variant="ghost" disabled={busy} onClick={() => { setCreating(false); setError(''); }}>取消</Button><Button type="submit" disabled={busy || state === 'loading'}>{busy ? '正在保存…' : '保存许可'}</Button></footer>
    </form></DialogContent></Dialog>
  </ActionPermissionsView>;
}
