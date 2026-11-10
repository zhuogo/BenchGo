import { Loading } from '../../shared/client/ui/loading.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../../shared/client/ui/button.jsx';
import { Disclosure } from '../../shared/client/ui/collapsible.jsx';
import { UIIcon } from './iconsax.jsx';

const states = { available: '可用', installed: '已安装 · 待发现', conflict: '已有其他来源', 'not-installed': '未安装' };

/** A curated source inside the same library. Installed skills remain owned by the official provider. */
export function SkillDeck({ api, onBack }) {
  const [catalog, setCatalog] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(null), [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false), [detailError, setDetailError] = useState('');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [revision, setRevision] = useState(0);
  const alive = useRef(false), detailRequest = useRef(0), mutation = useRef(false), heading = useRef(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; detailRequest.current++; }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    api('deckList', {}, controller.signal).then(value => { if (!controller.signal.aborted) setCatalog(value); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, revision]);
  async function select(row) {
    const request = ++detailRequest.current;
    setSelected(row.name); setDetail(null); setDetailError(''); setDetailLoading(true); setNotice('');
    try { const value = await api('deckGet', { name: row.name }); if (alive.current && request === detailRequest.current) setDetail(value); }
    catch (cause) { if (alive.current && request === detailRequest.current) setDetailError(cause.message); }
    finally { if (alive.current && request === detailRequest.current) { setDetailLoading(false); heading.current?.focus(); } }
  }
  async function install() {
    if (!detail || mutation.current) return;
    mutation.current = true; setBusy(true); setDetailError(''); setNotice('');
    try {
      const result = await api('deckInstall', { name: selected });
      if (alive.current) {
        setNotice(result.alreadyInstalled ? '该固定版本已安装。可刷新检查官方目录是否已发现。' : `已安装 ${result.installed.join('、')}。官方目录发现后显示“可用”；安装不会自动执行技能。`);
        setRevision(value => value + 1);
      }
    } catch (cause) { if (alive.current) setDetailError(cause.message); }
    finally { mutation.current = false; if (alive.current) setBusy(false); }
  }
  const rows = catalog?.skills || [], current = rows.find(row => row.name === selected);
  const visible = rows.filter(row => `${row.name} ${row.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const missing = (detail?.skill.plan || []).filter(row => !rows.find(item => item.name === row.name)?.installed);
  const conflicts = missing.filter(row => rows.find(item => item.name === row.name)?.status === 'conflict');
  return <section className={`bg-skill-library bg-skill-deck${selected ? ' has-detail' : ''}`}>
    <header className="bg-skill-heading"><div><Button variant="ghost" onClick={onBack} disabled={busy}><UIIcon name="chevronLeft" size={16} />返回技能库</Button><h2>工程技能</h2></div><Button variant="ghost" disabled={loading || busy} onClick={() => setRevision(value => value + 1)}><UIIcon name="refresh" size={16} />刷新</Button></header>
    <p className="bg-skill-deck-intro">Matt Pocock 的工程与效率技能，按需安装到官方技能目录。保留原始调用规则、支持文件与许可证。</p>
    {catalog && <p className="bg-skill-deck-source"><a href={catalog.repository} target="_blank" rel="noreferrer">mattpocock/skills</a><span>v{catalog.version} · MIT</span><span>{rows.length} 项</span></p>}
    {error && <div className="bg-skill-notice" role="alert">工程技能目录读取失败：{error}<button type="button" onClick={() => setRevision(value => value + 1)}>重试</button></div>}
    {catalog?.available === false && <p className="bg-skill-notice" role="status">官方技能服务未启用。可以查看来源和正文，启用服务后才能安装。</p>}
    {!selected ? <>
      <label className="bg-skill-search"><UIIcon name="search" size={17} /><input type="search" aria-label="搜索工程技能" placeholder="搜索工程技能" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="bg-skill-list" aria-label="工程技能列表" aria-busy={loading}>
        {loading && !catalog ? <Loading className="bg-skill-empty" label="正在读取工程技能" />
          : visible.length ? visible.map(row => <button type="button" className="bg-skill-row" key={row.name} disabled={loading || busy} onClick={() => select(row)}><span className="bg-skill-row-title"><strong>{row.name}</strong><span className={`bg-skill-status${row.available ? ' is-available' : ''}`}>{states[row.status]}</span></span><span className="bg-skill-description">{row.description}</span><span className="bg-skill-row-meta">{row.category === 'engineering' ? '工程开发' : '效率与协作'}{row.dependencies.length > 0 && ` · ${row.dependencies.length} 项关联技能`}<UIIcon name="chevronLeft" size={14} className="bg-skill-forward" /></span></button>)
            : <div className="bg-skill-empty" role="status"><UIIcon name="search" size={28} /><strong>{error ? '工程技能暂不可用' : '没有匹配的工程技能'}</strong><p>{error ? '请重试读取目录。' : '换一个关键词，或清除搜索。'}</p><Button variant="ghost" onClick={() => { setQuery(''); if (error) setRevision(value => value + 1); }}>{error ? '重试' : '清除搜索'}</Button></div>}
      </div>
    </> : <div className="bg-skill-detail">
      <button type="button" className="bg-skill-back" disabled={busy} onClick={() => { detailRequest.current++; setSelected(null); setDetail(null); }}><UIIcon name="chevronLeft" size={16} />返回工程技能</button>
      <header className="bg-skill-detail-head"><h3 ref={heading} tabIndex={-1}>{selected}</h3><p>{current?.description}</p>{current && <span className={`bg-skill-status${current.available ? ' is-available' : ''}`}>{states[current.status]}</span>}</header>
      {detailError && <p className="bg-skill-notice" role="alert">{detailError}{!detail && <button type="button" onClick={() => select(current || { name: selected })}>重试</button>}</p>}
      {notice && <p className="bg-skill-notice" role="status">{notice}</p>}
      {detailLoading ? <Loading label="正在下载并校验固定版本正文…" /> : detail && <>
        <dl className="bg-skill-facts"><div><dt>来源</dt><dd><a href={detail.skill.url} target="_blank" rel="noreferrer">查看 GitHub 原文</a> · v{detail.version}</dd></div><div><dt>AI 调用</dt><dd>{detail.skill.modelInvocable ? '按官方技能策略调用' : '仅手动调用，保留原始限制'}</dd></div><div className="bg-skill-path"><dt>安装位置</dt><dd>{detail.destination}</dd></div><div><dt>随同安装</dt><dd>{missing.length ? missing.map(row => row.name).join('、') : '该技能及关联技能均已安装'}</dd></div></dl>
        <div className="bg-skill-management"><Button variant="default" disabled={busy || catalog?.available === false || conflicts.length > 0 || !missing.length} onClick={install}>{busy ? '正在下载并安装…' : missing.length > 1 ? `安装技能及关联项（${missing.length}）` : '安装技能'}</Button>{conflicts.length > 0 && <p>同名技能已有其他来源：{conflicts.map(row => row.name).join('、')}。保留现有内容，不覆盖安装。</p>}<p>仅写入所列技能文件。需配置工单的技能，请在目标项目中按需调用 setup-matt-pocock-skills。</p></div>
        <section className="bg-skill-body"><h4>技能正文</h4><pre>{detail.skill.content}</pre></section>
        <Disclosure className="bg-skill-deck-license" title="支持文件与许可证"><p>{detail.skill.files.join('、')}</p><pre>{detail.licenseText}</pre><p>固定版本：{detail.commit}</p></Disclosure>
      </>}
    </div>}
  </section>;
}
