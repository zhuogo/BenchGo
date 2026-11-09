import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../../shared/client/ui/button.jsx';
import { Dialog, DialogContent, DialogTitle } from '../../shared/client/ui/dialog.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import css from './task-list.css';
import { normalizeTicketTitle, TICKET_TITLE_MAX_CHARS } from '../src/ticket-title.mjs';
import { activeActivityStates } from './activity-data.mjs';

export function TaskStatusGlyph({ status }) {
  if (status === 'completed') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4.5 12.5 5 5 10-11" /></svg>;
  if (['failed', 'blocked', 'uncertain', 'continuation_wait'].includes(status)) return <span className="ba-board-glyph-text" aria-hidden="true">!</span>;
  if (['waiting', 'awaiting_user'].includes(status)) return <span className="ba-board-glyph-text" aria-hidden="true">?</span>;
  if (['paused', 'pausing'].includes(status)) return <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>;
  if (activeActivityStates(status)) return <span className="ba-board-pulse" aria-hidden="true" />;
  return <span className="ba-board-dot" aria-hidden="true" />;
}

export function TaskStatusTitle({ title, status, label }) {
  return <span className="ba-activity-detail-title"><span className="ba-activity-detail-status" data-status={status} role="img" aria-label={label} title={label}><TaskStatusGlyph status={status} /></span><span>{title}</span></span>;
}

export function TaskIconButton({ label, icon, ...props }) {
  const paths = { pause: <><path d="M8 5v14M16 5v14" /></>, play: <path d="m8 5 11 7-11 7Z" />, stop: <rect x="6" y="6" width="12" height="12" rx="1" /> };
  return <Button variant="ghost" type="button" className="ba-task-icon" title={label} aria-label={label} {...props}>{paths[icon] ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">{paths[icon]}</svg> : <UIIcon name={icon} size={18} />}</Button>;
}

export function TaskDetail({ open, title, onClose, dirty = false, children, footer }) {
  const opener = useRef(null);
  const close = () => { if (!dirty || window.confirm('有未保存的修改，确定放弃并关闭？')) onClose(); };
  return <Dialog open={open} onOpenChange={value => { if (!value) close(); }}><style>{css}</style><DialogContent className="ba-task-dialog" aria-describedby={undefined} onOpenAutoFocus={() => { opener.current = document.activeElement; }} onCloseAutoFocus={event => { if (opener.current?.isConnected) { event.preventDefault(); opener.current.focus(); } }}><DialogTitle>{typeof title === 'string' ? <span className="ba-task-dialog-title-text" title={title}>{title}</span> : title}</DialogTitle><div className="ba-root ba-task-dialog-body">{children}</div>{footer && <footer className="ba-root ba-task-dialog-footer">{footer}</footer>}</DialogContent></Dialog>;
}

export function TaskListRow({ api, kind, row, title: inputTitle, summary, completed = false, completionLocked = false, onChanged, onOpen, actions = [], onDirtyChange }) {
  const title = kind === 'ticket' ? normalizeTicketTitle(inputTitle, row.target) : inputTitle;
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [editing, setEditing] = useState(false), [draft, setDraft] = useState(title);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const checked = row.taskMeta?.completed || completed;
  const pending = row.taskCanOrganize === false;
  const change = async (operation, extra = {}) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await api('taskUpdate', { kind, id: row.id, operation, version: row.taskMeta?.version ?? 0, ...extra }); setEditing(false); onDirtyChange?.(false); await onChanged?.(); }
    catch (cause) { setError(cause.message || '操作失败，请重试'); }
    finally { setBusy(false); }
  };
  const remove = () => { if (window.confirm(`删除“${title}”？该条目将从任务列表移除，执行记录仍会保留。`)) void change('delete'); };
  const rename = () => { if (draft.trim()) return change('rename', { title: kind === 'ticket' ? normalizeTicketTitle(draft) : draft.trim() }); };
  return <article className={`ba-task-list-row${checked ? ' is-complete' : ''}`}><style>{css}</style>
    <label className="ba-task-check" title={pending ? '请先停止任务，等待执行结束' : completionLocked ? kind === 'ticket' ? '已完成；需要继续调整时可创建关联调整单' : '目标已完成' : checked ? '取消完成标记' : '标记已完成'}><input type="checkbox" checked={!!checked} disabled={busy || completionLocked || pending} aria-label={`${completionLocked ? '已完成' : checked ? '取消完成' : '标记完成'}：${title}`} onChange={() => change(checked ? 'reopen' : 'complete')} /></label>
    <div className="ba-task-list-content">{editing ? <form className="ba-task-rename" onSubmit={event => { event.preventDefault(); void rename(); }}><input autoFocus aria-label="任务名称" maxLength={kind === 'ticket' ? undefined : 200} value={draft} disabled={busy} onChange={event => { setDraft(kind === 'ticket' ? Array.from(event.target.value).slice(0, TICKET_TITLE_MAX_CHARS).join('') : event.target.value); onDirtyChange?.(true); }} /><TaskIconButton icon="check" label="保存名称" disabled={busy || !draft.trim()} onClick={rename} /><TaskIconButton icon="close" label="取消重命名" disabled={busy} onClick={() => { setEditing(false); onDirtyChange?.(false); }} /></form> : <button type="button" className="ba-task-open" onClick={onOpen}><strong>{title}</strong>{summary && <span>{summary}</span>}</button>}{error && <p role="alert" className="ba-task-list-error">{error}</p>}</div>
    <div className="ba-task-row-actions">{actions.map(action => <TaskIconButton key={action.label} {...action} disabled={busy || action.disabled} />)}<TaskIconButton icon="edit" label="重命名" disabled={busy || editing} onClick={() => { setDraft(title); setEditing(true); onDirtyChange?.(true); }} /><TaskIconButton icon="trash" label={pending ? '请先停止任务，等待执行结束' : '删除'} disabled={busy || pending} onClick={remove} /></div>
  </article>;
}
