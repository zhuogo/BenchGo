import { Disclosure } from '../../shared/client/ui/collapsible.jsx';
import React, { useEffect, useRef, useState } from 'react';
import * as nativeRuntime from './api.mjs';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import pairingCss from './pairing.css';
import { Button, ErrorText, StatusDot, useLinkStyle } from './app.jsx';
import { BrandLogo } from './brand.jsx';
import { deviceName, rememberDeviceName } from './pairing-state.mjs';

function usePairingStyle() {
  useLinkStyle();
  useEffect(() => { if (document.getElementById('dsh-link-pairing-style')) return; const node = document.createElement('style'); node.id = 'dsh-link-pairing-style'; node.textContent = pairingCss; document.head.append(node); return () => node.remove(); }, []);
}
/** Pairing only: the parent entry hands approved devices to the shared workbench. */
export function LinkPairingApp({ runtime = nativeRuntime }) {
  usePairingStyle();
  const { bootstrap, call, contextUri, isLocalIdentitySave, isNative, pairingContext, saveIdentity, scan } = runtime;
  const [initial] = useState(() => bootstrap());
  const pairGeneration = useRef(0), pairFlight = useRef(false), autoPairAttempt = useRef('');
  const [identity, setIdentity] = useState(initial);
  const [theme, setTheme] = useState(() => globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const [pairUri, setPairUri] = useState(() => contextUri(initial) || new URLSearchParams(location.hash.slice(1)).get('code') || '');
  const [autoPairUri, setAutoPairUri] = useState(() => initial?.token ? '' : pairUri);
  const [name, setName] = useState(() => deviceName(initial?.localName)), [pairing, setPairing] = useState(null), [pairState, setPairState] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  useEffect(() => {
    const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const changed = () => setTheme(media.matches ? 'dark' : 'light');
    media.addEventListener?.('change', changed);
    return () => media.removeEventListener?.('change', changed);
  }, []);
  useEffect(() => {
    const changed = () => {
      const next = bootstrap();
      if (isLocalIdentitySave(next)) return;
      // Android may redeliver the same scan after page load. Do not invalidate
      // the single-use request already sent for this code.
      if (!next?.token && contextUri(next) && contextUri(next) === autoPairAttempt.current) return;
      pairGeneration.current++;
      pairFlight.current = false;
      setIdentity(next); setPairUri(contextUri(next));
      setAutoPairUri(next?.token ? '' : contextUri(next));
      setPairing(null); setPairState(''); setError(''); setBusy(false);
      if (next?.localName) setName(next.localName);
    };
    if (runtime.subscribe) return runtime.subscribe(changed);
    window.addEventListener('link:bootstrap', changed); return () => window.removeEventListener('link:bootstrap', changed);
  }, [runtime]);
  useEffect(() => { rememberDeviceName(name); }, [name]);
  useEffect(() => { const changed = () => setOnline(navigator.onLine !== false); window.addEventListener('online', changed); window.addEventListener('offline', changed); return () => { window.removeEventListener('online', changed); window.removeEventListener('offline', changed); }; }, []);
  useEffect(() => {
    if (!pairing) return;
    let closed = false, timer;
    const poll = async () => {
      if (closed || pairing.generation !== pairGeneration.current) return;
      if (pairing.expiresAt && Date.now() >= pairing.expiresAt) { setPairState('expired'); setPairing(null); return; }
      try {
        const result = await call('pair/status', { requestId: pairing.requestId, pollToken: pairing.pollToken });
        if (closed || pairing.generation !== pairGeneration.current) return;
        setPairState(result.status);
        setError('');
        if (result.status === 'approved' && result.token) {
          const next = { ...pairing.context, name: result.hostName || result.name || pairing.context.name || new URL(pairing.context.url).host, token: result.token, deviceId: result.deviceId }; saveIdentity(next); setIdentity(next); setPairing(null); setError(''); return;
        }
        if (result.status === 'rejected' || result.status === 'expired') return;
      } catch (e) { if (!closed && pairing.generation === pairGeneration.current) setError(e.message); }
      if (!closed) timer = setTimeout(poll, 1300);
    };
    poll(); return () => { closed = true; clearTimeout(timer); };
  }, [runtime, pairing]);
  const pair = async (event, input = pairUri) => {
    event?.preventDefault();
    if (pairFlight.current || pairing || pairState === 'pending' || pairState === 'rejected' || pairState === 'expired') return;
    pairFlight.current = true;
    const generation = ++pairGeneration.current; setBusy(true); setError(''); setPairing(null); setPairState('');
    try {
      const context = { ...pairingContext(input), localName: name.trim() || deviceName() };
      if (!context.code) throw new Error('配对地址缺少一次性配对码');
      if (!isNative() && new URL(context.url).origin !== location.origin) throw new Error('请打开该主机的 HTTPS 配对页面');
      setName(context.localName);
      saveIdentity(context); const result = await call('pair', { code: context.code, name: context.localName, deviceType: 'mobile' });
      if (generation !== pairGeneration.current) return;
      setPairing({ ...result, context, generation }); setPairState('pending');
      if (location.hash) window.history.replaceState(null, '', location.pathname + location.search);
    } catch (e) { if (generation === pairGeneration.current) setError(e.message); } finally { if (generation === pairGeneration.current) { pairFlight.current = false; setBusy(false); } }
  };
  useEffect(() => {
    if (identity?.token || !autoPairUri || autoPairAttempt.current === autoPairUri) return;
    autoPairAttempt.current = autoPairUri;
    void pair(undefined, autoPairUri);
  }, [autoPairUri, identity?.token]);
  const updatePairUri = value => { pairGeneration.current++; pairFlight.current = false; setAutoPairUri(''); setPairing(null); setPairState(''); setBusy(false); setError(''); setPairUri(value); };
  const pairWaiting = pairState === 'pending' || pairState === 'approving';
  const pairPending = busy || pairWaiting;
  const pairTerminal = pairState === 'rejected' || pairState === 'expired';
  let pairDetails;
  try { if (pairUri) pairDetails = pairingContext(pairUri); } catch {}

  if (identity?.token) return null;
  return <main className="link-mobile link-mobile-v3 link-mobile-pair" data-theme={theme}>
    <header className="link-mobile-topbar"><Brand /><span className="link-mobile-connection"><StatusDot state={!online ? 'failed' : pairPending ? 'waiting' : 'idle'} />{!online ? '网络已断开' : pairWaiting ? '等待电脑允许' : busy ? '正在连接' : '尚未连接'}</span></header>
    <section className="link-mobile-section link-mobile-pair-intro"><h1>连接你的电脑</h1><p>把桌面的项目和会话，接到手机上。</p></section>
    <section className="link-mobile-pair-card">
      <div className="link-mobile-pair-symbol"><UIIcon name="link" size={28} /></div><h2>{pairWaiting ? '请在电脑上允许连接' : busy ? '正在发送连接请求…' : pairUri ? '连接工作台' : isNative() ? '扫码连接工作台' : '连接桌面工作台'}</h2><p>{pairWaiting ? '请求已发送，无需再次扫码或点击连接。' : busy ? '正在连接电脑，请稍候。' : pairUri ? '扫码后自动连接，仅需电脑确认。' : isNative() ? '在电脑「远程连接」中点击「连接手机」，再扫描电脑上的二维码。' : '在电脑「远程连接」中点击「连接手机」，在下方粘贴配对码。'}</p>
      <label className="link-mobile-field" htmlFor="pair-name"><span>这台设备的名称</span><input id="pair-name" autoComplete="off" maxLength={100} value={name} disabled={pairPending} onChange={e => setName(e.target.value)} placeholder="我的手机" /></label>
      {pairDetails?.code && <div className="link-mobile-pair-details"><span>连接电脑</span><strong>{new URL(pairDetails.url).host}</strong><label className="link-mobile-field" htmlFor="pair-code"><span>已识别配对码</span><input id="pair-code" aria-label="已识别配对码" value={pairDetails.code} readOnly onFocus={event => event.target.select()} /></label></div>}
      {isNative() && !pairUri && <button className="link-mobile-scan-button" onClick={scan} disabled={busy}><UIIcon name="scan" size={21} />扫描桌面二维码</button>}
      {(pairUri || !isNative()) && !pairTerminal && <Button kind="primary" onClick={pair} disabled={!pairUri.trim() || pairPending}>{busy ? '正在连接…' : pairWaiting ? '等待电脑允许…' : error ? '重试连接' : '连接工作台'}</Button>}
      {isNative() && pairUri && !pairPending && <Button icon="scan" onClick={scan}>重新扫码</Button>}
      {pairState && <div className={'link-mobile-pair-feedback ' + (pairWaiting ? '' : 'is-warning')} role="status"><StatusDot state={pairWaiting ? 'waiting' : pairState === 'approved' ? 'running' : 'failed'} /><div><strong>{pairWaiting ? '请在电脑上允许连接' : pairState === 'rejected' ? '电脑未允许这次连接' : pairState === 'expired' ? '配对码已过期' : '已确认'}</strong><p>{pairWaiting ? '打开电脑的「远程连接」，确认设备名称后点击「允许」。' : '请在电脑上生成新的二维码，再重新扫码。'}</p></div></div>}
      {error && <div className="link-mobile-pair-feedback is-warning"><ErrorText>{connectionError(error, isNative() && !!identity?.pin)}</ErrorText></div>}
    </section>
    <Disclosure className="link-mobile-backup" defaultOpen={!isNative()} title="使用配对地址"><form onSubmit={pair}><label className="link-mobile-field" htmlFor="pair-uri"><span>{isNative() ? '完整配对地址' : '一次性配对码或完整配对地址'}</span><textarea id="pair-uri" value={pairUri} disabled={pairPending} onChange={e => updatePairUri(e.target.value)} placeholder={isNative() ? '粘贴电脑复制的 benchgo://pair?…' : '粘贴电脑提供的配对码或链接'} rows="3" spellCheck="false" /></label><Button type="submit" disabled={!pairUri.trim() || pairPending || pairTerminal}>使用地址连接</Button></form></Disclosure>
    <div className="link-mobile-network-note"><UIIcon name="check" size={17} /><p>{isNative() ? '手机与电脑在同一 Wi-Fi 下可直接连接，无需公网。不同网络需使用可访问的 HTTPS 地址。' : '当前通过 HTTPS 连接工作台。浏览器使用电脑提供的同源配对页；Android App 也可在同一 Wi-Fi 内直连。'}</p></div>
  </main>;
}

function Brand() { return <div className="link-mobile-brand"><BrandLogo size={28} decorative /><span>BenchGo</span></div>; }
function connectionError(message, lan) { if (/[\u3400-\u9fff]/.test(message) || !/failed to connect|timeout|timed out|unreachable/i.test(message)) return message; return lan ? '暂时无法连接电脑。请确认手机和电脑在同一 Wi-Fi，电脑已开启 Link；检查防火墙后可重新连接。' : '暂时无法连接工作台。请确认 HTTPS 地址可从手机访问，并检查服务状态、域名证书与网络转发后重试。'; }
