import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../shared/client/ui/button.jsx';
import { useConfirmation } from '../../shared/client/ui/confirmation.jsx';
import { TaskIconButton } from './task-list.jsx';
import { useDirtyRegistry } from './dirty-registry.mjs';
import { ResourceState } from './resource-state.jsx';
import taskCss from './tasks.css';

function GoalItem({ row, api, onChanged, onDirtyChange, onViewTickets }) {
  const [confirm, confirmation] = useConfirmation();
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(row.objective || '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const completed = row.status === 'completed', editable = row.executionKind === 'checklist';
  useEffect(() => { onDirtyChange(editing && draft !== row.objective); return () => onDirtyChange(false); }, [editing, draft, row.objective, onDirtyChange]);
  const update = async patch => {
    if (busy) return;
    setBusy(true); setError('');
    try { await api('goalUpdate', { id: row.id, rowVersion: row.rowVersion, patch }); setEditing(false); await onChanged(); }
    catch (cause) { setError(cause.message || '目标暂时无法保存，请重试'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (await confirm({ title: '删除这个目标？', description: row.objective, confirmLabel: '删除', destructive: true })) await update({ deleted: true });
  };
  return <li className="ba-goal-item" data-completed={completed}>{confirmation}
    <input type="checkbox" checked={completed} disabled={busy || !editable} aria-label={`${completed ? '取消完成' : '完成'}：${row.objective}`} onChange={() => update({ status: completed ? 'active' : 'completed' })} />
    <div className="ba-goal-item-body">
      {editing ? <form className="ba-goal-edit" aria-label="编辑目标" onSubmit={event => { event.preventDefault(); if (draft.trim()) void update({ objective: draft.trim() }); }}>
        <textarea aria-label="目标内容" rows={2} maxLength={2000} required autoFocus value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} />
        <div className="ba-task-actions"><Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>取消</Button><Button type="submit" disabled={busy || !draft.trim()}>{busy ? '保存中…' : '保存'}</Button></div>
      </form> : <p className="ba-goal-text">{row.objective}</p>}
      {!editable && <span className="ba-note">历史执行目标 · {completed ? '已完成' : '进展随关联工单更新'}</span>}
      {error && <p className="ba-goal-error" role="alert">{error}</p>}
    </div>
    {!editing && <div className="ba-task-actions">{editable ? <><TaskIconButton icon="edit" label="编辑目标" disabled={busy} onClick={() => { setDraft(row.objective); setEditing(true); }} /><TaskIconButton icon="trash" label="删除目标" disabled={busy} onClick={remove} /></> : onViewTickets && <Button variant="ghost" onClick={onViewTickets}>查看工单</Button>}</div>}
  </li>;
}

export function Goals({ api, onDirtyChange, onViewTickets }) {
  const [rows, setRows] = useState(null), [error, setError] = useState('');
  const [loading, setLoading] = useState(false), [listDirty, setListDirty] = useState(false);
  const loadVersion = useRef(0);
  const dirtyRows = useDirtyRegistry(setListDirty);
  useEffect(() => { onDirtyChange?.(listDirty); return () => onDirtyChange?.(false); }, [listDirty, onDirtyChange]);
  const load = useCallback(async () => {
    const version = ++loadVersion.current; setLoading(true);
    try { const result = await api('goalList'); if (version === loadVersion.current) { setRows(result.goals || []); setError(''); } }
    catch (cause) { if (version === loadVersion.current) setError(cause.message || '目标暂时无法读取'); }
    finally { if (version === loadVersion.current) setLoading(false); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);
  return <section className="ba-goals" aria-label="目标清单"><style>{taskCss}</style>
    <header className="ba-studio-heading"><div className="ba-studio-heading-main"><h1>目标</h1><p>让助手长期记住想做的事，完成后勾选。</p></div><TaskIconButton icon="refresh" label={loading ? '正在刷新目标' : '刷新目标'} disabled={loading} onClick={load} /></header>
    {error && (rows === null ? <ResourceState kind="error" title="目标暂时无法读取" description={error} onAction={load} /> : <div className="ba-task-feedback" role="alert"><span>{error}</span><Button variant="ghost" onClick={load}>重试</Button></div>)}
    {rows === null && !error && <ResourceState kind="loading" title="正在读取目标" />}
    {rows?.length === 0 && !error && <ResourceState icon="check" title="还没有目标" description="在 SuperAgent 对话中提出目标，让助手记录并持续跟进。" />}
    {!!rows?.length && <ul className="ba-goal-list" aria-label="已保存目标">{rows.map(row => <GoalItem key={row.id} row={row} api={api} onChanged={load} onDirtyChange={dirtyRows(row.id)} onViewTickets={onViewTickets} />)}</ul>}
  </section>;
}
