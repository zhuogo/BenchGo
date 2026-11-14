import { Tooltip } from '../../shared/client/ui/tooltip.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDirtyRegistry } from './dirty-registry.mjs';
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import { SegmentedControl } from '../../shared/client/segmented-control.jsx';
import taskCss from './tasks.css';
import { TaskBoard, TaskViewControls } from './task-board.jsx';
import { filterTasks } from './task-board.mjs';
import { TaskListRow, TaskDetail, TaskIconButton, TaskStatusTitle, TaskFacts } from './task-list.jsx';
import { ResourceState } from './resource-state.jsx';
import { TaskAttention } from './task-attention.jsx';
import { TaskWaiting } from './task-waiting.jsx';
import { continuationRecovery, taskSnapshot, taskWaiting, taskLabels } from './task-state.mjs';
import { normalizeTaskTitle } from '../src/task-title.mjs';
import { activityTask, archivedActivityTask } from './activity-data.mjs';
import { TaskExecution, visibleExecutionActivity } from './task-execution.jsx';
import { useAssistantActivity } from './use-activity.jsx';
import { TaskCleanup } from './task-cleanup.jsx';
import { TaskDocument, TaskMarkdown } from './task-document.jsx';

const activityTime = row => {
  const updated = Date.parse(row.updatedAt), created = Date.parse(row.createdAt);
  return Number.isFinite(updated) ? updated : Number.isFinite(created) ? created : -Infinity;
};

export function TaskChange({ api, task, reload, onDirtyChange, startOpen = false, hideTrigger = false, onClose }) {
  const [draft, setDraft] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const request = useRef(null);
  useEffect(() => { onDirtyChange?.(!!draft); return () => onDirtyChange?.(false); }, [!!draft, onDirtyChange]);
  const terminal = task.status === 'completed' || task.executionControl?.stopped === true;
  const pending = taskSnapshot(task).safetyWait || task.executionControl?.pauseRequested || task.executionControl?.stopRequested || task.assignments?.some(row => row.state === 'uncertain');
  const open = () => {
    setDraft({ operation: terminal ? 'adjustment' : 'revise', expectedInstructionRevision: task.instructionRevision, target: task.target, acceptance: task.acceptance || '', reason: '' });
    request.current = null; setError('');
  };
  useEffect(() => { if (startOpen) open(); }, [startOpen]);
  const update = patch => { setDraft({ ...draft, ...patch }); request.current = null; setError(''); };
  const submit = async event => {
    event.preventDefault(); if (busy || !draft?.target.trim() || !draft.reason.trim()) return;
    setBusy(true); setError(''); request.current ||= crypto.randomUUID();
    try { await api('taskChange', { id: task.id, ...draft, requestId: request.current }); setDraft(null); onClose?.(); await reload(); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  if (hideTrigger && !draft) return null;
  return <section className="ba-stack" aria-label="任务要求管理">
    {draft ? <form className="ba-stack" onSubmit={submit}><h3>{draft.operation === 'adjustment' ? '创建关联调整任务' : '修订任务'} · 要求版本 {draft.expectedInstructionRevision}</h3>
      <p className="ba-note">{terminal ? '保留原任务成果与记录，按当前授权创建关联调整任务。' : '补充会在下一工具边界应用，在途操作继续按已提交要求执行。'}</p>
      <fieldset disabled={busy}><label className="ba-connection-field"><span>任务要求</span><textarea required rows={4} value={draft.target} onChange={event => update({ target: event.target.value })} /></label>
        <label className="ba-connection-field"><span>验收条件</span><textarea rows={3} value={draft.acceptance} onChange={event => update({ acceptance: event.target.value })} /></label>
        <label className="ba-connection-field"><span>变更原因</span><textarea required maxLength={10000} rows={2} value={draft.reason} onChange={event => update({ reason: event.target.value })} /></label></fieldset>
      {task.instructionRevision !== draft.expectedInstructionRevision && <p role="status" className="ba-note">任务已有新版本。请保留所需内容，关闭表单后重新打开。</p>}
      {error && <p role="alert">{error}</p>}<div className="ba-row-actions"><Button variant="ghost" type="button" className="ba-quiet" disabled={busy} onClick={() => { setDraft(null); onClose?.(); }}>取消</Button><Button type="submit" className="ba-primary" disabled={busy || pending || task.instructionRevision !== draft.expectedInstructionRevision || !draft.target.trim() || !draft.reason.trim()}>{busy ? '提交中…' : '保存并排队'}</Button></div>
    </form> : !hideTrigger && <div><TaskIconButton icon={terminal ? 'refresh' : 'edit'} label={terminal ? '创建关联调整任务' : '修订要求'} disabled={pending} onClick={open} />{pending && <p className="ba-note">执行尚未结束或已中断，已有记录保留。</p>}</div>}
  </section>;
}

export function Tasks({ api, onDirtyChange, onDetailChange, onSchedule, onOpenExecution, requestedTask }) {
  const [listDirty, setListDirty] = useState(false);
  const dirtyEditor = useDirtyRegistry((dirty, keys) => { setListDirty(keys.some(key => key.startsWith('rename:'))); onDirtyChange?.(dirty, keys); });
  const { rows: activityRows, error: activityError, refresh, refreshTasks } = useAssistantActivity(api, { live: true });
  const rows = useMemo(() => activityRows === null ? null : activityRows.filter(row => row.kind === 'task')
    .map(row => ({ ...row, status: row.domainStatus ?? row.status })).sort((a, b) => Number(a.status === 'completed') - Number(b.status === 'completed') || activityTime(b) - activityTime(a)), [activityRows]);
  const [actionError, setError] = useState(''), [busy, setBusy] = useState(null);
  const error = actionError || activityError;
  const [concurrency, setConcurrency] = useState(''), [configRevision, setConfigRevision] = useState(null), [settingsOpen, setSettingsOpen] = useState(false), [configError, setConfigError] = useState('');
  const [selectedId, setSelectedId] = useState(null), [changeId, setChangeId] = useState(null), [detailDirty, setDetailDirty] = useState(false);
  const [detailTab, setDetailTab] = useState('execution');
  const detailTabsId = useId();
  const detailTabs = [['execution', '记录', '执行记录', 'schedules'], ['requirements', '要求', '任务要求', 'edit'], ['result', '结果', '执行结果', 'box']].map(([value, label, ariaLabel, icon]) => ({ value, label, ariaLabel, icon: <UIIcon name={icon} size={16} />, panelId: `${detailTabsId}-panel-${value}` }));
  const [cleanup, setCleanup] = useState(null);
  useLayoutEffect(() => { onDetailChange?.(!!selectedId || !!cleanup); return () => onDetailChange?.(false); }, [selectedId, cleanup, onDetailChange]);
  const [archiveScope, setArchiveScope] = useState('active');
  const [loadedDetailId, setLoadedDetailId] = useState(null);
  const [view, setView] = useState('list'), [query, setQuery] = useState('');
  const listContainer = useRef(null), listPosition = useRef(null), previousSelection = useRef(null);
  const rememberListPosition = useCallback(() => {
    const scroll = [];
    for (let node = listContainer.current; node; node = node.parentElement) scroll.push([node, node.scrollTop, node.scrollLeft]);
    const focused = document.activeElement;
    listPosition.current = { opener: focused?.closest('.ba-task-open') || focused, scroll };
  }, []);
  const openDetail = useCallback((id, change = false) => {
    rememberListPosition(); setCleanup(null);
    setChangeId(change ? id : null); setDetailTab(change ? 'requirements' : 'execution'); setSelectedId(id); setLoadedDetailId(id); setError('');
  }, [rememberListPosition]);
  const openCleanup = (mode, taskIds) => { rememberListPosition(); setSelectedId(null); setCleanup({ mode, taskIds }); setError(''); };
  const closeDetail = () => { setSelectedId(null); setChangeId(null); setError(''); };
  useLayoutEffect(() => {
    if (!selectedId && !cleanup && previousSelection.current && listPosition.current) {
      const { opener, scroll } = listPosition.current;
      for (const [node, top, left] of scroll) if (node.isConnected) { node.scrollTop = top; node.scrollLeft = left; }
      if (opener?.isConnected && listContainer.current?.contains(opener)) opener.focus({ preventScroll: true });
      else listContainer.current?.querySelector('input[type="search"]')?.focus({ preventScroll: true });
    }
    previousSelection.current = selectedId || cleanup;
  }, [selectedId, cleanup]);
  useEffect(() => {
    if (!requestedTask?.taskId) return;
    const id = requestedTask.taskId; let current = true;
    openDetail(id); setLoadedDetailId(null);
    void refreshTasks([id]).catch(cause => { if (current) setError(cause.message); })
      .finally(() => { if (current) setLoadedDetailId(id); });
    return () => { current = false; };
  }, [requestedTask, refreshTasks, openDetail]);
  const viewId = useId();
  const detailDirtyCallback = useRef(null);
  detailDirtyCallback.current = dirty => { setDetailDirty(dirty); dirtyEditor('task-detail')(dirty); };
  const detailChanged = React.useCallback(dirty => detailDirtyCallback.current?.(dirty), []);
  const reload = async () => { setError(''); await refresh(); };
  const lifecycle = async (row, method, input = {}) => { setBusy(row.id); setError(''); try { const response = await api(method, { taskId: row.id, ...input }); if (method === 'taskResume' && response?.queued === false) throw new Error(`系统状态：原任务暂未恢复（${response.code || 'WAITING'}）`); await refreshTasks([row.id]); } catch (cause) { setError(cause.message); } finally { setBusy(null); } };
  const savedConcurrency = useRef('');
  const configDirty = dirtyEditor('configuration');
  useEffect(() => { configDirty(settingsOpen && concurrency !== savedConcurrency.current); return () => configDirty(false); }, [settingsOpen, concurrency, configDirty]);
  const loadConfig = async () => { setConfigError(''); try { const value = await api('state'); savedConcurrency.current = String(value.config.workerConcurrency ?? 2); setConcurrency(savedConcurrency.current); setConfigRevision(value.config.revision); } catch (cause) { setConfigError(cause.message); } };
  const closeSettings = () => { if (busy === 'configuration') return; setConcurrency(savedConcurrency.current); setSettingsOpen(false); setConfigError(''); };
  const saveConcurrency = async event => {
    event.preventDefault(); if (configRevision === null || !Number.isInteger(Number(concurrency)) || Number(concurrency) < 1 || busy === 'configuration') return; setBusy('configuration'); setConfigError('');
    try {
      const value = await api('config', { revision: configRevision, patch: { workerConcurrency: Number(concurrency) } });
      setConfigRevision(value.revision); savedConcurrency.current = concurrency; setSettingsOpen(false);
    } catch (cause) { setConfigError(cause.message); }
    finally { setBusy(null); }
  };
  const visibleRows = rows?.filter(row => !row.taskMeta?.deleted && archivedActivityTask(row) === (archiveScope === 'archived'));
  const filteredRows = filterTasks(visibleRows || [], query);
  const cleanupCandidates = filteredRows.filter(row => (row.status === 'completed' || row.executionControl?.stopped) && !row.cleanup?.id && !row.taskMeta?.archived);
  const selectedRow = rows?.find(row => row.id === selectedId && !row.taskMeta?.deleted);
  const switchArchiveScope = value => {
    setError(''); setArchiveScope(value);
  };
  const openChange = id => { setDetailTab('requirements'); setChangeId(id); };
  const renderTask = (row, detailOnly = false) => {
      const { result, delivery, safetyWait } = taskSnapshot(row);
      const resultText = result?.summary || result?.delivery?.text;
      const activity = activityTask(row, 'task'), status = activity.status;
      const waiting = taskWaiting(row);
      const deliveryLabel = delivery?.receipt?.status === 'suppressed' ? '回复已取消' : delivery?.state === 'sent' ? '已送达'
        : delivery?.state === 'uncertain' ? '发送待核实' : delivery?.payload?.replyState === 'pending' ? '待生成回复' : '待送达';
      const stateLabel = status === 'completed' ? `执行完成${delivery ? ` · ${deliveryLabel}` : ''}` : taskLabels[status] || '等待';
      const control = row.executionControl || {};
      const changeBlocked = safetyWait || control.pauseRequested || control.stopRequested || row.assignments?.some(item => item.state === 'uncertain');
      const changeLabel = row.status === 'completed' || control.stopped ? '创建关联调整任务' : '修订要求';
      const recovery = continuationRecovery(row);
      const title = normalizeTaskTitle(row.taskMeta?.title || row.title, row.target);
      const summary = waiting?.reason || activity.progressSummary || activity.detail || activity.phase;
      const detailSummary = visibleExecutionActivity(summary);
      const updatedLabel = row.updatedAt ? new Date(row.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      const actions = [];
      if (row.status !== 'completed' && !control.stopped) {
        if (recovery) actions.push({ icon: 'play', label: recovery.label, onClick: () => lifecycle(row, 'taskResume', recovery.input), disabled: busy !== null });
        else if (control.paused && !control.stopRequested && !safetyWait) actions.push({ icon: 'play', label: '继续任务', onClick: () => lifecycle(row, 'taskResume'), disabled: busy !== null });
      } else actions.push({ icon: 'refresh', label: '创建关联调整任务', onClick: () => openDetail(row.id, true), disabled: busy !== null });
      return <React.Fragment key={row.id}>{!detailOnly && <TaskListRow api={api} kind="task" row={row} title={title} summary={<><span className="ba-task-state" data-state={status}>{stateLabel}</span><Tooltip label={summary} onlyWhenClipped><span className="ba-task-summary" tabIndex={0}>{summary}</span></Tooltip>{updatedLabel && <time className="ba-task-updated" dateTime={row.updatedAt}>更新 {updatedLabel}</time>}{row.cleanup?.archivedAt && <time className="ba-task-updated" dateTime={row.cleanup.archivedAt}>归档整理于 {new Date(row.cleanup.archivedAt).toLocaleString('zh-CN')}</time>}</>} onChanged={() => refreshTasks([row.id])} onOpen={() => openDetail(row.id)} onArchive={() => openCleanup('archive', [row.id])} onRestore={() => openCleanup('restore', [row.id])} actions={actions} onDirtyChange={dirtyEditor(`rename:${row.id}`)} />}
      {detailOnly && <TaskDetail inline open title={<TaskStatusTitle title={title} status={status} label={stateLabel} />} headerActions={<><div className="ba-task-detail-tabs"><SegmentedControl options={detailTabs} value={detailTab} onChange={setDetailTab} label="任务详情内容" tabIdPrefix={detailTabsId} /></div><TaskIconButton icon={row.status === 'completed' || control.stopped ? 'refresh' : 'edit'} label={changeLabel} tooltip={changeBlocked ? '执行尚未结束或已中断，已有记录保留。' : changeLabel} disabled={changeBlocked || detailDirty || busy !== null} onClick={() => openChange(row.id)} /></>} dirty={detailDirty} onClose={closeDetail} footer={row.executionSession?.available && <div className="ba-row-actions">
        {row.executionSession?.available && <TaskIconButton icon="external" label={busy === `execution:${row.id}` ? '正在打开执行会话…' : '查看执行会话'} disabled={!onOpenExecution || busy !== null} onClick={async event => {
          event.currentTarget.closest('.ba-task-inline')?.focus({ preventScroll: true });
          setBusy(`execution:${row.id}`); setError('');
          try { await onOpenExecution(row.executionSession); } catch (cause) { setError(`执行会话暂时无法打开：${cause.message || cause}`); }
          finally { setBusy(null); }
        }} />}
      </div>}>
        {error && <p role="alert">{error}</p>}
        {row.cleanup?.id && <section className="ba-cleanup-record" aria-label="归档记录"><div><strong>已归档整理</strong>{row.cleanup.archivedAt && <time dateTime={row.cleanup.archivedAt}>{new Date(row.cleanup.archivedAt).toLocaleString('zh-CN')}</time>}<p className="ba-note">成果与执行记录仍保留。恢复展示不会重新执行任务。</p></div><Button variant="outline" disabled={detailDirty || busy !== null} onClick={() => openCleanup('restore', [row.id])}>恢复展示</Button></section>}
        <TaskWaiting singleLine key={`${row.id}:${row.instructionRevision}:${row.resultVersion}`} api={api} task={row} onRefresh={() => refreshTasks([row.id])} onOpenResources={() => openChange(row.id)} showQuestion={false} />
        {!!row.attentions?.length && !safetyWait && !row.assignments?.some(item => item.state === 'uncertain') && <section className="ba-stack" aria-label="待处理交互">{row.attentions.map(attention => <TaskAttention key={`${attention.id}:${row.instructionRevision}`} api={api} task={row} attention={attention} onAnswered={() => refreshTasks([row.id])} />)}</section>}
        <section id={`${detailTabsId}-panel-execution`} role="tabpanel" aria-labelledby={`${detailTabsId}-execution`} hidden={detailTab !== 'execution'} tabIndex={0} className="ba-task-detail-panel">
          {!result && !waiting && detailSummary && !activity.execution?.worker && !activity.execution?.summary?.text && <section className="ba-task-result-summary"><h3>当前进展</h3><p>{detailSummary}</p></section>}
          <TaskExecution key={row.id} execution={activity.execution} taskStatus={status} executionControl={row.executionControl} stale={!!error} sessionAvailable={row.executionSession?.available} />
        </section>
        <section id={`${detailTabsId}-panel-requirements`} role="tabpanel" aria-labelledby={`${detailTabsId}-requirements`} hidden={detailTab !== 'requirements'} tabIndex={0} className="ba-task-detail-panel">
          <TaskFacts key={`requirements:${row.id}`} task={row} />
          <TaskChange key={`change:${row.id}`} api={api} task={row} reload={reload} onDirtyChange={detailChanged} startOpen={changeId === row.id} hideTrigger onClose={() => setChangeId(null)} />
        </section>
        <section id={`${detailTabsId}-panel-result`} role="tabpanel" aria-labelledby={`${detailTabsId}-result`} hidden={detailTab !== 'result'} tabIndex={0} className="ba-task-detail-panel">
          {result ? <>
            {(result.instructionRevision ?? 1) !== (row.instructionRevision ?? 1) && <p className="ba-note">这是旧要求的结果，当前版本尚待执行。</p>}
            <TaskDocument title="结果" icon="document" meta={`要求版本 ${result.instructionRevision ?? 1}`}><TaskMarkdown text={resultText || '当前结果没有文字内容。'} /></TaskDocument>
          </> : <ResourceState title="尚无结果" description="执行结果保存后会显示在这里。" />}
          {delivery?.lastError && <p role="status" className="ba-note">{delivery.lastError}</p>}
        </section>
      </TaskDetail>}</React.Fragment>;

  };
  return <section className="ba-group ba-tasks" aria-label="任务"><style>{taskCss}</style><div ref={listContainer} hidden={!!selectedId || !!cleanup} style={selectedId || cleanup ? { display: 'none' } : undefined} className="ba-task-list-container">
    <Modal open={settingsOpen} onClose={closeSettings} title="任务设置" closeLabel="关闭" footer={<><Button variant="ghost" className="cmd-dialog-button" disabled={busy === 'configuration'} onClick={closeSettings}>取消</Button><Button className="cmd-dialog-button cmd-dialog-primary" type="submit" form="ba-worker-settings" disabled={configRevision === null || busy === 'configuration' || !Number.isInteger(Number(concurrency)) || Number(concurrency) < 1}>{busy === 'configuration' ? '保存中…' : '保存'}</Button></>}><form id="ba-worker-settings" className="cmd-rename-form ba-worker-settings" aria-label="并发执行设置" onSubmit={saveConcurrency}><div className="ba-worker-settings-intro"><UIIcon name="settings" size={22} /><div><strong>执行容量</strong><p id="ba-worker-concurrency-help">设置同时执行的任务数量，按设备性能与模型额度调整。</p></div></div><label htmlFor="ba-worker-concurrency">并发数</label><div className="ba-worker-settings-input"><input id="ba-worker-concurrency" aria-describedby="ba-worker-concurrency-help" autoFocus type="number" min="1" step="1" required value={concurrency} disabled={configRevision === null || busy === 'configuration'} onChange={event => setConcurrency(event.target.value)} /><span>项任务</span></div>{configRevision === null && !configError && <p className="ba-worker-settings-status" role="status"><UIIcon name="refresh" size={16} />正在读取执行设置…</p>}{configError && <p className="ba-worker-settings-error" role="alert"><UIIcon name="close" size={16} /><span>{configError}</span><Button variant="ghost" type="button" disabled={busy === 'configuration'} onClick={loadConfig}>重新读取</Button></p>}</form></Modal>
    <TaskViewControls disabled={listDirty || detailDirty} view={view} onViewChange={setView} archiveScope={archiveScope} onArchiveScopeChange={switchArchiveScope} query={query} onQueryChange={setQuery} archiveAction={<TaskIconButton icon="archive" label="归档已结束任务" tooltip={rows === null ? '正在同步可归档任务' : cleanupCandidates.length ? `归档已结束任务 · ${cleanupCandidates.length} 项可归档` : '暂无可归档任务'} disabled={!cleanupCandidates.length || listDirty || detailDirty || busy !== null} onClick={() => openCleanup('archive', cleanupCandidates.map(row => row.id))} />} panelId={`${viewId}-panel`} tabIdPrefix={`${viewId}-tab`}><div className="ba-task-actions ba-task-list-actions">{onSchedule && <TaskIconButton icon="schedules" label="定时任务" onClick={onSchedule} />}<TaskIconButton icon="settings" label="设置" onClick={() => { setSettingsOpen(true); setConfigRevision(null); void loadConfig(); }} /></div></TaskViewControls>
    {error && (rows === null ? <ResourceState kind="error" title="任务暂时无法读取" description={error} onAction={reload} /> : <div className="ba-task-feedback" role="alert"><UIIcon name="close" size={18} /><span tabIndex={0} aria-label="任务错误详情">任务未能更新：{error}</span><Button variant="ghost" type="button" className="ba-quiet" onClick={reload}>重试读取</Button></div>)}
    {rows === null && !error && <ResourceState kind="loading" title="正在读取任务" description="正在同步执行进展与交付结果。" />}
    {visibleRows?.length === 0 && !error && <ResourceState icon="box" title={archiveScope === 'archived' ? '暂无归档任务' : '暂无任务'} description={archiveScope === 'archived' ? '手动归档的任务保存在这里，成果与执行记录仍可查看。' : '在 SuperAgent 对话中交办任务。完成的任务会保留在当前列表。'} actionLabel={archiveScope === 'archived' ? '查看当前任务' : undefined} onAction={archiveScope === 'archived' ? () => switchArchiveScope('active') : undefined} />}
    {visibleRows?.length > 0 && <div id={`${viewId}-panel`} role="tabpanel" aria-labelledby={`${viewId}-tab-${view}`}>
      {!filteredRows.length ? <ResourceState icon="search" title="没有匹配的任务" description="换个关键词，或清除搜索查看全部任务。" actionLabel="清除搜索" onAction={() => setQuery('')} />
        : view === 'board' ? <TaskBoard rows={filteredRows} renderTask={row => renderTask(row)} />
        : <div className="ba-task-list">{filteredRows.map(row => renderTask(row))}</div>}
    </div>}
    </div>
    {cleanup && <TaskCleanup api={api} mode={cleanup.mode} taskIds={cleanup.taskIds} onClose={() => setCleanup(null)} onChanged={async ids => { await refreshTasks(ids); setCleanup(null); }} />}
    {selectedId && !selectedRow && <TaskDetail inline open title="任务详情" onClose={closeDetail}><ResourceState kind={error || (rows !== null && loadedDetailId === selectedId) ? 'error' : 'loading'} title={error ? '任务详情暂时无法读取' : rows !== null && loadedDetailId === selectedId ? '关联任务暂不可用' : '正在读取任务详情'} description={error || (rows !== null && loadedDetailId === selectedId ? '任务可能已移出列表，或尚未同步。' : '正在读取原任务、成果与执行记录。')} onAction={error || loadedDetailId === selectedId ? async () => { setError(''); await refreshTasks([selectedId]); setLoadedDetailId(selectedId); } : undefined} /></TaskDetail>}
    {selectedRow && renderTask(selectedRow, true)}
  </section>;
}
