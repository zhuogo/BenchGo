import { Loading } from './ui/loading.jsx';
import React, { useEffect, useId, useRef, useState } from 'react';
import { readJsonResponse } from '../../benchgo/client/http-response.mjs';
import css from './vault-settings.css';
import { Button } from './ui/index.jsx';
import { ResourceIcon } from './resource-icon.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';

const credential = () => ({ key: crypto.randomUUID(), name: '' });
const empty = () => ({ address: '', credentials: [credential()] });
async function api(action, input = {}, signal) {
  const url = new URL('api/benchgo/vault', document.baseURI);
  const response = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...input }), signal });
  return readJsonResponse(response, url);
}

export function VaultSettingsSection({ onDirtyChange } = {}) {
  const [entries, setEntries] = useState([]), [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const secrets = useRef(new Map()), name = useRef(), addButton = useRef(), returnFocus = useRef(), focusAfterSave = useRef(false), restoreFocus = useRef(false);
  const lifetime = useRef(), operation = useRef();
  const fieldId = useId();
  useEffect(() => { onDirtyChange?.(!!draft); return () => onDirtyChange?.(false); }, [!!draft, onDirtyChange]);
  const focus = element => { if (element?.isConnected && element.getClientRects().length) { element.focus({ preventScroll: true }); element.scrollIntoView({ block: 'center', inline: 'nearest' }); } };
  useEffect(() => {
    if (draft) focus(draft.handle ? secrets.current.values().next().value : name.current);
  }, [!!draft, draft?.handle]);
  useEffect(() => {
    if (busy) return;
    if (draft && focusAfterSave.current) { focusAfterSave.current = false; focus(secrets.current.values().next().value); }
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
    event.preventDefault();
    const credentials = draft.credentials.map(item => {
      const value = secrets.current.get(item.id || item.key)?.value;
      return { ...(item.id ? { id: item.id } : {}), name: item.name, ...(value ? { value } : {}) };
    });
    run(signal => api('save', { handle: draft.handle, revision: draft.revision, address: draft.address, credentials }, signal), '凭据已加密保存', true);
  };
  const change = patch => setDraft(value => ({ ...value, ...patch }));
  const pending = busy || loading;
  const retry = () => run(async () => {});
  const edit = (next, trigger) => { returnFocus.current = trigger; focusAfterSave.current = false; setDraft(next); setNotice(''); setError(''); };
  const cancel = () => { for (const input of secrets.current.values()) input.value = ''; restoreFocus.current = true; setDraft(null); setError(''); };
  const errorView = error && <div id={`${fieldId}-error`} role="alert" className={`bg-vault-error${!entries.length && !draft ? ' bg-vault-error-empty' : ''}`}><ResourceIcon name="key" size={22} /><div><strong>保险库操作未完成</strong><p>{error}</p>{draft && <small>编辑内容已保留，请重试。若凭据已在其他页面变更，请取消后重新编辑。</small>}</div></div>;
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
    {!loading && !error && !entries.length && !draft && <div className="bg-vault-empty"><div className="bg-vault-empty-icon"><ResourceIcon name="key" size={30} /></div><strong>还没有凭据</strong><p>通过右上角添加，将同一网站或服务的账号、密码等放在一起。</p></div>}
    {!!entries.length && <ul className="bg-vault-list" aria-busy={busy}>{entries.map(entry => { const updated = entry.updatedAt ? new Date(entry.updatedAt) : null; const hasTime = updated && !Number.isNaN(updated.getTime()); return <li key={entry.handle}><div className="bg-vault-entry-icon"><ResourceIcon name="key" size={20} /></div><div className="bg-vault-entry-content"><div className="bg-vault-entry-title"><strong>{entry.address}</strong><span className="bg-vault-kind">{entry.credentials.length} 项凭证</span><span className="bg-vault-status" data-available="true"><i aria-hidden="true" />已保存</span></div><small>{entry.credentials.map(item => item.name).join(' · ')}</small>{hasTime && <time dateTime={updated.toISOString()}>更新于 {updated.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>}</div><div className="bg-vault-actions"><Button variant="outline" disabled={pending || !!draft} onClick={event => edit({ ...entry }, event.currentTarget)}>更新</Button><Button variant="ghost" className="bg-vault-remove" disabled={pending || !!draft} onClick={() => run(signal => api('remove', { handle: entry.handle, revision: entry.revision }, signal), '凭据已移除')}>移除</Button></div></li>; })}</ul>}
    {draft && <form className="bg-vault-editor" onSubmit={save}>
      <div className="bg-vault-editor-heading"><ResourceIcon name="key" size={20} /><h2>{draft.handle ? '更新凭据' : '新凭据'}</h2></div>
      <fieldset className="bg-vault-group" disabled={busy}>
        <div className="bg-vault-fields">
          <label className="bg-vault-wide">地址或名称<input ref={name} required maxLength={2048} placeholder="网站链接、服务名或设备名" value={draft.address} onChange={event => change({ address: event.target.value })} /><small>用于识别条目，请勿在这里填写秘密。</small></label>
          {error && <div className="bg-vault-wide">{errorView}</div>}
        </div>
      </fieldset>
      <fieldset className="bg-vault-group" disabled={busy}>
        <legend>自定义凭证</legend>
        <p id={`${fieldId}-help`}>值仅加密保存，不向聊天或模型公开。已有凭证留空即保留原值。</p>
        <div className="bg-vault-credentials">{draft.credentials.map((item, index) => {
          const key = item.id || item.key;
          return <div key={key} className="bg-vault-credential">
            <label>凭证名称 {index + 1}<input required maxLength={120} placeholder="例如：账号、密码、密钥" value={item.name} onChange={event => change({ credentials: draft.credentials.map(value => value === item ? { ...value, name: event.target.value } : value) })} /></label>
            <label>凭证值 {index + 1}<textarea ref={element => { if (element) secrets.current.set(key, element); else secrets.current.delete(key); }} required={!item.id} maxLength={16384} autoComplete="off" spellCheck={false} className="bg-vault-secret" aria-describedby={`${fieldId}-help${error ? ` ${fieldId}-error` : ''}`} aria-label={`凭证值 ${index + 1}`} placeholder={item.id ? '已保存；留空保留，输入替换' : '输入凭证值'} /></label>
            <Button variant="ghost" className="bg-vault-remove" disabled={draft.credentials.length === 1} aria-label={`移除凭证 ${index + 1}`} onClick={() => change({ credentials: draft.credentials.filter(value => value !== item) })}>移除</Button>
          </div>;
        })}</div>
        <Button variant="ghost" disabled={draft.credentials.length >= 50} onClick={() => change({ credentials: [...draft.credentials, credential()] })}><UIIcon name="plus" size={16} />添加一项凭证</Button>
      </fieldset>
      <footer className="bg-vault-editor-footer"><span>保存不代表已接通浏览器登录</span><div className="bg-vault-actions"><Button variant="ghost" disabled={busy} type="button" onClick={cancel}>取消</Button><Button disabled={busy} className="bg-vault-primary" type="submit">{busy ? '保存中…' : '保存凭据'}</Button></div></footer>
    </form>}
  </section>;
}
