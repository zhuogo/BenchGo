import React, { useEffect, useRef, useState } from 'react';
import { Select } from '../../shared/client/select.jsx';
import { Disclosure } from '../../shared/client/ui/collapsible.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import { DeviceLoading } from './device-loading.jsx';

/** Only the trusted Android assets page owns this native APK update entry. */
export function LocalAppUpdates({ runtime }) {
  const [data, setData] = useState(null), [pending, setPending] = useState('status'), [error, setError] = useState('');
  const [source, setSource] = useState('mirror'), [mirrorUrl, setMirrorUrl] = useState(''), [opened, setOpened] = useState(false);
  const mounted = useRef(false), gate = useRef(false);
  const run = async (action, args = {}) => {
    if (gate.current) return null;
    gate.current = true; setPending(action); setError(''); setOpened(false);
    try {
      const value = await runtime.call(action, args);
      if (mounted.current) {
        setData(value);
        if (value.config) { setSource(value.config.source); setMirrorUrl(value.config.mirrorUrl || ''); }
        if (value.opened) setOpened(true);
      }
      return value;
    } catch (reason) { if (mounted.current) setError(reason.message || '无法检查本机应用更新，请重试'); return null; }
    finally { gate.current = false; if (mounted.current) setPending(''); }
  };
  useEffect(() => {
    mounted.current = true; void run('appUpdateStatus');
    return () => { mounted.current = false; };
  }, [runtime]);
  const busy = !!pending, available = data?.available === true && data?.phase === 'available';
  const sourceDirty = !!data && (source !== data.config?.source || (source === 'custom' && mirrorUrl.trim() !== data.config?.mirrorUrl));
  const configure = async (nextSource, nextMirror = mirrorUrl) => {
    if (nextSource === 'custom') {
      try { const value = new URL(nextMirror); if (value.protocol !== 'https:' || value.username || value.password || value.search || value.hash) throw Error(); }
      catch { setError('请输入不含凭据、查询参数和片段的 HTTPS 镜像地址'); return; }
    }
    await run('appUpdateConfigure', { source: nextSource, mirrorUrl: nextMirror.trim() });
  };
  const failure = error || (data?.phase === 'error' ? data.notice : '');
  return <section className="dc-management dc-app-updates" aria-label="本机应用更新">
    <div className="dc-app-update-heading"><div><h3>本机应用</h3><p className="dc-note">BenchGo {data?.current?.version ? `v${data.current.version}` : 'Android'}{available && <> → <strong>v{data.android.version}</strong></>}</p></div><button type="button" className="dc-button" disabled={busy || !data || sourceDirty} onClick={() => void run(available ? 'appUpdateOpen' : 'appUpdateCheck')}><UIIcon name={available ? 'external' : 'refresh'} size={16} />{pending === 'appUpdateCheck' ? '检查中…' : pending === 'appUpdateOpen' ? '正在打开…' : available ? '立即更新' : '检查更新'}</button></div>
    {!data && !failure ? <DeviceLoading label="正在读取本机版本…" /> : <>
      {data?.releaseVersion && <p className="dc-note">统一发布 v{data.releaseVersion} · 已验证发布清单签名</p>}
      {!failure && <p className="dc-note" role="status">{opened ? '已打开浏览器，请下载 APK 后按系统提示确认安装。' : pending === 'appUpdateCheck' ? '正在检查并验证发布签名…' : data?.notice}</p>}
      {available && <p className="dc-footnote">安装包将通过浏览器下载，由 Android 确认安装。此处已验证发布清单签名，未在应用内校验下载文件。</p>}
    </>}
    {failure && <div className="dc-app-update-error" role="alert"><span>{failure}</span><button type="button" className="dc-button" disabled={busy || sourceDirty} onClick={() => void run(data ? 'appUpdateCheck' : 'appUpdateStatus')}>重试</button></div>}
    <Disclosure title="更新来源" className="dc-app-update-source"><label className="dc-field"><span>本机应用下载源</span><Select aria-label="本机应用下载源" value={source} disabled={busy} onChange={event => { const next = event.target.value; setSource(next); setError(''); if (next !== 'custom') void configure(next); }}><option value="mirror">国内加速（默认）</option><option value="github">GitHub 直连</option><option value="custom">自定义镜像</option></Select></label>{source === 'custom' && <form onSubmit={event => { event.preventDefault(); void configure('custom'); }}><label className="dc-field"><span>HTTPS 镜像地址</span><input type="url" required value={mirrorUrl} disabled={busy} onChange={event => setMirrorUrl(event.target.value)} placeholder="https://mirror.example.com/" /></label><div className="dc-actions"><button className="dc-button" type="submit" disabled={busy}>保存来源</button></div></form>}</Disclosure>
    {sourceDirty && <p className="dc-footnote" role="status">请先保存更新来源，再检查或下载更新。</p>}
    <p className="dc-footnote">仅更新这部手机的 BenchGo；连接主机的界面与功能更新，请在对应工作台内检查。</p>
  </section>;
}
