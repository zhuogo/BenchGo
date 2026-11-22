import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from '../../../shared/client/ui/index.jsx';
import { UIIcon } from '../../client/iconsax.jsx';
import { readJsonResponse } from '../../client/http-response.mjs';
import { sessionDirectory } from '../../../../deepseek-harness/packages/api/session-controller/src/client/sessions/directories.ts';
import css from './project-files.css';

const navigatorSelector = '[data-files-navigator], [data-benchgo-file-tree]';
const rowSelector = '[data-files-entry][data-files-path], [data-benchgo-file-kind]';
const dragType = 'application/x-benchgo-project-file';
const labels = {
  'new-file': '新建文件', 'new-folder': '新建文件夹', rename: '重命名',
  delete: '永久删除', move: '移动到…', paste: '粘贴到此处',
};
const success = {
  'new-file': '文件已建立', 'new-folder': '文件夹已建立', rename: '已重命名',
  delete: '已删除', move: '已移动', copy: '已粘贴',
};
const isWindowsPath = path => /^[a-z]:[\\/]|^\\\\/i.test(path);
function pathKey(path, workspace) {
  const value = isWindowsPath(workspace) ? path.replaceAll('\\', '/').toLowerCase() : path;
  return value.replace(/\/$/, '');
}
function sameWorkspace(left, right) {
  return pathKey(left.workspace, left.workspace) === pathKey(right.workspace, left.workspace);
}
function baseName(path, workspace) {
  return (isWindowsPath(workspace) ? path.replaceAll('\\', '/') : path).split('/').filter(Boolean).at(-1) ?? path;
}
function joinPath(path, name) {
  return path.endsWith('/') || path.endsWith('\\') && isWindowsPath(path) ? path + name : path + '/' + name;
}
function inside(source, target) {
  const root = pathKey(source, target.workspace), candidate = pathKey(target.path, target.workspace);
  return candidate === root || candidate.startsWith(root + '/');
}
function canMove(source, target) {
  return target?.kind === 'directory' && sameWorkspace(source, target) && !inside(source.path, target)
    && pathKey(joinPath(target.path, baseName(source.path, source.workspace)), source.workspace) !== pathKey(source.path, source.workspace);
}

async function fileRequest(target, action, data, signal) {
  const url = new URL('api/benchgo/workbench/files', document.baseURI);
  const response = await fetch(url, {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, sessionId: target.sessionId, workspace: target.workspace, path: target.path, ...data }),
    signal,
  });
  return readJsonResponse(response, url);
}

function readRow(element, includeRoot = false) {
  const tree = element instanceof Element ? element.closest(navigatorSelector) : undefined;
  if (!tree) return undefined;
  const vendor = tree.hasAttribute('data-benchgo-file-tree');
  const workspace = vendor ? tree.dataset.benchgoFileTree : tree.dataset.filesRoot;
  const sessionId = vendor ? tree.dataset.benchgoFileSession
    : tree.closest('[data-sidebar-right-session]')?.dataset.sidebarRightSession;
  if (!workspace || !sessionId) return undefined;
  const row = element.closest(rowSelector);
  // Nested list items wrap their children and empty-state rows.
  if (row && (vendor || row.firstElementChild?.contains(element))) {
    const kind = vendor ? row.dataset.benchgoFileKind : row.dataset.filesEntry;
    const path = vendor ? row.dataset.benchgoFilePath : row.dataset.filesPath;
    if (path && (kind === 'file' || kind === 'directory')) return { sessionId, workspace, path, kind, row, vendor };
    return undefined;
  }
  return includeRoot ? { sessionId, workspace, path: workspace, kind: 'directory', row: tree, vendor } : undefined;
}

function FolderPicker({ target, parts, setParts, busy, lifetime, setDestination }) {
  const path = parts.reduce(joinPath, target.workspace);
  const [listing, setListing] = useState();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, lifetime, AbortSignal.timeout(20000)]);
    fileRequest({ ...target, path }, 'folders', undefined, signal).then(
      result => { if (!signal.aborted) setListing({ path, folders: result.folders }); },
      error => { if (!controller.signal.aborted && !lifetime.aborted) setListing({ path, error: error.message }); },
    );
    return () => controller.abort();
  }, [target, path, revision, lifetime]);
  const current = listing?.path === path ? listing : undefined;
  useEffect(() => setDestination(current?.folders ? path : undefined), [current, path, setDestination]);
  return <div className="bg-project-picker">
    <div className="bg-project-picker-location">
      <Button size="sm" variant="outline" disabled={busy || !parts.length} onClick={() => setParts(parts.slice(0, -1))}>上一级</Button>
      <span title={path}>{path}</span>
    </div>
    <div className="bg-project-picker-list">
      {!current && <p role="status">正在读取文件夹…</p>}
      {current?.error && <p role="alert">{current.error} <Button size="sm" variant="ghost" onClick={() => { setListing(undefined); setRevision(value => value + 1); }}>重试</Button></p>}
      {current?.folders?.length === 0 && <p>没有子文件夹</p>}
      {current?.folders?.map(name => {
        const next = joinPath(path, name);
        return <Button key={name} variant="ghost" disabled={busy || inside(target.path, { ...target, path: next })} onClick={() => setParts([...parts, name])}>
          <UIIcon name="folder" size={16} /><span>{name}</span>
        </Button>;
      })}
    </div>
  </div>;
}

function FileOperationDialog({ service, dialog }) {
  const { action, target } = dialog;
  const [name, setName] = useState(action === 'rename' ? baseName(target.path, target.workspace) : '');
  const [parts, setParts] = useState([]);
  const [destination, setDestination] = useState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [device, setDevice] = useState(service.device);
  const naming = action === 'rename' || action === 'new-file' || action === 'new-folder';
  const moving = action === 'move';
  const deleting = action === 'delete';
  const label = labels[action];
  useEffect(() => {
    if (!deleting) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, service.signal, AbortSignal.timeout(5000)]);
    fileRequest(target, 'target', undefined, signal).then(
      result => { if (!signal.aborted && result.device) setDevice(result.device); },
      () => {},
    );
    return () => controller.abort();
  }, [deleting, service, target]);
  const disabled = busy || naming && !name.trim()
    || moving && (!destination || !canMove(target, { ...target, kind: 'directory', path: destination }));
  async function submit(event) {
    event.preventDefault();
    if (disabled) return;
    setBusy(true);
    setError('');
    try {
      await service.perform(target, action, naming ? { name } : moving ? { destination } : undefined);
      service.close(dialog);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) service.close(dialog); }}>
    <DialogContent className="bg-project-file-dialog" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onInteractOutside={event => event.preventDefault()}
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (dialog.origin?.isConnected) dialog.origin.focus({ preventScroll: true });
      }}>
      <DialogTitle>{moving ? '移动到文件夹' : label}</DialogTitle>
      <DialogDescription asChild><div className="bg-project-file-description">
        <span>{deleting ? device + ' · ' : ''}{target.path}</span>
        {deleting && <span>{target.kind === 'directory' ? '此文件夹及其内容将被永久删除。' : '此文件将被永久删除。'}</span>}
      </div></DialogDescription>
      <form onSubmit={submit}>
        {naming && <label className="bg-project-file-name">
          <span>{action === 'new-folder' || target.kind === 'directory' && action === 'rename' ? '文件夹名称' : '文件名称'}</span>
          <input value={name} autoFocus disabled={busy} onFocus={event => {
            if (action !== 'rename') return;
            const dot = name.lastIndexOf('.');
            event.target.setSelectionRange(0, target.kind === 'file' && dot > 0 ? dot : name.length);
          }} onChange={event => setName(event.target.value)} />
        </label>}
        {moving && <FolderPicker target={target} parts={parts} setParts={next => { setDestination(undefined); setParts(next); }} busy={busy} lifetime={service.signal} setDestination={setDestination} />}
        {error && <p className="bg-project-file-error" role="alert">{error}</p>}
        <div className="bg-project-file-footer">
          <Button variant="outline" disabled={busy} onClick={() => service.close(dialog)}>取消</Button>
          <Button type="submit" variant={deleting ? 'destructive' : 'default'} disabled={disabled} aria-busy={busy}>
            {busy ? '正在处理…' : moving ? '移到此处' : label}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}

function FileOperationOverlay({ service }) {
  const dialog = useSyncExternalStore(service.subscribe, service.snapshot);
  return <><style>{css}</style>{dialog && <FileOperationDialog key={dialog.id} service={service} dialog={dialog} />}</>;
}

function FilesMenuButton({ absolutePath, sessionId, service }) {
  return <Button size="icon" variant="ghost" className="bg-project-files-toolbar" aria-label="项目文件操作" aria-haspopup="menu"
    onClick={event => service.openMenu('directory', { sessionId, path: absolutePath }, event.currentTarget)}>
    <UIIcon name="more" size={16} />
  </Button>;
}

function mountFileTreeEvents(service) {
  let dragged, highlighted;
  const managed = new Map();
  const clearHighlight = () => { highlighted?.removeAttribute('data-benchgo-drop-target'); highlighted = undefined; };
  const endDrag = () => { dragged = undefined; clearHighlight(); };
  const decorate = row => {
    if (!row.isConnected || managed.has(row)) return;
    const handle = row.hasAttribute('data-benchgo-file-kind') ? row : row.firstElementChild;
    const target = readRow(handle);
    if (!target) return;
    const previous = handle.getAttribute('draggable');
    handle.setAttribute('draggable', 'true');
    row.setAttribute('data-benchgo-draggable', '');
    managed.set(row, { handle, previous });
    if (target.vendor) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'bg-project-file-more';
    button.setAttribute('aria-label', '文件操作');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('draggable', 'false');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('aria-hidden', 'true');
    for (const x of [4, 8, 12]) {
      const dot = document.createElementNS(icon.namespaceURI, 'circle');
      dot.setAttribute('cx', x); dot.setAttribute('cy', '8'); dot.setAttribute('r', '1');
      icon.append(dot);
    }
    button.append(icon);
    handle.append(button);
  };
  const undecorate = row => {
    const { handle, previous } = managed.get(row);
    if (previous === null) handle.removeAttribute('draggable');
    else handle.setAttribute('draggable', previous);
    handle.querySelector('.bg-project-file-more')?.remove();
    row.removeAttribute('data-benchgo-draggable');
    managed.delete(row);
  };
  const update = nodes => {
    for (const node of nodes) {
      if (!(node instanceof Element)) continue;
      if (node.matches(rowSelector)) decorate(node);
      for (const row of node.querySelectorAll(rowSelector)) decorate(row);
    }
  };
  update([document.body]);
  const observer = new MutationObserver(records => {
    for (const { addedNodes, removedNodes, target } of records) {
      for (const node of removedNodes) if (node instanceof Element) {
        if (managed.has(node) && !node.isConnected) undecorate(node);
        for (const row of node.querySelectorAll('[data-benchgo-draggable]')) if (!row.isConnected) undecorate(row);
      }
      if (managed.has(target) && managed.get(target).handle !== target.firstElementChild && !target.hasAttribute('data-benchgo-file-kind')) {
        undecorate(target);
        decorate(target);
      }
      update(addedNodes);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  function dragStart(event) {
    const target = readRow(event.target);
    if (!target || !event.dataTransfer) return;
    if (pathKey(target.path, target.workspace) === pathKey(target.workspace, target.workspace)
      || event.target.closest('.bg-project-file-more, [data-benchgo-file-kind] button')) {
      event.preventDefault();
      return;
    }
    dragged = target;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(dragType, 'move');
  }
  function dropTarget(event) {
    if (!dragged || !event.dataTransfer?.types.includes(dragType)) return;
    // Leave file rows alone. The empty tree area can act as the project root.
    const target = readRow(event.target, true);
    return canMove(dragged, target) ? target : undefined;
  }
  function dragOver(event) {
    const target = dropTarget(event);
    if (!target) { clearHighlight(); return; }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    if (highlighted === target.row) return;
    clearHighlight();
    highlighted = target.row;
    highlighted.setAttribute('data-benchgo-drop-target', '');
  }
  function drop(event) {
    const target = dropTarget(event), source = dragged;
    endDrag();
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    void service.run(source, 'move', { destination: target.path });
  }
  function dragLeave(event) {
    if (highlighted && (!(event.relatedTarget instanceof Node) || !highlighted.contains(event.relatedTarget))) clearHighlight();
  }
  function openMenu(event) {
    const more = event.type === 'click' && event.target.closest('.bg-project-file-more');
    const row = readRow(event.target);
    if (!row || row.vendor) return;
    // Native context menus already cover the regular buttons. Add the
    // fallback for file types with a non-interactive preview row.
    if (!more && (event.type !== 'contextmenu' || event.target.closest('button'))) return;
    event.preventDefault();
    event.stopPropagation();
    service.openMenu(row.kind, row, more || undefined, event);
  }
  const events = { dragstart: dragStart, dragover: dragOver, dragleave: dragLeave, drop, dragend: endDrag, click: openMenu, contextmenu: openMenu };
  for (const [name, listener] of Object.entries(events)) document.addEventListener(name, listener, true);
  return () => {
    observer.disconnect();
    endDrag();
    for (const row of managed.keys()) undecorate(row);
    for (const [name, listener] of Object.entries(events)) document.removeEventListener(name, listener, true);
  };
}

export function mountProjectFileActions(ctx) {
  ctx.inject(['contextMenus'], child => {
    const menu = child.contextMenus;
    const lifetime = new AbortController(), listeners = new Set();
    let dialog, serial = 0, copied;
    const updateDialog = value => { dialog = value; for (const listener of listeners) listener(); };
    const rootFor = sessionId => sessionDirectory(child.sessions, sessionId);
    const inProject = target => target.workspace && inside(target.workspace, target);
    const canPaste = target => copied && sameWorkspace(copied, target) && !inside(copied.path, target);
    const service = {
      signal: lifetime.signal,
      device: globalThis.__DSH_LINK_WORKBENCH__
        ? globalThis.__DSH_DEVICE_NAVIGATION__?.name || '当前远端设备'
        : '当前工作台设备',
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      snapshot: () => dialog,
      close(value) { if (dialog === value) updateDialog(undefined); },
      openMenu(kind, { sessionId, path }, button, event) {
        const rectangle = button?.getBoundingClientRect();
        menu.open({ kind, value: { sessionId, path } }, rectangle
          ? { x: rectangle.left, y: rectangle.bottom } : { x: event.clientX, y: event.clientY });
      },
      async perform(target, action, data) {
        if (!inProject(target)) throw new Error('请选择当前项目中的文件或文件夹');
        const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(120000)]);
        let result;
        try { result = await fileRequest(target, action, data, signal); }
        catch (error) {
          if (signal.aborted && !lifetime.signal.aborted) throw new Error('操作响应超时，请刷新目录核对结果');
          throw error;
        }
        if (lifetime.signal.aborted) return;
        document.dispatchEvent(new CustomEvent('benchgo-project-files-changed', { detail: { ...target, action, result } }));
        for (const page of document.querySelectorAll('[data-files-page]')) {
          const root = page.querySelector('[data-files-navigator]')?.dataset.filesRoot;
          if (root && pathKey(root, target.workspace) === pathKey(target.workspace, target.workspace)) page.querySelector('[data-files-reload]')?.click();
        }
        menu.notify(success[action], true);
      },
      async run(target, action, data) {
        try { await service.perform(target, action, data); }
        catch (error) { if (!lifetime.signal.aborted) menu.notify(error.message, false); }
      },
    };
    const choose = (action, target, origin = document.activeElement) => updateDialog({ id: ++serial, action, target, origin });
    const copy = target => { copied = target; menu.notify('已复制，打开目标文件夹的菜单即可粘贴', true); };
    const paste = target => canPaste(target) && service.run(copied, 'copy', { destination: target.path });
    const band = (id, run, options) => ({ id, label: labels[id], run, ...options });
    for (const kind of ['file', 'directory']) child.effect(() => menu.register({
      id: 'benchgo.project-files.' + kind, target: kind, order: 300,
      resolve({ sessionId, path }) {
        const target = { sessionId, path, workspace: rootFor(sessionId), kind };
        if (!inProject(target)) return [];
        const root = pathKey(path, target.workspace) === pathKey(target.workspace, target.workspace);
        return [
          ...(kind === 'directory' ? [
            band('new-file', () => choose('new-file', target), { separatorBefore: true }),
            band('new-folder', () => choose('new-folder', target)),
            band('paste', () => paste(target), { disabled: !canPaste(target) }),
          ] : []),
          ...(!root ? [
            { id: 'copy', label: kind === 'directory' ? '复制文件夹' : '复制文件', run: () => copy(target), separatorBefore: true },
            band('move', () => choose('move', target)),
            band('rename', () => choose('rename', target)),
            band('delete', () => choose('delete', target), { label: '删除', danger: true }),
          ] : []),
        ];
      },
    }));
    child.slots.inject('shell.overlay', () => child.slots.register({
      name: 'shell.overlay', id: 'benchgo-project-files', inject: () => ({ service }),
    }, FileOperationOverlay));
    child.slots.inject('sidebar.right.tab.files.actions', () => child.slots.register({
      name: 'sidebar.right.tab.files.actions', id: 'benchgo-project-file-actions', inject: () => ({ service }),
    }, FilesMenuButton));
    child.effect(() => {
      const disposeEvents = mountFileTreeEvents(service);
      const vendorAction = event => {
        const { id, sessionId, cwd: workspace, path, isDir } = event.detail;
        const target = { sessionId, workspace, path, kind: isDir ? 'directory' : 'file' };
        if (!inProject(target)) return;
        if (id === 'can-paste' && canPaste(target)) event.preventDefault();
        if (id === 'copy') copy(target);
        if (id === 'paste') void paste(target);
        if (id === 'move') choose('move', target);
      };
      document.addEventListener('benchgo-project-file-action', vendorAction);
      return () => {
        lifetime.abort();
        document.removeEventListener('benchgo-project-file-action', vendorAction);
        disposeEvents();
      };
    });
  });
}
