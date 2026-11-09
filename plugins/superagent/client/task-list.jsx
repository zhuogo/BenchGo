import { useConfirmation } from '../../shared/client/ui/confirmation.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../../shared/client/ui/button.jsx';
import { Dialog, DialogContent, DialogTitle } from '../../shared/client/ui/dialog.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import css from './task-list.css';
import { Tooltip } from '../../shared/client/ui/tooltip.jsx';
import { normalizeTicketTitle, TICKET_TITLE_MAX_CHARS } from '../src/ticket-title.mjs';
import { activeActivityStates } from './activity-data.mjs';

export function TaskStatusGlyph({ status }) {
  if (status === 'completed') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4.5 12.5 5 5 10-11" /></svg>;
  if (['failed', 'blocked', 'uncertain', 'continuation_wait'].includes(status)) return <span className="ba-board-glyph-text" aria-hidden="true">!</span>;
  if (['waiting', 'awaiting_user'].includes(status)) return <span className="ba-board-glyph-text" aria-hidden="true">?</span>;
  if (status === 'cancelling') return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>;
  if (['paused', 'pausing'].includes(status)) return <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>;
  if (activeActivityStates(status)) return <span className="ba-board-pulse" aria-hidden="true" />;
  return <span className="ba-board-dot" aria-hidden="true" />;
}

export function TaskStatusTitle({ title, status, label }) {
  return <span className="ba-activity-detail-title"><Tooltip label={label}><span className="ba-activity-detail-status" data-status={status} role="img" aria-label={label} tabIndex={0}><TaskStatusGlyph status={status} /></span></Tooltip><span>{title}</span></span>;
}

export function TaskIconButton({ label, icon, ...props }) {
  const paths = { pause: <><path d="M8 5v14M16 5v14" /></>, play: <path d="m8 5 11 7-11 7Z" />, stop: <rect x="6" y="6" width="12" height="12" rx="1" /> };
  return <Button variant="ghost" type="button" className="ba-task-icon" title={label} aria-label={label} {...props}>{paths[icon] ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">{paths[icon]}</svg> : <UIIcon name={icon} size={18} />}</Button>;
}

export function TaskDetail({ open, title, onClose, dirty = false, children, footer, inline = false }) {
  const [confirm, confirmation] = useConfirmation();
  const opener = useRef(null);
  const container = useRef(null);
  useEffect(() => { if (inline && open) { opener.current = document.activeElement; container.current?.focus(); } }, [inline, open]);
  const close = async () => { if (!dirty || await confirm({ title: '放弃未保存的修改？', description: '关闭后，此处尚未保存的修改将丢失。', confirmLabel: '放弃并关闭', cancelLabel: '继续编辑', destructive: true })) onClose(); };
  if (inline) return open ? <>{confirmation}<style>{css}</style><section className="ba-task-inline" ref={container} tabIndex={-1} aria-label="任务详情" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); void close(); } }}><header className="ba-task-inline-head"><Button variant="ghost" onClick={close}><UIIcon name="chevronLeft" size={16} />返回列表</Button><h2>{title}</h2></header><div className="ba-root ba-task-dialog-body">{children}</div>{footer && <footer className="ba-root ba-task-dialog-footer">{footer}</footer>}</section></> : null;
  return <><Dialog open={open} onOpenChange={value => { if (!value) close(); }}><style>{css}</style><DialogContent className="ba-task-dialog" aria-describedby={undefined} onOpenAutoFocus={() => { opener.current = document.activeElement; }} onCloseAutoFocus={event => { if (opener.current?.isConnected) { event.preventDefault(); opener.current.focus(); } }}><DialogTitle>{typeof title === 'string' ? <Tooltip label={title} onlyWhenClipped><span className="ba-task-dialog-title-text" tabIndex={0}>{title}</span></Tooltip> : title}</DialogTitle><div className="ba-root ba-task-dialog-body">{children}</div>{footer && <footer className="ba-root ba-task-dialog-footer">{footer}</footer>}</DialogContent></Dialog>{confirmation}</>;
}

const milestoneLabels = { 'turn/start': '开始执行', 'turn/end': '执行回合结束', 'step/end': '完成一个执行阶段', 'subagent/catalog': '派出子 Worker', 'subagent/returned': '子 Worker 返回', 'recovery-unavailable': '历史执行记录不完整', result: '保存执行结果', delivery: '更新交付状态', attention: '等待用户处理', requirements: '要求已修订' };
export function TicketFacts({ ticket }) {
  const begin = Date.parse(ticket.createdAt), end = Date.parse(ticket.closedAt || ticket.completedAt || ticket.execution?.updatedAt || ticket.updatedAt);
  const elapsed = Number.isFinite(begin) && Number.isFinite(end) && end >= begin ? Math.floor((end - begin) / 60000) : null;
  const milestones = (ticket.execution?.milestones || []).filter(row => milestoneLabels[row.kind]);
  return <><section className="ba-task-instructions"><h3>任务要求</h3><p>{ticket.target || '原始要求未记录'}</p>{ticket.acceptance && <><h3>验收条件</h3><p>{ticket.acceptance}</p></>}<span className="ba-note">截至最近记录 · {elapsed === null ? '耗时未知' : elapsed < 1 ? '不到 1 分钟' : elapsed < 60 ? `${elapsed} 分钟` : `${Math.floor(elapsed / 60)} 小时 ${elapsed % 60} 分钟`}</span></section>{milestones.length > 0 && <section className="ba-task-milestones" aria-label="关键工作流"><h3>关键工作流</h3><ol>{milestones.map(row => <li key={`${row.seq}:${row.kind}`}><span>{milestoneLabels[row.kind]}</span><time dateTime={row.time || undefined}>{Number.isFinite(Date.parse(row.time)) ? new Date(row.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '时间未记录'}</time></li>)}</ol></section>}</>;
}

export function TaskListRow({ api, kind, row, title: inputTitle, summary, verification, completed = false, completionLocked = false, onChanged, onOpen, actions = [], onDirtyChange }) {
  const [confirm, confirmation] = useConfirmation();
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
  const remove = async () => { if (await confirm({ title: `删除“${title}”？`, description: '该条目将从任务列表移除，执行记录仍会保留。', confirmLabel: '删除', destructive: true })) void change('delete'); };
  const rename = () => { if (draft.trim()) return change('rename', { title: kind === 'ticket' ? normalizeTicketTitle(draft) : draft.trim() }); };
  return <article className={`ba-task-list-row${checked ? ' is-complete' : ''}`}>{confirmation}<style>{css}</style>
    <Tooltip label={pending ? '请先停止任务，等待执行结束' : completionLocked ? kind === 'ticket' ? '已完成；需要继续调整时可创建关联调整单' : '目标已完成' : checked ? '取消完成标记' : '标记已完成'}><label className="ba-task-check" tabIndex={pending || completionLocked ? 0 : undefined}><input type="checkbox" checked={!!checked} disabled={busy || completionLocked || pending} aria-label={`${completionLocked ? '已完成' : checked ? '取消完成' : '标记完成'}：${title}`} onChange={() => change(checked ? 'reopen' : 'complete')} /></label></Tooltip>
    <div className="ba-task-list-content">{editing ? <form className="ba-task-rename" onSubmit={event => { event.preventDefault(); void rename(); }}><input autoFocus aria-label="任务名称" maxLength={kind === 'ticket' ? undefined : 200} value={draft} disabled={busy} onChange={event => { setDraft(kind === 'ticket' ? Array.from(event.target.value).slice(0, TICKET_TITLE_MAX_CHARS).join('') : event.target.value); onDirtyChange?.(true); }} /><TaskIconButton icon="check" label="保存名称" disabled={busy || !draft.trim()} onClick={rename} /><TaskIconButton icon="close" label="取消重命名" disabled={busy} onClick={() => { setEditing(false); onDirtyChange?.(false); }} /></form> : <button type="button" className="ba-task-open" onClick={onOpen}><strong>{title}</strong>{summary && <span>{summary}</span>}{verification && <small className="ba-task-verification">{verification}</small>}</button>}{error && <p role="alert" className="ba-task-list-error">{error}</p>}</div>
    <div className="ba-task-row-actions">{actions.map(action => <TaskIconButton key={action.label} {...action} disabled={busy || action.disabled} />)}<TaskIconButton icon="edit" label="重命名" disabled={busy || editing} onClick={() => { setDraft(title); setEditing(true); onDirtyChange?.(true); }} /><TaskIconButton icon="trash" label={pending ? '请先停止任务，等待执行结束' : '删除'} disabled={busy || pending} onClick={remove} /></div>
  </article>;
}
