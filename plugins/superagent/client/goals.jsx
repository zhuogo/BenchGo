import { useConfirmation } from '../../shared/client/ui/confirmation.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GoalUsage } from './goal-usage';
import { CustomSelect } from '../../shared/client/custom-select.jsx';
import taskCss from './tasks.css';
import { TaskListRow, TaskDetail, TaskIconButton } from './task-list.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import { useDirtyRegistry } from './dirty-registry.mjs';
import { ResourceState } from './resource-state.jsx';

const empty = { objective: '', projectId: '', text: '', acceptance: '' };
const statuses = { active: '进行中', completed: '已完成', pausing: '正在暂停', paused: '已暂停', resuming: '正在恢复', failed: '失败', cancelled: '已取消', blocked: '受阻', waiting: '等待处理', cancelling: '停止已生效 · 正在结束关联执行' };
export function Goals({ api, refresh, onDirtyChange, onViewTickets, initialCreating = false }) {
  const [confirm, confirmation] = useConfirmation();
  const [rows, setRows] = useState(null), [draft, setDraft] = useState(empty), [creating, setCreating] = useState(initialCreating), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [stopping, setStopping] = useState(null), [changing, setChanging] = useState(null);
  const [selectedId, setSelectedId] = useState(null), [listDirty, setListDirty] = useState(false);
  const dirtyRows = useDirtyRegistry(setListDirty);
  const selected = rows?.find(row => row.id === selectedId);
  const request = useRef(null);
  const [catalog, setCatalog] = useState(null), [catalogError, setCatalogError] = useState('');
  const loadCatalog = useCallback(async () => { setCatalogError(''); try { setCatalog(await api('catalog')); } catch (cause) { setCatalogError(cause.message); } }, [api]);
  useEffect(() => { if (creating) void loadCatalog(); }, [creating, loadCatalog]);
  const projects = (catalog?.projects || []).filter(row => row.available !== false).map(row => ({ value: row.id, label: row.title || row.path || row.id }));
  const load = useCallback(async () => { try { const result = await api('goalList'); setRows(result.goals || []); setError(''); } catch (cause) { setError(cause.message); } }, [api]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!rows?.some(row => ['pausing', 'resuming', 'cancelling'].includes(row.status))) return; const timer = setInterval(() => void load(), 1000); return () => clearInterval(timer); }, [rows, load]);
  const changePause = async row => { setChanging(row.id); setError(''); try { await api(row.status === 'paused' ? 'goalResume' : 'goalPause', { id: row.id, rowVersion: row.rowVersion }); await load(); } catch (cause) { setError(cause.message); } finally { setChanging(null); } };
  const stop = async row => { if (!await confirm({ title: '停止这个持续目标？', description: '已发生的外部操作不会撤销。', confirmLabel: '停止目标', destructive: true })) return; setStopping(row.id); setError(''); try { await api('goalCancel', { id: row.id, rowVersion: row.rowVersion }); await load(); } catch (cause) { setError(cause.message); } finally { setStopping(null); } };
  const valid = ['objective', 'projectId', 'text'].every(key => draft[key].trim()) && !catalogError && projects.some(row => row.value === draft.projectId);
  const dirty = listDirty || Object.values(draft).some(Boolean);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  const submit = async event => { event.preventDefault(); if (busy || !valid) return; const goal = Object.fromEntries(Object.keys(empty).map(key => [key, draft[key]])); const fingerprint = JSON.stringify(goal); if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() }; setBusy(true); setError(''); try { await api('goalCreate', { goal: { ...goal, requestId: request.current.id } }); request.current = null; setDraft(empty); setCreating(false); await load(); await refresh(); onViewTickets?.(); } catch (cause) { setError(cause.message); } finally { setBusy(false); } };
  return <section className="ba-goals">{confirmation}<style>{taskCss}</style><div className="ba-group-head"><div><h2>持续目标</h2><p>把一件长期的事，交给助手持续推进。</p></div><div className="ba-task-actions">{!!rows?.length && onViewTickets && <Button variant="ghost" type="button" className="ba-task-secondary" onClick={async () => { if (!dirty || await confirm({ title: '放弃未保存的目标？', description: '查看工单会放弃未保存的修改。', confirmLabel: '放弃并查看', cancelLabel: '继续编辑', destructive: true })) onViewTickets(); }}>查看工单</Button>}<Button variant="ghost" type="button" className="ba-task-secondary" onClick={load}><UIIcon name="refresh" size={16} />刷新</Button><Button variant={creating ? "ghost" : "default"} type="button" className={creating ? 'ba-task-secondary' : 'ba-primary'} onClick={() => setCreating(value => !value)}><UIIcon name={creating ? 'chevronDown' : 'plus'} size={16} />{creating ? '收起表单' : '新建目标'}</Button></div></div>
    {error && (rows === null && !creating ? <ResourceState kind="error" title="持续目标暂时无法读取" description={error} onAction={load} /> : <div className="ba-task-feedback" role="alert"><UIIcon name="close" size={18} /><span>{error}</span><Button variant="ghost" type="button" className="ba-quiet" onClick={load}>重试</Button></div>)}
    {creating && <form className="ba-surface ba-goal-form" aria-label="新建持续目标" onSubmit={submit}><div className="ba-goal-form-heading"><UIIcon name="experiment" size={20} /><div><h3>设定一个新目标</h3><p>明确结果与执行范围，选择项目，使用系统工作模型推进。</p></div></div><fieldset disabled={busy}><label>目标<textarea rows={2} required value={draft.objective} placeholder="希望最终达成什么？" onChange={event => setDraft({ ...draft, objective: event.target.value })} /></label>
      <div className="ba-goal-fields"><label>项目<CustomSelect aria-label="项目" searchable value={draft.projectId} options={projects} disabled={busy || !catalog} placeholder="选择项目" onChange={projectId => setDraft({ ...draft, projectId })} /></label></div>
      <p className="ba-note">系统工作模型</p>
      {(!catalog || catalogError || !projects.length) && <div className="ba-goal-catalog-status" role={catalogError ? 'alert' : 'status'}><UIIcon name={catalogError ? 'close' : !catalog ? 'refresh' : 'folder'} size={17} /><span>{catalogError || (!catalog ? '正在读取目录…' : '暂无项目，请先创建项目。')}</span><Button variant="ghost" type="button" className="ba-task-secondary" onClick={loadCatalog}>刷新目录</Button></div>}
      <label>执行要求<textarea rows={3} required value={draft.text} placeholder="描述本次执行的范围与要求" onChange={event => setDraft({ ...draft, text: event.target.value })} /></label><label>验收条件（可选）<textarea rows={2} value={draft.acceptance} placeholder="说明如何判断目标已达成" onChange={event => setDraft({ ...draft, acceptance: event.target.value })} /></label><footer><Button type="submit" className="ba-primary" disabled={busy || !valid}>{busy ? '创建中…' : '创建目标'}</Button></footer></fieldset></form>}
    {rows === null && !error && !creating && <ResourceState kind="loading" title="正在读取持续目标" description="正在同步目标进展与关联工单。" />}
    {rows?.length === 0 && !creating && !error && <ResourceState icon="experiment" title="还没有持续目标" description="持续目标会跨会话推进同一件事，并把执行落到关联工单上。" />}
    {!!rows?.length && <div className="ba-task-list">{rows.map(row => <TaskListRow key={row.id} api={api} kind="goal" row={row} title={row.taskMeta?.title || row.title || row.objective || '未命名目标'} summary={<><span className="ba-task-state" data-state={row.status}>{statuses[row.status] || row.status}</span><span className="ba-task-summary">{row.error || (row.objective !== (row.taskMeta?.title || row.title || row.objective) ? row.objective : '') || `${row.ticketIds?.length || 0} 项关联工单`}</span>{row.updatedAt && <time className="ba-task-updated" dateTime={row.updatedAt}>更新 {new Date(row.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>}</>} completed={row.status === 'completed'} completionLocked={row.status === 'completed'} onChanged={load} onOpen={() => setSelectedId(row.id)} onDirtyChange={dirtyRows(row.id)} actions={[...(['active', 'waiting', 'paused'].includes(row.status) ? [{ icon: row.status === 'paused' ? 'play' : 'pause', label: row.status === 'paused' ? '恢复目标' : '暂停目标', disabled: changing === row.id || stopping === row.id, onClick: () => changePause(row) }] : []), ...(!['completed', 'failed', 'cancelled', 'cancelling'].includes(row.status) ? [{ icon: 'stop', label: '停止目标', disabled: stopping === row.id, onClick: () => stop(row) }] : [])]} />)}</div>}
    {selected && <TaskDetail open title={selected.taskMeta?.title || selected.title || selected.objective || '目标详情'} onClose={() => setSelectedId(null)}>
      <p className="ba-note">{statuses[selected.status] || selected.status} · {selected.ticketIds?.length || 0} 项工单</p>
      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{selected.objective}</p>
      <p className="ba-note">项目：{selected.projectId || '—'} · 系统工作模型</p>
      <GoalUsage row={selected} />
      {selected.error && <p role="status" className="ba-note">{selected.error}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="ba-row-actions">{['active', 'waiting', 'paused'].includes(selected.status) && <TaskIconButton icon={selected.status === 'paused' ? 'play' : 'pause'} label={selected.status === 'paused' ? '恢复目标' : '暂停目标'} disabled={changing === selected.id || stopping === selected.id} onClick={() => changePause(selected)} />}{!['completed', 'failed', 'cancelled', 'cancelling'].includes(selected.status) && <TaskIconButton icon="stop" label={stopping === selected.id ? '正在提交停止…' : '停止目标'} disabled={stopping === selected.id} onClick={() => stop(selected)} />}</div>
    </TaskDetail>}
  </section>;
}
