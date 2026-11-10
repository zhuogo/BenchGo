import { Loading } from '../../shared/client/ui/loading.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import { Disclosure } from '../../shared/client/ui/collapsible.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { readJsonResponse } from './http-response.mjs';
import { UIIcon } from './iconsax.jsx';
import { CustomSelect } from '../../shared/client/custom-select.jsx';
import css from './skills-library.css';
import { SkillDeck } from './skill-deck.jsx';

const sources = [['all', '全部来源'], ['user', '用户安装'], ['project', '项目技能'], ['owned', '自建技能'], ['bundled', '内置技能'], ['plugin', '插件技能']];
const statusNames = { candidate: '待审核', active: '可用', stale: '待整理', archived: '已归档', unavailable: '未生效' };
const auditNames = { create: '创建', update: '更新', pin: '固定', unpin: '取消固定', use: '使用', stale: '标记待整理', archived: '归档', restore: '恢复', rollback: '恢复版本' };
const sourceOf = row => row.provider === 'benchgo-superagent' || row.owned ? 'owned' : ['user-dsh', 'user-agents', 'custom'].includes(row.source) ? 'user' : ['project-dsh', 'project-agents'].includes(row.source) ? 'project' : row.source === 'bundled' ? 'bundled' : 'plugin';
const sourceName = row => sources.find(([key]) => key === sourceOf(row))?.[1];
const keyOf = row => JSON.stringify(row.owned ? ['owned', row.owned.id] : ['registered', row.provider, row.name]);

async function catalogApi(action, args = {}, signal) {
  const url = new URL('api/benchgo/skills', document.baseURI);
  const response = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args }), signal });
  return readJsonResponse(response, url);
}

export function SkillsLibrary({ ownedApi, api = catalogApi }) {
  const [showDeck, setShowDeck] = useState(false);
  const [catalog, setCatalog] = useState(null), [owned, setOwned] = useState(null), [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState([]);
  const [query, setQuery] = useState(''), [source, setSource] = useState('all'), [state, setState] = useState('all');
  const [selected, setSelected] = useState(null), [detail, setDetail] = useState(null), [audit, setAudit] = useState(null);
  const [loading, setLoading] = useState(true), [detailLoading, setDetailLoading] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [detailError, setDetailError] = useState(''), [ownedError, setOwnedError] = useState(''), [copied, setCopied] = useState(false);
  const [revision, setRevision] = useState(0);
  const alive = useRef(false), mutation = useRef(false), detailsRequest = useRef(0), detailHeading = useRef(null), lastRow = useRef(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (selected === null) lastRow.current?.focus(); }, [selected]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setOwnedError(''); setSelected(null); setDetail(null); setAudit(null); detailsRequest.current++;
    Promise.allSettled([api('list', projectId ? { projectId } : {}, controller.signal), ownedApi('ownedSkills', {}, controller.signal)]).then(([directory, managed]) => {
      if (controller.signal.aborted) return;
      if (directory.status === 'fulfilled') { setCatalog(directory.value); setProjects(directory.value.projects || []); } else { setCatalog(null); setError(directory.reason.message); }
      if (managed.status === 'fulfilled') setOwned(managed.value); else { setOwned(null); setOwnedError(managed.reason.message); }
      setLoading(false);
    });
    return () => controller.abort();
  }, [projectId, revision, ownedApi, api]);

  const directory = catalog?.skills || [], managed = owned?.skills || [];
  const rows = directory.map(row => ({ ...row, available: row.invocation?.modelInvocable === true || row.invocation?.userInvocable === true, owned: row.provider === 'benchgo-superagent' ? managed.find(item => item.name === row.name && ['active', 'stale'].includes(item.status)) : null }));
  for (const item of managed) if (!rows.some(row => row.owned?.id === item.id)) rows.push({ name: item.name, description: item.description, provider: 'benchgo-superagent', source: 'benchgo-owned', owned: item, available: false });
  const matching = rows.filter(row => (source === 'all' || sourceOf(row) === source) && `${row.name} ${row.description} ${row.path || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const candidateCount = matching.filter(row => row.owned?.status === 'candidate').length;
  const visible = matching.filter(row => state === 'all' || (state === 'available' ? row.available : state === 'candidate' ? row.owned?.status === 'candidate' : !row.available && row.owned?.status !== 'candidate'));
  const current = rows.find(row => keyOf(row) === selected);
  const status = row => row.owned?.status === 'candidate' ? '待审核' : row.available ? row.owned?.status === 'stale' ? '可用 · 待整理' : '可用' : statusNames[row.owned?.status === 'active' || row.owned?.status === 'stale' ? 'unavailable' : row.owned?.status] || '不可用';
  function changeFilter(update) { update(); setSelected(null); setAudit(null); detailsRequest.current++; }
  async function select(row, event) {
    lastRow.current = event?.currentTarget; const request = ++detailsRequest.current;
    setSelected(keyOf(row)); setDetail(null); setAudit(null); setDetailError(''); setCopied(false);
    if (row.owned) { setDetail(row.owned); setDetailLoading(false); }
    else {
      setDetailLoading(true);
      try { const result = await api('get', { ...(projectId ? { projectId } : {}), name: row.name, provider: row.provider }); if (alive.current && request === detailsRequest.current) setDetail(result.skill); }
      catch (cause) { if (alive.current && request === detailsRequest.current) setDetailError(cause.message); }
      finally { if (alive.current && request === detailsRequest.current) setDetailLoading(false); }
    }
    if (alive.current && request === detailsRequest.current) detailHeading.current?.focus();
  }
  async function mutate(op, extra = {}) {
    if (mutation.current || !current?.owned) return;
    mutation.current = true; setBusy(true); setDetailError('');
    try { await ownedApi(`ownedSkill${op[0].toUpperCase()}${op.slice(1)}`, { id: current.owned.id, revision: current.owned.revision, ...extra }); if (alive.current) setRevision(value => value + 1); }
    catch (cause) { if (alive.current) setDetailError(cause.message); }
    finally { mutation.current = false; if (alive.current) setBusy(false); }
  }
  async function history() {
    const request = ++detailsRequest.current; setDetailError('');
    try { const result = await ownedApi('ownedSkillAudit', { id: current.owned.id }); if (alive.current && request === detailsRequest.current) setAudit(result.events); }
    catch (cause) { if (alive.current && request === detailsRequest.current) setDetailError(cause.message); }
  }
  async function copyPath() {
    const request = detailsRequest.current;
    try { await navigator.clipboard.writeText(current.path); if (alive.current && request === detailsRequest.current) setCopied(true); }
    catch { if (alive.current && request === detailsRequest.current) setDetailError('无法复制，请选中下方路径手动复制。'); }
  }
  const refresh = () => setRevision(value => value + 1);
  if (showDeck) return <><style>{css}</style><SkillDeck api={api} onBack={() => { setShowDeck(false); refresh(); }} /></>;
  return <section className={`bg-skill-library${current ? ' has-detail' : ''}`}><style>{css}</style>
    <header className="bg-skill-heading"><div><h2>技能库</h2></div><div className="bg-skill-heading-actions"><Button variant="ghost" disabled={busy} onClick={() => setShowDeck(true)}>浏览工程技能</Button><Button variant="ghost" onClick={refresh} disabled={loading || busy}><UIIcon name="refresh" size={16} />刷新</Button></div></header>
    <div className="bg-skill-sheet">
      <div className="bg-skill-toolbar"><CustomSelect id="bg-skill-project" aria-label="技能查询范围" value={projectId} options={[{ value: '', label: '全局技能' }, ...projects.map(project => ({ value: project.id, label: project.title === 'default-workspace' ? '最近' : project.title || project.path || project.id }))]} onChange={value => { setCatalog(null); setProjectId(value); }} disabled={busy} searchable /><label className="bg-skill-search"><UIIcon name="search" size={17} /><input type="search" aria-label="搜索技能名称、描述或路径" placeholder="搜索技能" value={query} onChange={event => changeFilter(() => setQuery(event.target.value))} /></label><CustomSelect aria-label="按来源筛选" value={source} onChange={value => changeFilter(() => setSource(value))} options={sources.map(([value, label]) => ({ value, label }))} /></div>
      <div className="bg-skill-views" role="group" aria-label="按状态筛选">{[['all', '全部技能'], ['available', '可用'], ['candidate', '待审核'], ['inactive', '未启用']].map(([key, title]) => <button type="button" key={key} aria-pressed={state === key} onClick={() => changeFilter(() => setState(key))}>{title}{key === 'candidate' && candidateCount > 0 && <span>{candidateCount}</span>}</button>)}<small>{loading ? '读取中' : `${visible.length} 项技能`}</small></div>
      {error && <div className="bg-skill-notice" role="alert">技能目录读取失败：{error}<button type="button" onClick={refresh}>重试</button></div>}
      {catalog?.available === false && <p className="bg-skill-notice" role="status">官方技能服务未启用，当前仅展示自建技能记录。</p>}
      {ownedError && <Disclosure className="bg-skill-service-note" title="自建技能暂不可用，已安装技能仍可浏览"><p>{ownedError}</p></Disclosure>}
      <div className="bg-skill-workspace">
        <div className="bg-skill-list" aria-label="技能列表" aria-busy={loading}>
          {!rows.length && loading ? <Loading className="bg-skill-empty" label="正在读取技能" /> : visible.length ? visible.map(row => <button type="button" key={keyOf(row)} disabled={loading || busy} ref={node => { if (keyOf(row) === selected && node) lastRow.current = node; }} className={`bg-skill-row${keyOf(row) === selected ? ' is-selected' : ''}`} aria-pressed={keyOf(row) === selected} onClick={event => select(row, event)}><span className="bg-skill-row-title"><strong>{row.name}</strong><span className={`bg-skill-status${row.available ? ' is-available' : ''}`}>{status(row)}</span></span><span className="bg-skill-description">{row.description || '暂无描述'}</span><span className="bg-skill-row-meta">{sourceName(row)}{row.owned?.pinned ? ' · 已固定' : ''}<UIIcon name="chevronLeft" size={14} className="bg-skill-forward" /></span></button>) : <div className="bg-skill-empty" role="status"><strong>{query || source !== 'all' || state !== 'all' ? '没有匹配的技能' : error ? '技能目录暂不可用' : '还没有发现技能'}</strong><p>{query || source !== 'all' || state !== 'all' ? '试试其他关键词，或调整来源和状态。' : '安装到 Harness 技能目录后刷新；项目技能需先选择对应项目。'}</p>{(query || source !== 'all' || state !== 'all') && <Button variant="ghost" onClick={() => { setQuery(''); setSource('all'); setState('all'); }}>清除筛选</Button>}</div>}
        </div>
        <aside className="bg-skill-detail" aria-label="技能详情">
          {current ? <><header className="bg-skill-detail-head"><button type="button" className="bg-skill-back" onClick={() => { setSelected(null); detailsRequest.current++; }}><UIIcon name="chevronLeft" size={16} />返回列表</button><span>{sourceName(current)}</span><h3 ref={detailHeading} tabIndex={-1}>{current.name}</h3><p>{current.description}</p><span className={`bg-skill-status${current.available ? ' is-available' : ''}`}>{status(current)}</span></header>
            <dl className="bg-skill-facts"><div><dt>来源</dt><dd>{current.owned ? 'SuperAgent · 自建技能库' : current.provider}</dd></div>{current.owned ? <div><dt>版本</dt><dd>{current.owned.revision}{current.owned.pinned ? ' · 已固定' : ''}</dd></div> : <><div><dt>AI 调用</dt><dd>{current.invocation?.modelInvocable ? '允许' : '不允许'}</dd></div><div><dt>手动调用</dt><dd>{current.invocation?.userInvocable ? '允许' : '不允许'}</dd></div></>}{current.path && <div className="bg-skill-path"><dt>文件路径<button type="button" onClick={copyPath}>{copied ? '已复制' : '复制路径'}</button></dt><dd>{current.path}</dd></div>}</dl>
            {current.owned && <div className="bg-skill-management">{current.owned.status === 'candidate' ? <><Button variant="default" disabled={busy || owned?.available === false} onClick={() => mutate('approve')}>批准启用</Button><Button variant="ghost" disabled={busy} onClick={() => mutate('reject')}>拒绝候选</Button></> : <>{['archived', 'stale'].includes(current.owned.status) && <Button variant="default" disabled={busy || owned?.available === false} onClick={() => mutate('restore')}>恢复使用</Button>}<Button variant="ghost" disabled={busy} onClick={() => mutate('pin', { pinned: !current.owned.pinned })}>{current.owned.pinned ? '取消固定' : '固定技能'}</Button><Button variant="ghost" disabled={busy} onClick={history}>查看历史</Button></>}{owned?.available === false && <p>官方技能服务未启用，暂不能启用或恢复。</p>}</div>}
            {detailError && <p className="bg-skill-notice" role="alert">{detailError}{!current.owned && <button type="button" onClick={() => select(current)}>重试</button>}</p>}
            <section className="bg-skill-body"><h4>技能正文</h4>{detailLoading ? <Loading label="正在读取正文…" /> : detail && <pre>{detail.content || '此技能没有正文。'}</pre>}</section>
            {audit && <section className="bg-skill-audit"><h4>变更历史</h4>{!audit.length && <p>暂无历史记录。</p>}{audit.map(entry => <Disclosure key={entry.seq} title={<>{auditNames[entry.action] || entry.action} · 版本 {entry.version}</>} description={new Date(entry.at).toLocaleString()}><pre>{entry.body}</pre><Button variant="ghost" disabled={busy || owned?.available === false || current.owned.pinned || entry.version === current.owned.revision} onClick={() => mutate('restore', { snapshotSeq: entry.seq })}>恢复此版本</Button></Disclosure>)}{current.owned.pinned && <p>取消固定后可恢复历史版本。</p>}</section>}
          </> : null}
        </aside>
      </div>
    </div>
  </section>;
}
