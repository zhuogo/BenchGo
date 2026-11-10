import { Loading } from './ui/loading.jsx';
import React, { useEffect, useId, useRef, useState } from 'react';
import { readJsonResponse } from '../../benchgo/client/http-response.mjs';
import { CustomSelect } from './custom-select.jsx';
import css from './vault-settings.css';
import { Button } from './ui/index.jsx';
import { ResourceIcon } from './resource-icon.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';

const empty = () => ({ label: '', kind: 'key', target: '', method: 'POST', placement: 'header', field: 'Authorization', prefix: 'bearer' });
async function api(action, input = {}, signal) {
  const url = new URL('api/benchgo/vault', document.baseURI);
  const response = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...input }), signal });
  return readJsonResponse(response, url);
}

export function VaultSettingsSection({ onDirtyChange } = {}) {
  const [entries, setEntries] = useState([]), [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const secret = useRef(), name = useRef(), addButton = useRef(), returnFocus = useRef(), focusAfterSave = useRef(false), restoreFocus = useRef(false);
  const lifetime = useRef(), operation = useRef();
  const fieldId = useId();
  useEffect(() => { onDirtyChange?.(!!draft); return () => onDirtyChange?.(false); }, [!!draft, onDirtyChange]);
  const focus = element => { if (element?.isConnected && element.getClientRects().length) { element.focus({ preventScroll: true }); element.scrollIntoView({ block: 'center', inline: 'nearest' }); } };
  useEffect(() => {
    if (draft) focus(draft.handle ? secret.current : name.current);
  }, [!!draft, draft?.handle]);
  useEffect(() => {
    if (busy) return;
    if (draft && focusAfterSave.current) { focusAfterSave.current = false; focus(secret.current); }
    if (!draft && restoreFocus.current) { restoreFocus.current = false; focus(returnFocus.current?.isConnected ? returnFocus.current : addButton.current); }
  }, [busy, !!draft]);
  const refresh = async signal => { const value = await api('list', {}, signal); if (!signal.aborted) setEntries(value.entries || []); };
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    refresh(controller.signal).catch(failure => { if (!controller.signal.aborted) setError(failure?.message || '无法载入保险库，请重试'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); operation.current?.abort(); };
  }, []);
  const run = async (work, message = '', closeEditor = false) => {
    if (operation.current || lifetime.current?.signal.aborted) return;
    const controller = new AbortController(); operation.current = controller;
    const { signal } = controller;
    setBusy(true); setLoading(!entries.length); setError(''); setNotice('');
    try {
      await work(signal); if (signal.aborted) return;
      if (closeEditor) { restoreFocus.current = true; setDraft(null); }
      await refresh(signal); if (!signal.aborted) setNotice(message);
    }
    catch (failure) {
      if (signal.aborted) return;
      setError(failure?.message || '保险库操作失败'); focusAfterSave.current = closeEditor;
      try { await refresh(signal); } catch {}
    }
    finally { if (operation.current === controller) operation.current = null; if (!signal.aborted) { setBusy(false); setLoading(false); } }
  };
  const save = event => {
    if (busy || operation.current) { event.preventDefault(); return; }
    event.preventDefault(); const value = secret.current.value; secret.current.value = '';
    run(signal => api('save', { ...draft, secret: value }, signal), '凭据已保存，助手仅可使用绑定目标', true);
  };
  const change = patch => setDraft(value => ({ ...value, ...patch }));
  const pending = busy || loading;
  const retry = () => run(async () => {});
  const edit = (next, trigger) => { returnFocus.current = trigger; focusAfterSave.current = false; setDraft(next); setNotice(''); setError(''); };
  const cancel = () => { if (secret.current) secret.current.value = ''; restoreFocus.current = true; setDraft(null); setError(''); };
  const errorView = error && <div id={`${fieldId}-error`} role="alert" className={`bg-vault-error${!entries.length && !draft ? ' bg-vault-error-empty' : ''}`}><ResourceIcon name="key" size={22} /><div><strong>保险库操作未完成</strong><p>{error}</p>{draft && <small>编辑内容已保留；保存凭据失败时，请重新输入密钥。</small>}</div></div>;
  return <section className="bg-vault" aria-label="BenchGo 保险库"><style>{css}</style>
    <header className="bg-vault-toolbar">
      <h1>保险库{!loading && !!entries.length && <span aria-label={`${entries.length} 份凭据`}>{entries.length}</span>}</h1>
      <div className="bg-vault-actions">
        <Button variant="ghost" className="bg-vault-quiet" disabled={pending} onClick={retry}><UIIcon name="refresh" size={16} />{busy ? '处理中…' : error ? '重试' : '刷新'}</Button>
        <Button ref={addButton} className="bg-vault-primary" disabled={pending || !!draft} onClick={event => edit(empty(), event.currentTarget)}><UIIcon name="plus" size={16} />添加凭据</Button>
      </div>
    </header>
    {!draft && errorView}{notice && <p role="status" className="bg-vault-notice"><span aria-hidden="true" />{notice}</p>}
    {loading && !draft && <Loading className="bg-vault-loading" label="正在加载凭据" />}
    {!loading && !error && !entries.length && !draft && <div className="bg-vault-empty"><div className="bg-vault-empty-icon"><ResourceIcon name="key" size={30} /></div><strong>还没有凭据</strong><p>通过右上角添加，供助手在授权范围内使用。</p></div>}
    {!!entries.length && <ul className="bg-vault-list" aria-busy={busy}>{entries.map(entry => { const updated = entry.updatedAt ? new Date(entry.updatedAt) : null; const hasTime = updated && !Number.isNaN(updated.getTime()); return <li key={entry.handle}><div className="bg-vault-entry-icon"><ResourceIcon name="key" size={20} /></div><div className="bg-vault-entry-content"><div className="bg-vault-entry-title"><strong>{entry.label}</strong><span className="bg-vault-kind">{entry.kind === 'otp' ? '一次性验证码' : entry.kind === 'password' ? '密码' : 'API Key'}</span><span className="bg-vault-status" data-available={entry.available !== false}><i aria-hidden="true" />{entry.available === false ? '已过期' : '可使用'}</span></div><small className="bg-vault-target"><span>{entry.method}</span>{entry.target}</small><small>{entry.placement === 'header' ? '请求头' : entry.placement === 'json' ? 'JSON 字段' : '表单字段'} · {entry.field}{entry.kind === 'otp' ? entry.available ? ' · 5 分钟内仅用一次' : ' · 请更新验证码' : ''}</small>{hasTime && <time dateTime={updated.toISOString()}>更新于 {updated.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>}</div><div className="bg-vault-actions"><Button variant="outline" disabled={pending || !!draft} onClick={event => edit({ ...entry }, event.currentTarget)}>更新</Button><Button variant="ghost" className="bg-vault-remove" disabled={pending || !!draft} onClick={() => run(signal => api('remove', { handle: entry.handle, revision: entry.revision }, signal), '凭据已移除')}>移除</Button></div></li>; })}</ul>}
    {draft && <form className="bg-vault-editor" onSubmit={save}>
      <div className="bg-vault-editor-heading"><ResourceIcon name="key" size={20} /><h2>{draft.handle ? '更新凭据' : '新凭据'}</h2></div>
      <fieldset className="bg-vault-group" disabled={busy}>
      <legend>凭据信息</legend>
      <div className="bg-vault-fields">
        <label>名称<input ref={name} required maxLength={120} value={draft.label} onChange={event => change({ label: event.target.value })} /></label>
        <label>凭据类型<CustomSelect aria-label="凭据类型" value={draft.kind} onChange={kind => change({ kind })} options={[{ value: 'key', label: 'API Key' }, { value: 'password', label: '密码' }, { value: 'otp', label: '一次性验证码' }]} /></label>
        {error && <div className="bg-vault-wide">{errorView}</div>}
        <label className="bg-vault-wide">{draft.handle ? '重新输入凭据' : '凭据'}<input ref={secret} type="password" required maxLength={16384} autoComplete="new-password" aria-describedby={`${fieldId}-help${error ? ` ${fieldId}-error` : ''}`} /><small id={`${fieldId}-help`}>保存后不可查看明文；更新凭据时必须重新输入。</small></label>
      </div>
      </fieldset>
      <fieldset className="bg-vault-group" disabled={busy}>
      <legend>请求绑定</legend>
      <div className="bg-vault-fields">
        <label className="bg-vault-wide">完整目标地址<input required type="url" placeholder="https://example.com/api/action" value={draft.target} onChange={event => change({ target: event.target.value })} /><small>仅允许 HTTPS，不含查询参数；此凭据仅能用于该地址。</small></label>
        <label>请求方法<CustomSelect aria-label="请求方法" value={draft.method} onChange={method => change({ method, ...(method === 'GET' ? { placement: 'header' } : {}) })} options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(method => ({ value: method, label: method }))} /></label>
        <label>代填位置<CustomSelect aria-label="代填位置" value={draft.placement} onChange={placement => change({ placement, ...(placement !== 'header' ? { prefix: 'none' } : {}) })} options={[{ value: 'header', label: '请求头' }, { value: 'json', label: 'JSON 字段', disabled: draft.method === 'GET' }, { value: 'form', label: '表单字段', disabled: draft.method === 'GET' }]} /></label>
        <label>字段名称<input required maxLength={101} value={draft.field} onChange={event => change({ field: event.target.value })} /></label>
        <label>凭据前缀<CustomSelect aria-label="凭据前缀" disabled={draft.placement !== 'header'} value={draft.prefix} onChange={prefix => change({ prefix })} options={[{ value: 'none', label: '无' }, { value: 'bearer', label: 'Bearer' }]} /></label>
      </div>
      </fieldset>
      <footer className="bg-vault-editor-footer"><span>密钥不会以明文显示</span><div className="bg-vault-actions"><Button variant="ghost" disabled={busy} type="button" onClick={cancel}>取消</Button><Button disabled={busy} className="bg-vault-primary" type="submit">{busy ? '保存中…' : '保存目标绑定'}</Button></div></footer>
    </form>}
  </section>;
}
