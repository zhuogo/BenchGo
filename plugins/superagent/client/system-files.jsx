import { Loading } from '../../shared/client/ui/loading.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import { Tooltip } from '../../shared/client/ui/tooltip.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { ResourceIcon } from '../../shared/client/resource-icon.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import css from './system-files.css';
import { ArtifactPreview } from '../../shared/client/artifact-preview.jsx';

const size = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
const modified = value => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fileType = entry => entry.type === 'directory' ? '文件夹' : entry.name.includes('.') ? entry.name.split('.').at(-1).toUpperCase() : '文件';

export function SystemFiles({ api, onPreviewChange }) {
  const [path, setPath] = useState(''), [revision, setRevision] = useState(0), [listing, setListing] = useState(null), [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const originButton = useRef(null), scrollPosition = useRef(0), root = useRef(null);
  const directoryViews = useRef(new Map()), loadedPath = useRef(null), restoreView = useRef(false);
  useEffect(() => { if (selected) root.current?.closest('.ba-studio-body')?.scrollTo({ top: 0 }); }, [selected]);
  useEffect(() => { onPreviewChange?.(!!selected); return () => onPreviewChange?.(false); }, [selected, onPreviewChange]);
  function back() {
    setSelected(null);
    requestAnimationFrame(() => { root.current?.closest('.ba-studio-body')?.scrollTo({ top: scrollPosition.current }); originButton.current?.focus({ preventScroll: true }); });
  }
  function navigate(next, focusPath) {
    if (next === path) return;
    directoryViews.current.set(path, { filter, top: root.current?.closest('.ba-studio-body')?.scrollTop || 0, focusPath });
    setPath(next);
  }
  useEffect(() => {
    if (busy || !listing || !restoreView.current) return;
    restoreView.current = false;
    const saved = directoryViews.current.get(path);
    const frame = requestAnimationFrame(() => {
      root.current?.closest('.ba-studio-body')?.scrollTo({ top: saved?.top || 0 });
      if (saved?.focusPath) [...(root.current?.querySelectorAll('[data-file-path]') || [])].find(node => node.dataset.filePath === saved.focusPath)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [busy, listing, path]);
  useEffect(() => {
    const controller = new AbortController();
    const changingDirectory = loadedPath.current !== path;
    loadedPath.current = path;
    if (changingDirectory) { setSelected(null); setListing(null); setFilter(directoryViews.current.get(path)?.filter || ''); restoreView.current = true; }
    setBusy(true); setError('');
    api('systemFiles', { op: 'list', path }, controller.signal).then(value => { if (!controller.signal.aborted) setListing(value); }).catch(cause => { if (!controller.signal.aborted) setError(cause.message || '读取系统文件失败'); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [api, path, revision]);
  function open(entry, button) {
    if (entry.available === false) return;
    if (entry.type === 'directory') { navigate(entry.path, entry.path); return; }
    if (button) { originButton.current = button; scrollPosition.current = root.current?.closest('.ba-studio-body')?.scrollTop || 0; }
    setSelected(entry);
  }
  const parts = path.split('/').filter(Boolean);
  const entries = (listing?.entries || []).filter(entry => entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const folders = entries.filter(entry => entry.type === 'directory'), files = entries.filter(entry => entry.type !== 'directory');
  const rows = [...folders, ...files];
  const count = `${folders.length} 个文件夹 · ${files.length} 个文件`;
  const loading = busy || (!listing && !error);
  return <section ref={root} className="ba-group ba-system-files" onKeyDown={event => { if (event.key === 'Escape' && selected) { event.stopPropagation(); back(); } }}>
    <style>{css}</style>
    <div hidden={!!selected}>
      <div className="ba-system-toolbar" role="region" aria-label="文件浏览工具">
        <nav className="ba-system-breadcrumb" aria-label="文件路径"><Button variant="ghost" type="button" onClick={() => navigate('')} aria-current={!path ? 'location' : undefined} aria-label="根目录"><UIIcon name="folder" size={16} />配置区</Button>{parts.map((part, index) => <React.Fragment key={`${part}-${index}`}><span aria-hidden="true">/</span><Button variant="ghost" type="button" aria-current={index === parts.length - 1 ? 'location' : undefined} onClick={() => navigate(parts.slice(0, index + 1).join('/'))}>{part}</Button></React.Fragment>)}</nav>
        <span className="ba-system-count" role="status" aria-live="polite">{busy ? '正在读取…' : listing ? count : ''}</span>
        <label className="ba-system-search"><UIIcon name="search" size={16} /><span>筛选</span><input type="search" aria-label="筛选当前目录文件" placeholder="查找当前目录" value={filter} onChange={event => setFilter(event.target.value)} /></label>
        <Button variant="outline" type="button" className="ba-system-refresh" aria-label="刷新系统文件" disabled={loading} onClick={() => setRevision(value => value + 1)}><UIIcon name="refresh" size={16} />{busy && listing ? '刷新中…' : error ? '重试' : '刷新'}</Button>
      </div>
      {error && <div className="ba-system-error" role="alert"><UIIcon name="close" size={20} /><div><strong>暂时无法读取此目录</strong><p>{error}{listing ? '。已保留上次读取的文件，请在工具栏重试。' : '。请在工具栏重试。'}</p></div></div>}
      <div className="ba-system-list" role="region" aria-label="目录内容" aria-busy={loading}>
        {loading && !listing && <Loading className="ba-system-loading" label="正在读取文件…" />}
        {!!rows.length && <table><caption className="ba-visually-hidden">当前目录文件</caption><thead><tr><th scope="col">名称</th><th scope="col">类型</th><th scope="col">大小</th><th scope="col">修改时间</th><th scope="col"><span className="ba-visually-hidden">操作</span></th></tr></thead><tbody>
          {folders.length > 0 && <tr className="ba-system-group"><th colSpan="5" scope="colgroup">文件夹</th></tr>}
          {folders.map(entry => <SystemFileRow key={entry.path} entry={entry} onOpen={open} className="ba-system-entry" />)}
          {files.length > 0 && <tr className="ba-system-group"><th colSpan="5" scope="colgroup">文件</th></tr>}
          {files.map(entry => <SystemFileRow key={entry.path} entry={entry} onOpen={open} className="ba-system-entry" />)}
        </tbody></table>}
        {!busy && !error && listing && !rows.length && <div className="ba-system-empty"><span className="ba-system-state-icon"><UIIcon name={filter ? 'search' : 'folderOpen'} size={28} /></span><strong>{filter ? '没有找到匹配的文件' : '这个目录还是空的'}</strong><p>{filter ? '试试其他名称，或清空筛选查看全部内容。' : '文件保存到这里后，就会显示在此处。'}</p>{filter ? <Button variant="outline" type="button" onClick={() => setFilter('')}>清空筛选</Button> : path && <Button variant="outline" type="button" onClick={() => navigate(parts.slice(0, -1).join('/'))}>返回上一级</Button>}</div>}
      </div>
    </div>
    {selected && <div className="ba-system-preview-dialog" role="region" aria-label={`预览 ${selected.name}`}><ArtifactPreview file={selected} onClose={back} /></div>}
  </section>;
}

function SystemFileRow({ entry, onOpen, className }) {
  return <tr className={className || 'ba-system-row'} data-available={entry.available !== false} onClick={event => onOpen(entry, event.currentTarget.querySelector('.ba-system-trigger'))}>
    <th scope="row" data-label="名称"><Button variant="ghost" type="button" className="ba-system-trigger" data-file-path={entry.path} disabled={entry.available === false} title={entry.available === false ? '文件超过 25 MB，暂不支持在线读取' : entry.name} onClick={event => { event.stopPropagation(); onOpen(entry, event.currentTarget); }}><span aria-hidden="true">{entry.type === 'directory' ? <UIIcon name="folder" size={20} /> : <ResourceIcon name="document" size={20} />}</span><strong>{entry.name}</strong></Button></th>
    <td className="ba-system-type" data-label="类型"><Tooltip label={entry.available === false ? '文件超过 25 MB，暂不支持在线读取' : ''} portal><span className="ba-system-file-badge" tabIndex={entry.available === false ? 0 : undefined}>{entry.available === false ? '超出读取上限' : fileType(entry)}</span></Tooltip></td>
    <td className="ba-system-size" data-label="大小">{entry.type === 'directory' ? '—' : size(entry.bytes)}</td>
    <td className="ba-system-time" data-label="修改时间"><time dateTime={entry.updatedAt}>{modified(entry.updatedAt)}</time></td>
    <td className="ba-system-open" aria-hidden="true">→</td>
  </tr>;
}
