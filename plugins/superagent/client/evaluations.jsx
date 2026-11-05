import { Disclosure } from '../../shared/client/ui/collapsible.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import React, { useEffect, useState } from 'react';
import { useDirtyRegistry } from './dirty-registry.mjs';
import { InfoDisclosure } from '../../shared/client/info-disclosure.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import css from './evaluations.css';
import { TaskListRow, TaskDetail, TaskIconButton } from './task-list.jsx';
import { ResourceState } from './resource-state.jsx';
import taskCss from './tasks.css';

export function EvaluationRow({ api, row, reload, onDirtyChange }) {
  const [draft, setDraft] = useState(null), [history, setHistory] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { onDirtyChange?.(!!draft); return () => onDirtyChange?.(false); }, [!!draft, onDirtyChange]);
  const submit = async event => {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try { await api('evaluationDispose', { candidateId: row.id, ...draft }); setDraft(null); await reload(); }
    catch (cause) { setError(cause.message); } finally { setBusy(false); }
  };
  const readHistory = async () => {
    setBusy(true); setError('');
    try { setHistory((await api('evaluationHistory', { candidateId: row.id })).events); }
    catch (cause) { setError(cause.message); } finally { setBusy(false); }
  };
  return <article className="ba-surface ba-resource-card ba-evaluation-detail" aria-label="人工处置历史"><header><strong>评估需要你处理</strong><span className="ba-task-state" data-state="waiting">已自动重试 {row.retryCount || 0} 次</span></header>
    <p className="ba-note">{row.trigger?.source?.channel || '来源'} · {row.threadId}</p>
    <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{row.trigger?.content || '原文暂不可用'}</p>
    {draft ? <form className="ba-stack" onSubmit={submit}><p>{draft.disposition === 'retry' ? '按当前规则重新评估；授权校验通过后才会建单。' : '忽略本条候选并保留人工处置记录。'}</p>
      <label className="ba-connection-field"><span>处置原因（可选）</span><textarea rows={2} maxLength={2000} value={draft.reason} disabled={busy} onChange={event => setDraft({ ...draft, reason: event.target.value })} /></label>
      <div className="ba-row-actions"><Button variant="ghost" type="button" className="ba-quiet" disabled={busy} onClick={() => setDraft(null)}>取消</Button><Button variant="default" className="ba-primary" type="submit" disabled={busy}>{busy ? '提交中…' : draft.disposition === 'retry' ? '确认重新评估' : '确认忽略'}</Button></div>
    </form> : <div className="ba-row-actions">{[['retry', '重新评估'], ['ignore', '忽略']].map(([disposition, label]) => <TaskIconButton icon={disposition === 'retry' ? 'refresh' : 'close'} label={label} disabled={busy} key={disposition} onClick={() => { setDraft({ disposition, reason: '', expectedRevision: row.dispositionRevision, expectedUpdatedAt: row.updatedAt }); setError(''); }} />)}</div>}
    {error && <div className="ba-task-feedback" role="alert"><UIIcon name="close" size={17} /><span>{error}</span>{!draft && <Button variant="ghost" type="button" disabled={busy} onClick={readHistory}>重试读取</Button>}</div>}<Disclosure className="ba-evaluation-history" title="人工处置历史" onOpenChange={open => { if (open && !history && !busy) void readHistory(); }}>
    {busy && !draft && <ResourceState kind="loading" title="正在读取处置历史" description="保留每一次人工决定与处置原因。" />}
    {!busy && history && (history.length ? <ol className="ba-evaluation-history-list">{history.map(event => <li key={event.seq}><span className="ba-task-state" data-state={event.action === 'retry' ? 'active' : 'cancelled'}>{event.action === 'retry' ? '重新评估' : '忽略'}</span><p>{event.reason || '未填写原因'}</p><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString('zh-CN')}</time></li>)}</ol> : <ResourceState icon="archive" title="暂无人工处置记录" description="重新评估或忽略后，处置原因会记录在这里。" />)}</Disclosure>
  </article>;
}

export function Evaluations({ api, onDirtyChange }) {
  const [detailDirty, setDetailDirty] = useState(false), [rowsDirty, setRowsDirty] = useState(false), [selectedId, setSelectedId] = useState(null);
  const dirtyEditor = useDirtyRegistry(setRowsDirty);
  useEffect(() => { onDirtyChange?.(detailDirty || rowsDirty); return () => onDirtyChange?.(false); }, [detailDirty, rowsDirty, onDirtyChange]);
  const [value, setValue] = useState(null), [page, setPage] = useState([0]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [generation, setGeneration] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setError('');
    api('evaluations', { after: page.at(-1), limit: 25 }, controller.signal).then(result => { if (!controller.signal.aborted) setValue(result); }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [api, page, generation]);
  const selected = value?.candidates.find(row => row.id === selectedId);
  const reload = async () => setGeneration(current => current + 1);
  return <section className="ba-group ba-evaluations" aria-label="人工评估处置"><style>{taskCss}{css}</style><div className="ba-group-head"><div><div className="ba-group-title"><h2>待处置评估</h2><InfoDisclosure label="查看待处置评估说明">自动评估连续超时后，候选会出现在这里，你可以选择重新评估或忽略。</InfoDisclosure></div><p>处理暂未完成的评估，让任务继续向前。</p></div><Button variant="ghost" type="button" className="ba-task-secondary" disabled={busy} onClick={reload}><UIIcon name="refresh" size={16} />刷新</Button></div>
    {error && (!value ? <ResourceState kind="error" title="评估暂时无法读取" description={error} onAction={reload} /> : <div className="ba-task-feedback" role="alert"><UIIcon name="close" size={18} /><span>评估未能更新：{error}</span><Button variant="ghost" type="button" onClick={reload}>重试</Button></div>)}
    {busy && !value && <ResourceState kind="loading" title="正在读取评估" description="正在查找需要人工处置的候选。" />}
    {busy && value && <p className="ba-task-refresh-status" role="status"><UIIcon name="refresh" size={16} />正在更新评估…</p>}
    {!busy && !error && value?.candidates.length === 0 && <ResourceState icon="check" title="暂无待处置评估" description="自动评估遇到连续超时时，需要你处理的候选会显示在这里。" />}
    <div className="ba-task-list">{value?.candidates.map(row => <TaskListRow api={api} kind="evaluation" row={row} key={row.id} title={row.taskMeta?.title || row.trigger?.content?.split('\n')[0] || '待处置评估'} summary={<><span className="ba-task-state" data-state="waiting">待处置</span><span className="ba-task-summary">{row.trigger?.source?.channel || '来源'} · 已自动重试 {row.retryCount || 0} 次</span>{row.updatedAt && <time className="ba-task-updated" dateTime={row.updatedAt}>更新 {new Date(row.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>}</>} onChanged={reload} onOpen={() => setSelectedId(row.id)} onDirtyChange={dirtyEditor(row.id)} />)}</div>
    {selected && <TaskDetail open title={selected.taskMeta?.title || '评估详情'} dirty={detailDirty} onClose={() => { setDetailDirty(false); setSelectedId(null); }}><EvaluationRow key={selected.id} api={api} row={selected} reload={reload} onDirtyChange={setDetailDirty} /></TaskDetail>}
    <div className="ba-row-actions" aria-label="评估分页">{page.length > 1 && <Button variant="ghost" type="button" className="ba-quiet" disabled={busy} onClick={() => setPage(current => current.slice(0, -1))}>上一页</Button>}{value?.next != null && <Button variant="ghost" type="button" className="ba-quiet" disabled={busy} onClick={() => setPage(current => [...current, value.next])}>下一页</Button>}</div>
  </section>;
}
