import { Loading } from '../../shared/client/ui/loading.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import { Tooltip, Modal, Menu, IconDownloadOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import React, { useEffect, useId, useRef, useState } from 'react';
import css from './artifacts.css';
import { ArtifactPreview } from '../../shared/client/artifact-preview.jsx';
import { fileUrl } from '../../shared/client/preview-model.mjs';
import { SegmentedControl } from '../../shared/client/segmented-control.jsx';
import { ResourceIcon } from '../../shared/client/resource-icon.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';

const categories = [
  ['document', '文档', 'document'],
  ['image', '图片', 'picture'],
  ['video', '视频', 'video'],
  ['audio', '音频', 'mic'],
  ['web', '网页', 'link'],
];
const viewPreferenceKey = 'benchgo.superagent.artifacts.view';
function readViewPreference() {
  try { return localStorage.getItem(viewPreferenceKey) === 'cards' ? 'cards' : 'list'; } catch { return 'list'; }
}
const downloadUrl = file => {
  try { const url = fileUrl(file.downloadUrl || file.url); url.searchParams.set('download', '1'); return url.href; } catch { return undefined; }
};
const formatBytes = value => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;

function ArtifactCover({ file, category, onOpen }) {
  const [failed, setFailed] = useState(false);
  const extension = file.name.split('.').at(-1)?.toUpperCase();
  return <Button variant="ghost" type="button" className="ba-artifact-preview" onClick={onOpen} aria-label={`预览 ${file.name}`}>
    {category === 'image' && !failed ? <img src={file.url} alt="" loading="lazy" onError={() => setFailed(true)} />
      : category === 'video' && !failed ? <video src={file.url} muted preload="metadata" aria-hidden="true" onError={() => setFailed(true)} />
        : <span className="ba-artifact-cover"><span aria-hidden="true">{['document', 'web', 'video'].includes(category) ? <ResourceIcon name={category === 'web' ? 'code' : category} size={28} /> : <UIIcon name={category === 'audio' ? 'mic' : 'picture'} size={28} />}</span><span>{extension || 'FILE'}</span></span>}
  </Button>;
}

function FileDetails({ file, onOpen }) {
  const date = new Date(file.updatedAt);
  const extension = file.name.split('.').at(-1)?.toUpperCase();
  return <div className="ba-artifact-details">
    <Button variant="ghost" type="button" className="ba-artifact-name" onClick={onOpen} title={file.name}>{file.name}</Button>
    <p className="ba-artifact-meta"><span className="ba-artifact-type">{extension || 'FILE'}</span><span>{formatBytes(file.bytes)}</span>{!Number.isNaN(date.getTime()) && <time dateTime={file.updatedAt}>{date.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>}</p>
  </div>;
}

export function Artifacts({ api }) {
  const [category, setCategory] = useState('document');
  const [page, setPage] = useState({ artifacts: [], nextCursor: null, total: null });
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [selected, setSelected] = useState(null), [view, setView] = useState(readViewPreference);
  const [menu, setMenu] = useState(null), [operation, setOperation] = useState(null), [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false), [operationError, setOperationError] = useState(''), [notice, setNotice] = useState('');
  const [checked, setChecked] = useState([]), [query, setQuery] = useState('');
  const menuAnchor = useRef(null);
  const origin = useRef(null), scroll = useRef(0), root = useRef(null), controller = useRef(null), generation = useRef(0), id = useId();

  const load = async (group, after, reset = false) => {
    controller.current?.abort();
    const request = new AbortController(), sequence = ++generation.current;
    controller.current = request; setLoading(true); setError('');
    if (reset) { setPage({ artifacts: [], nextCursor: null, total: null }); setChecked([]); setQuery(''); }
    try {
      const value = await api('artifacts', { category: group, ...(after ? { after } : {}) }, request.signal);
      if (request.signal.aborted || sequence !== generation.current) return;
      const incoming = value.artifacts || [];
      setPage(previous => ({ ...value, artifacts: after ? [...new Map([...previous.artifacts, ...incoming].map(file => [file.id || file.name, file])).values()] : incoming }));
      if (!after) setChecked(previous => previous.filter(name => incoming.some(file => file.name === name)));
    } catch (cause) {
      if (!request.signal.aborted && sequence === generation.current) setError(cause.message || '读取产物失败');
    } finally {
      if (!request.signal.aborted && sequence === generation.current) setLoading(false);
    }
  };
  useEffect(() => { setMenu(null); setNotice(''); void load(category, undefined, true); return () => controller.current?.abort(); }, [category, api]);
  useEffect(() => { if (selected) root.current?.closest('.ba-studio-body')?.scrollTo({ top: 0 }); }, [selected]);
  const open = (file, event) => { origin.current = event.currentTarget; scroll.current = root.current?.closest('.ba-studio-body')?.scrollTop || 0; setSelected(file); };
  const close = () => { setSelected(null); requestAnimationFrame(() => { root.current?.closest('.ba-studio-body')?.scrollTo({ top: scroll.current }); origin.current?.focus({ preventScroll: true }); }); };
  const changeView = value => { setView(value); try { localStorage.setItem(viewPreferenceKey, value); } catch { /* Storage can be unavailable in embedded sessions. */ } };
  const label = categories.find(([value]) => value === category)?.[1] || '产物';
  const beginOperation = (type, file) => {
    const basename = file.name.split('/').at(-1);
    const dot = basename.lastIndexOf('.'), extensionAt = dot > 0 ? dot : basename.length;
    setFilename(type === 'copy' ? `${basename.slice(0, extensionAt)} 副本${basename.slice(extensionAt)}` : basename);
    setOperation({ type, file }); setOperationError(''); setMenu(null);
  };
  const submitOperation = async event => {
    event?.preventDefault();
    if (!operation || busy) return;
    setBusy(true); setOperationError('');
    try {
      if (operation.type === 'batchDelete') {
        const failed = []; let removed = 0;
        for (const file of operation.files) {
          try { await api('artifactDelete', { file: file.id || file.name, expectedHash: file.hash }); removed++; }
          catch (cause) { failed.push(`${file.name}：${cause.message || '删除失败'}`); }
        }
        setOperation(null); await load(category);
        setNotice(`已删除 ${removed} 个文件`);
        if (failed.length) setError(failed.join('；'));
        return;
      }
      const actions = { delete: 'artifactDelete', rename: 'artifactRename', copy: 'artifactCopy' };
      await api(actions[operation.type], { file: operation.file.id || operation.file.name, expectedHash: operation.file.hash, ...(operation.type === 'delete' ? {} : { name: filename.trim() }) });
      setNotice(operation.type === 'delete' ? '文件已删除' : operation.type === 'copy' ? '副本已创建' : '文件已重命名');
      setOperation(null); await load(category);
    } catch (cause) { setOperationError(cause.message || '操作失败，请重试'); }
    finally { setBusy(false); }
  };
  const copyPath = async file => {
    setMenu(null);
    try { await navigator.clipboard.writeText(`artifacts/${file.id || file.name}`); setNotice('已复制相对路径'); }
    catch { setError('无法访问剪贴板，请重试'); }
  };
  const visibleFiles = page.artifacts.filter(file => file.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const deleting = ['delete', 'batchDelete'].includes(operation?.type);
  const operationTitle = deleting ? '删除文件' : operation?.type === 'copy' ? '创建副本' : '重命名文件';

  return <section ref={root} className="ba-group ba-artifacts">
    <style>{css}</style>
    <div hidden={!!selected}>
      <header className="ba-group-head ba-artifacts-head">
        <div><h1>产物与工作区文件</h1><p>预览和管理助手交付的文件。</p></div>
        <div className="ba-artifact-header-actions"><Button variant="ghost" disabled={loading || busy} onClick={() => void load(category)}><UIIcon name="refresh" size={16} />{loading && page.artifacts.length ? '刷新中…' : error ? '重试' : '刷新'}</Button><div className="ba-artifact-view" role="group" aria-label="产物视图">
          <Button variant="ghost" type="button" aria-pressed={view === 'list'} onClick={() => changeView('list')}>列表</Button>
          <Button variant="ghost" type="button" aria-pressed={view === 'cards'} onClick={() => changeView('cards')}>卡片</Button>
        </div></div>
      </header>
      <div className="ba-artifact-toolbar">
        <SegmentedControl options={categories.map(([value, optionLabel, icon]) => ({ value, label: optionLabel, icon: ['document', 'video'].includes(value) ? <ResourceIcon name={icon} size={16} /> : <UIIcon name={icon} size={16} /> }))} value={category} onChange={setCategory} disabled={busy} label="产物分类" panelId={`${id}-files`} />
        {(page.artifacts.length > 0 || query) && <label className="ba-artifact-search"><UIIcon name="search" size={16} /><input type="search" aria-label="筛选已加载文件" placeholder="查找文件" value={query} onChange={event => { setQuery(event.target.value); setChecked([]); }} /></label>}
      </div>
      <div id={`${id}-files`} role="tabpanel" aria-labelledby={`${id}-files-${category}`} aria-busy={loading} tabIndex={-1}>
        <p className="ba-artifact-status" role="status" aria-live="polite">{loading ? page.artifacts.length ? '正在更新，保留当前文件' : '正在读取…' : query ? `已加载文件中找到 ${visibleFiles.length} 项` : page.total !== null ? `${label} · ${page.total} 个文件` : ''}</p>
        {notice && <p className="ba-artifact-status" role="status">{notice}</p>}
        {!!visibleFiles.length && <div className="ba-artifact-batch"><Button variant="ghost" disabled={busy || loading} onClick={() => setChecked(checked.length === visibleFiles.length ? [] : visibleFiles.map(file => file.name))}>{checked.length === visibleFiles.length && checked.length ? '取消全选' : query ? '全选当前结果' : '全选已加载文件'}</Button>{!!checked.length && <><span>已选 {checked.length} 个</span><Button variant="destructive" disabled={busy || loading} onClick={() => { setOperationError(''); setOperation({ type: 'batchDelete', files: page.artifacts.filter(file => checked.includes(file.name)) }); }}>删除所选</Button></>}</div>}
        {error && <div className="ba-artifact-error" role="alert"><UIIcon name="box" size={20} /><div><strong>文件读取或操作未完成</strong><span>{error}{page.artifacts.length > 0 ? '。当前保留上次读取的文件，可在页眉重试。' : '。请在页眉重试。'}</span></div></div>}
        {loading && !page.artifacts.length && <Loading className="ba-artifact-loading" label="正在整理工作区文件…" />}
        {!loading && !error && !query && !page.artifacts.length && <div className="ba-artifact-empty"><span className="ba-artifact-empty-icon" aria-hidden="true"><UIIcon name="box" size={26} /></span><strong>暂无{label}产物</strong><p>让助手创建{label}并保存到工作区，完成后即可在这里查看与下载。</p></div>}
        {query && !visibleFiles.length && !loading && <div className="ba-artifact-empty"><span className="ba-artifact-empty-icon"><UIIcon name="search" size={26} /></span><strong>没有匹配的文件</strong><p>{page.nextCursor ? '当前仅筛选已加载文件，可继续加载或更换名称。' : '试试其他名称，或清空搜索查看全部文件。'}</p></div>}
        {!!visibleFiles.length && <div className={`ba-artifact-files ba-artifact-${view}`} role="list" aria-label={`${label}文件列表`}>
          {visibleFiles.map(file => <article className="ba-artifact-file" role="listitem" key={file.id || file.name}>
            <input className="ba-artifact-checkbox" type="checkbox" aria-label={`选择 ${file.name}`} checked={checked.includes(file.name)} disabled={busy || loading} onChange={event => setChecked(previous => event.target.checked ? [...previous, file.name] : previous.filter(name => name !== file.name))} />
            <ArtifactCover file={file} category={category} onOpen={event => open(file, event)} />
            <FileDetails file={file} onOpen={event => open(file, event)} />
            {category === 'audio' && <audio controls preload="none" src={file.url} aria-label={file.name}>浏览器无法播放此格式，请下载文件。</audio>}
            <div className="ba-artifact-actions"><Tooltip label="下载" side="top" delayMs={350} portal><a className="ba-artifact-download" href={downloadUrl(file)} download aria-label={`下载 ${file.name}`}><IconDownloadOutlineRegular size={18} /></a></Tooltip><Button variant="ghost" type="button" className="ba-artifact-menu-trigger" aria-label={`管理 ${file.name}`} aria-haspopup="menu" aria-expanded={!!menu && (menu.id || menu.name) === (file.id || file.name)} onClick={event => { menuAnchor.current = event.currentTarget; setMenu(file); }}><UIIcon name="more" size={18} /></Button></div>
          </article>)}
        </div>}
        {page.nextCursor && <Button variant="ghost" type="button" className="ba-quiet ba-artifact-more" disabled={loading} onClick={() => void load(category, page.nextCursor)}>{loading ? '正在读取…' : '加载更多'}</Button>}
      </div>
    </div>
    {selected && <div className="ba-artifact-preview-dialog" role="region" aria-label={`预览 ${selected.name}`}><ArtifactPreview file={selected} onClose={close} /></div>}
    <Menu open={!!menu} onClose={() => setMenu(null)} anchor={null} getAnchorRect={() => menuAnchor.current?.getBoundingClientRect() ?? null} side="bottom" align="end" portal autoFocus compact>
      {menu && <div className="ba-artifact-menu">{[['rename', '重命名'], ['copy', '创建副本']].map(([type, text]) => <Button key={type} variant="ghost" role="menuitem" onClick={() => beginOperation(type, menu)}>{text}</Button>)}<Button variant="ghost" role="menuitem" onClick={() => void copyPath(menu)}>复制相对路径</Button><Button variant="ghost" role="menuitem" className="ba-artifact-delete" onClick={() => beginOperation('delete', menu)}>删除</Button></div>}
    </Menu>
    <Modal open={!!operation} title={operationTitle} closeLabel="关闭" onClose={() => { if (!busy) setOperation(null); }} footer={<><Button variant="ghost" disabled={busy} onClick={() => setOperation(null)}>取消</Button><Button variant={deleting ? 'destructive' : 'default'} disabled={busy || (!deleting && !filename.trim())} onClick={submitOperation}>{busy ? '处理中…' : deleting ? '删除' : '保存'}</Button></>}>
      <form className="ba-artifact-form" onSubmit={submitOperation}>{deleting ? <><p>{operation.type === 'batchDelete' ? `确定删除所选 ${operation.files.length} 个文件？` : `确定删除「${operation.file.name}」？`}此操作无法撤销。</p>{operation.type === 'batchDelete' && <ul className="ba-artifact-delete-list">{operation.files.map(file => <li key={file.name}>{file.name}</li>)}</ul>}</> : <label>文件名<input autoFocus value={filename} disabled={busy} onChange={event => setFilename(event.target.value)} /></label>}{operationError && <p role="alert">{operationError}</p>}</form>
    </Modal>
  </section>;
}
