import { Loading } from '../../shared/client/ui/loading.jsx';
import { Button } from '../../shared/client/ui/index.jsx';
import React, { useEffect, useId, useRef, useState } from 'react';
import { LinkIconMedium, Menu, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { Tooltip as BubbleTooltip } from '../../shared/client/ui/tooltip.jsx';
import { UIIcon } from './iconsax.jsx';

export function ProjectDialog({ title = '添加项目', busy = false, onClose, children, className = '' }) {
  const close = () => { if (!busy) onClose(); };
  return <Modal open headless onClose={close} title={title} className={'cmd-project-dialog ' + className}>
    <header className="cmd-project-header"><h2>{title}</h2><button type="button" className="cmd-project-icon-button" aria-label="关闭" disabled={busy} onClick={close}><UIIcon name="close" size={16} /></button></header>
    <div className="cmd-project-content">{children}</div>
  </Modal>;
}

function startFolderDrag(event, entry, panel, list, preview, onDrop, onEnd, onStart) {
  const source = event.currentTarget, doc = source.ownerDocument, win = doc.defaultView;
  const touch = event.pointerType === 'touch';
  if (event.button !== 0 || !event.isPrimary || touch && !event.target.closest('.cmd-folder-drag-handle')) return;
  const { pointerId, clientX: startX, clientY: startY } = event;
  let x = startX, y = startY, active = false, target, frame;
  const update = () => {
    preview.style.transform = `translate3d(${x + 12}px, ${y + 12}px, 0)`;
    const candidate = doc.elementFromPoint(x, y)?.closest('[data-folder-drop]');
    const next = candidate && panel.contains(candidate) && candidate.dataset.folderDrop !== entry.path ? candidate : undefined;
    if (next === target) return;
    target?.removeAttribute('data-drag-over');
    target = next;
    target?.setAttribute('data-drag-over', '');
  };
  const tick = () => {
    const { top, bottom, left, right } = list.getBoundingClientRect();
    if (x >= left && x <= right && y >= top && y <= bottom) {
      const edge = 24;
      const delta = y < top + edge ? (y - top - edge) / 3 : y > bottom - edge ? (y - bottom + edge) / 3 : 0;
      if (delta) {
        const priorScroll = list.scrollTop;
        list.scrollTop += delta;
        if (list.scrollTop !== priorScroll) update();
      }
    }
    frame = win.requestAnimationFrame(tick);
  };
  const activate = () => {
    active = true;
    source.setPointerCapture?.(pointerId);
    win.addEventListener('keydown', escape, true);
    source.setAttribute('data-folder-dragging', '');
    preview.textContent = entry.name;
    preview.hidden = false;
    onStart();
    update();
    frame = win.requestAnimationFrame(tick);
  };
  const move = e => {
    if (e.pointerId !== pointerId) return;
    x = e.clientX; y = e.clientY;
    if (!active && Math.hypot(x - startX, y - startY) > 6) {
      if (touch) { cancel(); return; }
      activate();
    }
    if (active) update();
  };
  const release = e => {
    if (e.pointerId !== pointerId) return;
    if (active) { x = e.clientX; y = e.clientY; update(); }
    const destination = target?.dataset.folderDrop;
    cancel();
    if (destination) onDrop(destination);
  };
  const pointerCancel = e => { if (e.pointerId === pointerId) cancel(); };
  const escape = e => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  const cancel = () => {
    win.clearTimeout(hold);
    win.cancelAnimationFrame(frame);
    win.removeEventListener('pointermove', move);
    win.removeEventListener('pointerup', release);
    win.removeEventListener('pointercancel', pointerCancel);
    win.removeEventListener('blur', cancel);
    if (active) win.removeEventListener('keydown', escape, true);
    if (source.hasPointerCapture?.(pointerId)) source.releasePointerCapture(pointerId);
    source.removeAttribute('data-folder-dragging');
    target?.removeAttribute('data-drag-over');
    preview.hidden = true;
    onEnd();
  };
  const hold = touch ? win.setTimeout(activate, 350) : undefined;
  win.addEventListener('pointermove', move);
  win.addEventListener('pointerup', release);
  win.addEventListener('pointercancel', pointerCancel);
  win.addEventListener('blur', cancel);
  return cancel;
}

/** Browsing selects host folders; a remote target must never use the local desktop chooser. */
export function ProjectPicker({ api, onClose, onSelected, embedded = false, onBusyChange, draft, onDraftChange, allowDesktop = true, toolbarEnd }) {
  const [tab, setTab] = useState(draft?.tab || 'browse'), [listing, setListing] = useState(null), [roots, setRoots] = useState([]), [query, setQuery] = useState('');
  const [url, setUrl] = useState(draft?.url || ''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [browseError, setBrowseError] = useState('');
  const generation = useRef(0), mounted = useRef(true), browseTarget = useRef(), id = useId();
  const [menu, setMenu] = useState(null), [editor, setEditor] = useState(null), [name, setName] = useState('');
  const [folderBusy, setFolderBusy] = useState(false), [notice, setNotice] = useState('');
  const panel = useRef(null), list = useRef(null), dragPreview = useRef(null), drag = useRef(null), suppressClick = useRef(false);
  const createButton = useRef(null), editorControl = useRef(null), returnTo = useRef(null), focusAfterBrowse = useRef(null);
  const locked = busy || folderBusy;
  const desktop = allowDesktop && globalThis.__DSH_DIRECTORY_PICKER__;
  const browse = async (path, { refresh = false } = {}) => {
    drag.current?.(); setMenu(null);
    const version = ++generation.current; browseTarget.current = path; setLoading(true); setBrowseError('');
    if (!refresh) { setError(''); setQuery(''); setNotice(''); }
    try { const result = await api('browse', path ? { path } : {}); if (mounted.current && version === generation.current) { setListing(result); setRoots(result.roots ?? []); } }
    catch (e) { if (mounted.current && version === generation.current) { setListing(null); setBrowseError(e.message); } }
    finally { if (mounted.current && version === generation.current) setLoading(false); }
  };
  useEffect(() => { mounted.current = true; void browse(); return () => { mounted.current = false; generation.current++; drag.current?.(); }; }, []);
  useEffect(() => { onBusyChange?.(locked); }, [locked, onBusyChange]);
  useEffect(() => { onDraftChange?.({ tab, url }); }, [tab, url, onDraftChange]);
  useEffect(() => {
    if (loading || locked || !focusAfterBrowse.current) return;
    const path = focusAfterBrowse.current;
    focusAfterBrowse.current = null;
    const row = [...(list.current?.querySelectorAll('[data-folder-path]') ?? [])].find(node => node.dataset.folderPath === path);
    (row || createButton.current)?.focus();
  }, [loading, locked]);
  useEffect(() => {
    if (editor) {
      editorControl.current?.focus();
      if (editor.operation === 'rename') editorControl.current?.select();
    } else {
      returnTo.current?.focus();
      returnTo.current = null;
    }
  }, [editor]);
  const add = async operation => {
    if (locked) return; setBusy(true); setError('');
    try { const result = await operation(); if (mounted.current && result?.project) await onSelected(result.project); }
    catch (e) { if (mounted.current) setError(e.message); }
    finally { if (mounted.current) setBusy(false); }
  };
  const select = () => add(() => api('project', { path: listing.path }));
  const pick = () => add(async () => { const path = await desktop.pick(); return path ? api('project', { path }) : null; });
  const clone = e => { e.preventDefault(); void add(() => api('clone', { url: url.trim() })); };
  const changeTab = value => {
    if (locked) return;
    drag.current?.(); setMenu(null); setEditor(null); setTab(value); setError(''); setNotice('');
  };
  const tabKeys = e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 'browse' : e.key === 'End' ? 'github' : tab === 'browse' ? 'github' : 'browse';
    changeTab(next); document.getElementById(`${id}-${next}-tab`)?.focus();
  };
  const entries = (listing?.entries ?? []).filter(entry => entry.name.toLowerCase().includes(query.trim().toLowerCase()));
  const folderName = listing?.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || listing?.path;
  const management = listing?.folderManagement === true;
  const canManage = management && !loading && !locked && !editor;
  const navigate = path => { setEditor(null); void browse(path); };
  const openMenu = (event, entry, fromButton = false) => {
    if (!canManage) return;
    event.preventDefault();
    if (suppressClick.current) return;
    const control = event.currentTarget;
    const anchor = control.matches('button') ? control : control.querySelector('.cmd-folder-entry');
    const { left, bottom } = anchor.getBoundingClientRect();
    const pointer = !fromButton && event.type === 'contextmenu' && (event.clientX || event.clientY);
    setMenu({ entry, anchor, point: pointer ? { x: event.clientX, y: event.clientY } : { x: left, y: bottom } });
  };
  const edit = (operation, entry, anchor) => {
    setError(''); setNotice(''); setMenu(null);
    setName(operation === 'rename' ? entry.name : '');
    setEditor({ operation, entry, anchor });
  };
  const dismissEditor = () => {
    returnTo.current = editor.anchor;
    setEditor(null); setError('');
  };
  const changeFolder = async (operation, { directory = listing.path, path, name, destination } = {}) => {
    if (locked || loading) return;
    setFolderBusy(true); setError(''); setNotice('');
    try {
      const result = await api('folder', { operation, directory, path, name, destination });
      if (!mounted.current) return;
      setEditor(null);
      if (operation === 'create' || operation === 'rename') setQuery('');
      focusAfterBrowse.current = operation === 'move' ? destination
        : operation === 'create' && directory !== listing.path ? directory : result?.path || listing.path;
      setNotice({ create: '已新建文件夹', rename: '已重命名文件夹', move: '已移动文件夹', delete: '已删除文件夹' }[operation]);
      await browse(listing.path, { refresh: true });
    } catch (e) {
      if (mounted.current) setError(e.message);
    } finally {
      if (mounted.current) setFolderBusy(false);
    }
  };
  const menuItems = menu && [
    { id: 'open', label: '打开', icon: <UIIcon name="folderOpen" size={16} /> },
    ...(!menu.entry.link ? [
      { id: 'create', label: '新建文件夹', icon: <UIIcon name="plus" size={16} /> },
      { id: 'rename', label: '重命名', icon: <UIIcon name="edit" size={16} /> },
      ...(listing?.parent ? [{ id: 'move', label: '移到上一级', icon: <UIIcon name="chevronLeft" size={16} /> }] : []),
      { id: 'delete', label: '删除', icon: <UIIcon name="trash" size={16} />, danger: true },
    ] : []),
  ];
  const chooseFolderAction = operation => {
    const { entry, anchor } = menu;
    setMenu(null);
    if (operation === 'open') navigate(entry.path);
    else if (operation === 'move') void changeFolder(operation, { path: entry.path, destination: listing.parent });
    else edit(operation, entry, anchor);
  };
  const pointerDown = (event, entry) => {
    if (!canManage || entry.link || drag.current) return;
    drag.current = startFolderDrag(event, entry, panel.current, list.current, dragPreview.current,
      destination => void changeFolder('move', { path: entry.path, destination }),
      () => { drag.current = null; },
      () => { suppressClick.current = true; setMenu(null); });
  };
  const folderKeys = (event, entry) => {
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') openMenu(event, entry);
  };
  const folderEditor = editor && <form className="cmd-folder-edit" aria-busy={folderBusy} onSubmit={event => {
    event.preventDefault();
    if (editor.operation !== 'delete' && !name.trim()) return;
    void changeFolder(editor.operation, {
      directory: editor.operation === 'create' && editor.entry ? editor.entry.path : listing.path,
      path: editor.operation === 'create' ? undefined : editor.entry.path,
      name: editor.operation === 'delete' ? undefined : name,
    });
  }}>
    {editor.operation === 'delete' ? <p>永久删除此文件夹及其内容？<strong>{editor.entry.path}</strong></p>
      : <label htmlFor={`${id}-folder-name`}>{editor.operation === 'rename' ? '重命名文件夹' : '新建文件夹'}
        <input ref={editorControl} id={`${id}-folder-name`} placeholder="文件夹名称" value={name} maxLength={255}
          disabled={folderBusy} onChange={event => setName(event.target.value)} />
      </label>}
    <div className="cmd-folder-edit-actions">
      <Button ref={editor.operation === 'delete' ? editorControl : undefined} type="button" variant="ghost" size="sm" onClick={dismissEditor} disabled={folderBusy}>取消</Button>
      <Button type="submit" variant={editor.operation === 'delete' ? 'destructive' : 'default'} size="sm" disabled={folderBusy || editor.operation !== 'delete' && !name.trim()}>
        {folderBusy ? '处理中…' : { create: '创建', rename: '保存', delete: '永久删除' }[editor.operation]}
      </Button>
    </div>
  </form>;
  const content = <>
    <div className="cmd-project-toolbar">
      <div className="cmd-project-tabs" role="tablist" aria-label="添加方式">
        <button type="button" role="tab" id={`${id}-browse-tab`} aria-controls={`${id}-browse-panel`} aria-selected={tab === 'browse'} tabIndex={tab === 'browse' ? 0 : -1} onKeyDown={tabKeys} onClick={() => changeTab('browse')} disabled={locked}><UIIcon name="folderOpen" size={16} selected={tab === 'browse'} />文件夹</button>
        <button type="button" role="tab" id={`${id}-github-tab`} aria-controls={`${id}-github-panel`} aria-selected={tab === 'github'} tabIndex={tab === 'github' ? 0 : -1} onKeyDown={tabKeys} onClick={() => changeTab('github')} disabled={locked}><LinkIconMedium kind="url" href="https://github.com" size={16} />GitHub</button>
      </div>
      {toolbarEnd}
    </div>
      {tab === 'browse' ? <div ref={panel} className="cmd-folder-browser" role="tabpanel" id={`${id}-browse-panel`} aria-labelledby={`${id}-browse-tab`}
        onPointerDownCapture={() => { if (!drag.current) suppressClick.current = false; }}
        onClickCapture={event => {
          if (suppressClick.current && event.detail) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; }
        }}
        onKeyDown={event => {
          if (editor && !locked && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissEditor(); }
        }}>
        {roots.length > 0 && <div className="cmd-folder-roots" role="group" aria-label="磁盘"><span>磁盘</span>{roots.map(root => <BubbleTooltip key={root.path} label={root.path} portal><button type="button" className="cmd-folder-root" aria-label={`打开磁盘 ${root.name}`} disabled={loading || locked} onClick={() => navigate(root.path)}>{root.name}</button></BubbleTooltip>)}</div>}
        <div className="cmd-folder-location">
          <Tooltip label="上一级" portal><button type="button" className="cmd-project-icon-button" aria-label="上一级" data-folder-drop={canManage ? listing.parent || undefined : undefined} disabled={!listing?.parent || loading || locked} onClick={() => navigate(listing.parent)}><UIIcon name="chevronLeft" size={16} /></button></Tooltip>
          <BubbleTooltip label={listing?.path} portal><span aria-label="当前目录" tabIndex={listing ? 0 : undefined}>{listing?.path ?? '选择文件夹'}</span></BubbleTooltip>
          {management && <button ref={createButton} type="button" className="cmd-project-icon-button cmd-folder-create" onClick={event => edit('create', null, event.currentTarget)} disabled={!canManage}><UIIcon name="plus" size={16} />新建文件夹</button>}
          {desktop && <Tooltip label="系统选择文件夹" portal><button type="button" className="cmd-project-icon-button" aria-label="系统选择文件夹" onClick={() => void pick()} disabled={locked || !!editor}><UIIcon name="external" size={16} /></button></Tooltip>}
        </div>
        <label className="cmd-folder-search"><UIIcon name="search" size={16} /><input type="search" data-modal-autofocus aria-label="搜索文件夹" placeholder="搜索文件夹" value={query} onChange={e => { drag.current?.(); setMenu(null); setQuery(e.target.value); }} disabled={locked || loading || !listing} /></label>
        {folderEditor}
        <div ref={list} className="cmd-folder-entries" aria-label="文件夹列表" aria-busy={loading || folderBusy}>
          {loading ? <Loading className="cmd-folder-empty" label="正在读取…" /> : browseError ? <div className="cmd-folder-empty" role="alert"><span>无法读取目录</span><span className="cmd-folder-error-detail">{browseError}</span><button type="button" className="cmd-folder-retry" onClick={() => navigate(browseTarget.current)} disabled={locked}>重试</button></div> : entries.length ? entries.map(entry =>
            <div className="cmd-folder-row" key={entry.path} data-folder-drop={canManage && !entry.link ? entry.path : undefined} onContextMenu={event => openMenu(event, entry)}>
              <BubbleTooltip label={entry.name} portal><button type="button" className="cmd-folder-entry" data-folder-path={entry.path} disabled={locked}
                onClick={() => navigate(entry.path)} onPointerDown={event => pointerDown(event, entry)} onKeyDown={event => folderKeys(event, entry)}>
                <span className={canManage && !entry.link ? 'cmd-folder-drag-handle' : 'cmd-folder-entry-icon'}><UIIcon name="folder" size={17} /></span>
                <span className="cmd-folder-entry-name">{entry.name}</span><UIIcon name="chevronDown" size={12} className="cmd-folder-next" />
              </button></BubbleTooltip>
              {management && <button type="button" className="cmd-project-icon-button cmd-folder-more" aria-label={`${entry.name}的文件夹操作`} aria-haspopup="menu"
                aria-expanded={menu?.entry === entry} disabled={!canManage} onClick={event => openMenu(event, entry, true)}><UIIcon name="more" size={16} /></button>}
            </div>) : <div className="cmd-folder-empty" role="status">{query.trim() ? '未找到文件夹' : '此目录没有子文件夹'}</div>}
        </div>
        <div className="cmd-folder-drag-preview" ref={dragPreview} hidden aria-hidden="true" />
        {menu && <Menu open portal contextual compact dense autoFocus anchor={null} anchorPoint={menu.point} returnFocus={() => menu.anchor}
          items={menuItems} onClose={() => setMenu(null)} onSelect={chooseFolderAction} />}
        {error && <div className="cmd-project-error" role="alert">{error}</div>}
        <div className="cmd-project-submit"><BubbleTooltip label={listing?.path} portal><div className="cmd-project-selection" tabIndex={listing ? 0 : undefined}><span>当前文件夹</span><strong>{listing ? folderName : '尚未选择'}</strong></div></BubbleTooltip><Button type="button" className="cmd-dialog-button cmd-dialog-primary" disabled={!listing || loading || locked || !!editor} onClick={() => void select()}>{busy ? '添加中…' : '添加项目'}</Button></div>
        <span className="cmd-folder-announcement" role="status">{notice}</span>
      </div> : <form className="cmd-github-form" role="tabpanel" id={`${id}-github-panel`} aria-labelledby={`${id}-github-tab`} onSubmit={clone}>
        <label htmlFor={`${id}-repo`}>仓库地址</label><input id={`${id}-repo`} type="url" required placeholder="https://github.com/owner/repo" aria-describedby={`${id}-github-hint`} value={url} onChange={e => setUrl(e.target.value)} disabled={busy} />
        <p id={`${id}-github-hint`}>私有仓库需配置 Git 凭据。</p>
        {error && <div className="cmd-project-error" role="alert">{error}</div>}
        <div className="cmd-project-submit"><Button type="submit" className="cmd-dialog-button cmd-dialog-primary" disabled={busy || !url.trim()}>{busy ? '克隆中…' : '克隆并添加'}</Button></div>
      </form>}
  </>;
  return embedded ? content : <ProjectDialog busy={locked} onClose={onClose}>{content}</ProjectDialog>;
}
