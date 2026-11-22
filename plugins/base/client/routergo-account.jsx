import React, { useEffect, useRef, useState } from 'react';
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import { Button } from '../../shared/client/ui/button.jsx';
import { isRouterGoAccountReference, routerGoAccountPath, routerGoOrigin, routerGoRecharge } from '../shared/routergo-account.mjs';
import { ProviderBrandIcon } from './provider-brand-icon.jsx';
import { UIIcon } from './iconsax.jsx';
import { Tooltip } from '../../shared/client/ui/tooltip.jsx';

const balanceFormat = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });

async function command(action, input = {}, signal = AbortSignal.timeout(45000)) {
  const url = new URL(routerGoAccountPath.slice(1), document.baseURI);
  const result = await fetch(url, {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...input }),
  });
  const body = await result.json().catch(() => null);
  if (!result.ok || !body) throw Object.assign(Error(body?.error || 'RouterGo 服务暂不可用，请重试'), { status: result.status, code: body?.code });
  return body;
}

export function RouterGoBrand() {
  return <a href={`${routerGoOrigin}/`} target="_blank" rel="noopener noreferrer" className="cmd-routergo-brand"
    aria-label="访问 RouterGo 官网（新窗口）">
    <ProviderBrandIcon id="routergo" name="RouterGo" size={34} />
    <span>RouterGo</span><UIIcon name="external" size={14} />
  </a>;
}

export function RouterGoAccount({ renderHeader, renderEditor, editorOpen, refreshProviders, writable, ready, onEdit, onSaved, configuredRef, available }) {
  const [access, setAccess] = useState(), [pending, setPending] = useState();
  const [busy, setBusy] = useState(''), [notice, setNotice] = useState(), [balanceError, setBalanceError] = useState(false);
  const [readingBalance, setReadingBalance] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);
  const alive = useRef(false), lastBalanceRead = useRef(0), balanceRequest = useRef();
  const activeSync = useRef(), lastSync = useRef(0);
  const openEditor = useRef(editorOpen);
  openEditor.current = editorOpen;
  const notify = (text, tone) => setNotice(previous => ({ text, tone, sequence: (previous?.sequence ?? 0) + 1 }));

  async function sync(force = false) {
    if (activeSync.current || (!force && (openEditor.current || Date.now() - lastSync.current < 60000))) return;
    const request = new AbortController();
    activeSync.current = request;
    lastSync.current = Date.now();
    setSyncing(true);
    try {
      const answer = await command('sync', { force }, AbortSignal.any([request.signal, AbortSignal.timeout(35000)]));
      if (request.signal.aborted) return;
      if (['synced', 'recent'].includes(answer.state)) {
        const { added, updated, removed } = answer;
        const changed = added || updated || removed;
        if (changed && (force || openEditor.current)) {
          await refreshProviders();
          if (request.signal.aborted) return;
          setEditorVersion(version => version + 1);
        }
        if (force) notify(changed ? `新增 ${added}、更新 ${updated}、移除 ${removed}` : '模型目录已是最新', 'success');
      } else if (force) {
        notify(answer.state === 'busy' ? '正在处理 RouterGo 授权，请稍后同步' : '请先连接 RouterGo 账号');
      }
    } catch (reason) {
      if (!request.signal.aborted && force) notify(reason.message);
    } finally {
      if (activeSync.current === request) { activeSync.current = undefined; setSyncing(false); }
    }
  }

  async function refresh() {
    if (balanceRequest.current) return;
    const request = new AbortController();
    balanceRequest.current = request;
    lastBalanceRead.current = Date.now();
    setBalanceError(false); setReadingBalance(true);
    try {
      const answer = await command('status', {}, AbortSignal.any([request.signal, AbortSignal.timeout(15000)]));
      if (!request.signal.aborted) setAccess(answer);
    } catch (reason) {
      if (request.signal.aborted) return;
      if (reason.status === 401) setAccess({ state: 'disconnected' });
      setBalanceError(true);
      notify(reason.message);
    } finally {
      if (balanceRequest.current === request) { balanceRequest.current = undefined; setReadingBalance(false); }
    }
  }

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (isRouterGoAccountReference(configuredRef)) { lastSync.current = 0; void refresh(); void sync(); }
    else { setAccess(undefined); setBalanceError(false); setReadingBalance(false); setSyncing(false); }
    function onFocus() {
      if (!isRouterGoAccountReference(configuredRef)) return;
      if (Date.now() - lastBalanceRead.current > 3000) void refresh();
      void sync();
    }
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      balanceRequest.current?.abort();
      balanceRequest.current = undefined;
      activeSync.current?.abort();
      activeSync.current = undefined;
    };
  }, [configuredRef]);

  async function start() {
    setBusy('start'); setNotice(undefined);
    const desktop = window.location.protocol === 'dsh-app:';
    const popup = desktop ? null : window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    try {
      const next = await command('start');
      if (!alive.current) { popup?.close(); return; }
      setPending(next);
      if (desktop) window.open(next.verificationURL, '_blank', 'noopener,noreferrer');
      else if (popup && !popup.closed) popup.location.replace(next.verificationURL);
    } catch (reason) { popup?.close(); if (alive.current) notify(reason.message); }
    finally { if (alive.current) setBusy(''); }
  }

  async function save(session, replace) {
    setBusy('save'); setNotice(undefined);
    try {
      const answer = await command('save', { id: session.id, replace });
      if (!alive.current) return;
      setPending(undefined); setAccess(answer); onSaved(); void refresh();
    } catch (reason) {
      if (!alive.current) return;
      if (reason.status === 410) setPending(undefined);
      else if (reason.code === 'switch_required') setPending({ ...session, requireSwitch: true });
      notify(reason.message);
    } finally { if (alive.current) setBusy(''); }
  }

  useEffect(() => {
    if (!pending || pending.account || busy === 'cancel') return;
    const request = new AbortController();
    let timer;
    async function poll() {
      try {
        const answer = await command('poll', { id: pending.id }, AbortSignal.any([request.signal, AbortSignal.timeout(15000)]));
        if (request.signal.aborted) return;
        if (answer.state === 'pending') timer = setTimeout(poll, answer.retryAfter * 1000);
        else if (answer.state === 'authorized') {
          const approved = { ...pending, ...answer };
          setPending(approved);
          if (!approved.requireSwitch) void save(approved, false);
        } else {
          setPending(undefined);
          notify(answer.state === 'denied' ? 'RouterGo 授权已拒绝' : 'RouterGo 授权已过期，请重新登录');
        }
      } catch (reason) {
        if (request.signal.aborted) return;
        if (reason.status === 410) setPending(undefined);
        else timer = setTimeout(poll, pending.retryAfter * 1000);
        notify(reason.message);
      }
    }
    timer = setTimeout(poll, pending.retryAfter * 1000);
    return () => { clearTimeout(timer); request.abort(); };
  }, [pending, busy === 'cancel']);

  async function cancel() {
    setBusy('cancel'); setNotice(undefined);
    try { await command('cancel', { id: pending.id }); }
    catch (reason) { if (alive.current && reason.status !== 410) notify(reason.message); }
    finally { if (alive.current) { setPending(undefined); setBusy(''); } }
  }

  const connected = access?.state === 'connected';
  const accountConfigured = isRouterGoAccountReference(configuredRef);
  const showLogin = !connected && !readingBalance && !pending && (!available || accountConfigured);
  const login = showLogin ? <Button variant="secondary" size="sm" className="cmd-routergo-login"
    aria-label="登录 RouterGo" aria-busy={busy === 'start'} disabled={!writable || !ready || !!busy} onClick={() => void start()}>
    <span className="cmd-routergo-login-mark" aria-hidden="true"><UIIcon name="flash" size={18} selected /></span>
    <span>登录</span>
  </Button> : null;
  return <>
    {renderHeader ? renderHeader(login, connected) : <div className="cmd-routergo-head">
      <RouterGoBrand />
      <div className="cmd-routergo-actions">
        {login}
        <Button variant="outline" size="sm" disabled={!writable || !ready} onClick={onEdit}><UIIcon name="key" size={14} /><span>使用密钥</span></Button>
      </div>
    </div>}
    {connected ? <section className="cmd-routergo-summary" aria-label="RouterGo 账号信息">
      <div className="cmd-routergo-user">
        <span className="cmd-routergo-avatar"><UIIcon name="account" size={17} /></span>
        <div className="cmd-routergo-identity">
          <strong className="cmd-routergo-name" dir="auto">{access.account.name}</strong>
          {access.account.username && access.account.username !== access.account.name ?
            <span className="cmd-routergo-username" dir="auto">{access.account.username}</span> : null}
        </div>
      </div>
      <Tooltip label={balanceError && access.balance ? '显示上次读取的额度' : undefined}>
        <div className="cmd-routergo-wallet" role="status" aria-label={balanceError ? 'RouterGo 额度读取失败' : 'RouterGo 额度'} aria-busy={readingBalance}>
          <UIIcon name="wallet" size={15} />
          <div className="cmd-routergo-amount">
            {access.balance ? <><strong>{balanceFormat.format(access.balance.amount)}</strong><span>{access.balance.unit}</span></>
              : <span>{balanceError ? '暂不可用' : '正在读取…'}</span>}
          </div>
        </div>
      </Tooltip>
      <div className="cmd-routergo-tools">
        <Button asChild variant="secondary" size="sm" className="cmd-routergo-recharge">
          <a href={routerGoRecharge} target="_blank" rel="noopener noreferrer"><UIIcon name="external" size={14} />充值</a>
        </Button>
      </div>
    </section> : null}
    {pending ? <div className="cmd-routergo-progress">
      <div className="cmd-routergo-progress-copy" role="status">
        <UIIcon name={pending.account ? 'account' : 'link'} size={19} />
        <strong>{pending.account
          ? busy === 'save' ? '正在配置模型…' : pending.requireSwitch ? `将使用 ${pending.account.name} 的账号凭据` : `已授权 ${pending.account.name}`
          : '等待 RouterGo 授权确认'}</strong>
      </div>
      <div className="cmd-routergo-tools">
        <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void cancel()}><UIIcon name="close" size={15} />取消授权</Button>
        {pending.account ? <Button size="sm" disabled={!!busy} onClick={() => void save(pending, pending.requireSwitch)}>
          <UIIcon name={pending.requireSwitch ? 'key' : 'refresh'} size={15} />{busy === 'save' ? '正在配置' : pending.requireSwitch ? '使用账号凭据' : '重试配置'}
        </Button> : <Button asChild variant="outline" size="sm">
          <a href={pending.verificationURL} target="_blank" rel="noopener noreferrer">打开授权页<UIIcon name="external" size={14} /></a>
        </Button>}
      </div>
    </div> : !connected && (readingBalance || (balanceError && accountConfigured)) ? <div className="cmd-routergo-progress">
      {readingBalance ? <span className="cmd-routergo-progress-copy" role="status"><UIIcon name="account" size={17} />正在读取 RouterGo 账号…</span>
        : <Button variant="outline" size="sm" onClick={() => void refresh()}><UIIcon name="refresh" size={15} />重试读取余额</Button>}
    </div> : null}
    <React.Fragment key={editorVersion}>
      {renderEditor?.(syncing && connected, dirty => <Button variant="outline" size="sm" className="cmd-model-discover"
        disabled={dirty || !writable || !ready || !connected || syncing} aria-busy={syncing}
        title={dirty && !syncing ? '请先保存模型修改' : undefined} onClick={() => void sync(true)}>
        {syncing ? '正在同步…' : '同步模型'}
      </Button>)}
    </React.Fragment>
    {notice ? <Toast key={notice.sequence} text={notice.text} tone={notice.tone} icon={<UIIcon name="close" size={16} />} onDone={() => setNotice(undefined)} /> : null}
  </>;
}
