import { Tooltip } from '../../shared/client/ui/tooltip.jsx';
import { useConfirmation } from '../../shared/client/ui/confirmation.jsx';
import { Disclosure } from '../../shared/client/ui/collapsible.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import React, { useEffect, useId, useRef, useState } from 'react';
import { useDirtyRegistry } from './dirty-registry.mjs';
import { TicketCheckpoints } from './checkpoints.jsx';
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import taskCss from './tasks.css';
import { TicketBoard, TicketViewControls } from './ticket-board.jsx';
import { filterTickets } from './ticket-board.mjs';
import { TaskListRow, TaskDetail, TaskIconButton, TaskStatusTitle } from './task-list.jsx';
import { ResourceState } from './resource-state.jsx';
import { TicketAttention } from './ticket-attention.jsx';
import { TicketWaiting } from './ticket-waiting.jsx';
import { continuationRecovery, ticketSnapshot, ticketWaiting } from './ticket-state.mjs';
import { normalizeTicketTitle } from '../src/ticket-title.mjs';
import { activityTask } from './activity-data.mjs';
import { TaskExecution } from './task-execution.jsx';

const states = { open: '已开单', queued: '等待执行', claimed: '执行中', completed: '已完成', waiting: '等待处理', awaiting_user: '等待你的答复', delivery_pending: '等待交付', continuation_wait: '等待恢复条件', pausing: '正在暂停', paused: '已暂停', failed: '执行失败', cancelling: '停止已生效 · 正在结束执行', cancelled: '已停止', uncertain: '执行状态待同步', blocked: '授权已变更' };
const deliveryStates = { queued: '等待交付', claimed: '正在交付', sent: '渠道已接收', uncertain: '发送结果待核实' };
const terminalStates = ['completed', 'failed', 'cancelled', 'closed'];

export function TicketChange({ api, ticket, reload, onDirtyChange, startOpen = false }) {
  const [draft, setDraft] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const request = useRef(null);
  useEffect(() => { onDirtyChange?.(!!draft); return () => onDirtyChange?.(false); }, [!!draft, onDirtyChange]);
  const terminal = terminalStates.includes(ticket.status);
  const pending = ticketSnapshot(ticket).safetyWait || ['pausing', 'cancelling', 'uncertain'].includes(ticket.status) || ticket.assignments?.some(row => row.state === 'uncertain');
  const open = () => {
    setDraft({ operation: terminal ? 'adjustment' : 'revise', expectedInstructionRevision: ticket.instructionRevision, target: ticket.target, acceptance: ticket.acceptance || '', reason: '' });
    request.current = null; setError('');
  };
  useEffect(() => { if (startOpen) open(); }, [startOpen]);
  const update = patch => { setDraft({ ...draft, ...patch }); request.current = null; setError(''); };
  const submit = async event => {
    event.preventDefault(); if (busy || !draft?.target.trim() || !draft.reason.trim()) return;
    setBusy(true); setError(''); request.current ||= crypto.randomUUID();
    try { await api('ticketChange', { id: ticket.id, ...draft, requestId: request.current }); setDraft(null); await reload(); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  return <section className="ba-stack" aria-label="工单要求管理">
    {draft ? <form className="ba-stack" onSubmit={submit}><h3>{draft.operation === 'adjustment' ? '创建关联调整单' : '修订工单'} · 要求版本 {draft.expectedInstructionRevision}</h3>
      <p className="ba-note">{terminal ? '保留原工单成果与记录，按当前授权创建关联调整单。' : '补充会在下一工具边界应用，在途操作继续按已提交要求执行。'}</p>
      <fieldset disabled={busy}><label className="ba-connection-field"><span>任务要求</span><textarea required rows={4} value={draft.target} onChange={event => update({ target: event.target.value })} /></label>
        <label className="ba-connection-field"><span>验收条件</span><textarea rows={3} value={draft.acceptance} onChange={event => update({ acceptance: event.target.value })} /></label>
        <label className="ba-connection-field"><span>变更原因</span><textarea required maxLength={10000} rows={2} value={draft.reason} onChange={event => update({ reason: event.target.value })} /></label></fieldset>
      {ticket.instructionRevision !== draft.expectedInstructionRevision && <p role="status" className="ba-note">工单已有新版本。请保留所需内容，关闭表单后重新打开。</p>}
      {error && <p role="alert">{error}</p>}<div className="ba-row-actions"><Button variant="ghost" type="button" className="ba-quiet" disabled={busy} onClick={() => setDraft(null)}>取消</Button><Button type="submit" className="ba-primary" disabled={busy || pending || ticket.instructionRevision !== draft.expectedInstructionRevision || !draft.target.trim() || !draft.reason.trim()}>{busy ? '提交中…' : '保存并排队'}</Button></div>
    </form> : <div><TaskIconButton icon={terminal ? 'refresh' : 'edit'} label={terminal ? '创建关联调整单' : '修订要求'} disabled={pending} onClick={open} />{pending && <p className="ba-note">系统正在自动核查停止状态或外部效果，核查结束后可调整要求。</p>}</div>}
    {!!ticket.revisions?.length && <Disclosure title={<>要求修订历史</>}><ol>{ticket.revisions.map(row => <li key={row.instructionRevision}><strong>版本 {row.instructionRevision} · {({ original: '原始要求', revise: '修订', adjustment: '关联调整' })[row.operation] || row.operation}</strong><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{row.target}</p>{row.acceptance && <p>验收条件：{row.acceptance}</p>}{row.reason && <p>原因：{row.reason}</p>}<small>{row.createdAt}</small></li>)}</ol></Disclosure>}
  </section>;
}

export function Tickets({ api, onDirtyChange, onCreateGoal, onSchedule, onOpenExecution, requestedTicket }) {
  const [confirm, confirmation] = useConfirmation();
  const [listDirty, setListDirty] = useState(false);
  const dirtyEditor = useDirtyRegistry((dirty, keys) => { setListDirty(keys.some(key => key.startsWith('rename:'))); onDirtyChange?.(dirty, keys); });
  const [rows, setRows] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(null), [generation, setGeneration] = useState(0);
  const [concurrency, setConcurrency] = useState(''), [configRevision, setConfigRevision] = useState(null), [settingsOpen, setSettingsOpen] = useState(false), [configError, setConfigError] = useState('');
  const [selectedId, setSelectedId] = useState(null), [changeId, setChangeId] = useState(null), [detailDirty, setDetailDirty] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState(null), [archiveScope, setArchiveScope] = useState('active');
  const [loadedDetailId, setLoadedDetailId] = useState(null);
  useEffect(() => { if (requestedTicket?.ticketId) { setSelectedId(requestedTicket.ticketId); setChangeId(null); } }, [requestedTicket]);
  const [view, setView] = useState('list'), [query, setQuery] = useState('');
  const viewId = useId();
  const detailDirtyCallback = useRef(null);
  detailDirtyCallback.current = dirty => { setDetailDirty(dirty); dirtyEditor('ticket-detail')(dirty); };
  const detailChanged = React.useCallback(dirty => detailDirtyCallback.current?.(dirty), []);
  const lifecycle = async (row, method, input = {}) => { setBusy(row.id); setError(''); try { const response = await api(method, { ticketId: row.id, ...input }); if (method === 'ticketResume' && response?.queued === false) throw new Error(`系统状态：原工单暂未恢复（${response.code || 'WAITING'}）`); setGeneration(value => value + 1); } catch (cause) { setError(cause.message); } finally { setBusy(null); } }; 
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
  useEffect(() => {
    const controller = new AbortController(); let timer;
    const load = async () => {
      try {
        const [value, detail] = await Promise.all([
          api('tickets', { archived: archiveScope === 'archived' }, controller.signal),
          selectedId ? api('tickets', { ticketId: selectedId }, controller.signal) : null,
        ]);
        if (!controller.signal.aborted) { setRows(value.tickets); setSelectedTicket(detail?.tickets?.[0] || null); setLoadedDetailId(selectedId); setError(''); }
      }
      catch (cause) { if (!controller.signal.aborted) setError(cause.message); }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, 3000); }
    };
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [api, generation, archiveScope, selectedId]);
  const stop = async row => {
    if (!await confirm({ title: `停止“${normalizeTicketTitle(row.taskMeta?.title || row.title, row.target)}”？`, description: '停止后将拦截后续动作，并等待执行端结束当前执行；已发生的外部操作仍会保留。', confirmLabel: '停止工单', destructive: true })) return;
    setBusy(row.id);
    try { await api('ticketStop', { ticketId: row.id }); setGeneration(value => value + 1); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(null); }
  };
  const visibleRows = rows?.filter(row => !row.taskMeta?.deleted);
  const filteredRows = filterTickets(visibleRows || [], query);
  const selectedRow = visibleRows?.find(row => row.id === selectedId) || (selectedTicket?.id === selectedId ? selectedTicket : null);
  const switchArchiveScope = value => {
    setRows(null); setError(''); setSelectedId(null); setSelectedTicket(null); setChangeId(null); setArchiveScope(value);
  };
  const renderTicket = (row, detailOnly = false) => {
      const { result, delivery, safetyWait } = ticketSnapshot(row);
      const activity = activityTask(row, 'ticket'), status = activity.status;
      const waiting = ticketWaiting(row);
      const stateLabel = waiting?.label || (safetyWait ? '等待核实外部效果' : status === 'verifying' ? '正在保存结果' : states[status] || status);
      const recovery = continuationRecovery(row);
      const title = normalizeTicketTitle(row.taskMeta?.title || row.title, row.target);
      const summary = waiting?.reason || activity.progressSummary || activity.detail || activity.phase;
      const updatedLabel = row.updatedAt ? new Date(row.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      const actions = [];
      const canPause = !terminalStates.includes(row.status) && !['paused', 'pausing', 'cancelling'].includes(row.status);
      if (!terminalStates.includes(row.status)) {
        if (recovery) actions.push({ icon: 'play', label: recovery.label, onClick: () => lifecycle(row, 'ticketResume', recovery.input), disabled: busy !== null });
        else if (row.status === 'paused' && !safetyWait) actions.push({ icon: 'play', label: '继续工单', onClick: () => lifecycle(row, 'ticketResume'), disabled: busy !== null });
        if (canPause) actions.push({ icon: 'pause', label: '暂停工单', onClick: () => lifecycle(row, 'ticketPause'), disabled: busy !== null });
        if (status !== 'cancelling') actions.push({ icon: 'stop', label: '停止工单', onClick: () => stop(row), disabled: busy !== null });
      } else actions.push({ icon: 'refresh', label: '创建关联调整单', onClick: () => { setChangeId(row.id); setSelectedId(row.id); }, disabled: busy !== null });
      return <React.Fragment key={row.id}>{!detailOnly && <TaskListRow api={api} kind="ticket" row={row} title={title} verification={waiting?.verificationSummary} summary={<><span className="ba-task-state" data-state={status}>{stateLabel}</span><Tooltip label={summary} onlyWhenClipped><span className="ba-task-summary" tabIndex={0}>{summary}</span></Tooltip>{updatedLabel && <time className="ba-task-updated" dateTime={row.updatedAt}>更新 {updatedLabel}</time>}</>} completed={row.status === 'completed'} completionLocked={row.status === 'completed' && !row.taskMeta?.completed} onChanged={() => setGeneration(value => value + 1)} onOpen={() => { setChangeId(null); setSelectedId(row.id); }} actions={actions} onDirtyChange={dirtyEditor(`rename:${row.id}`)} />}
      {detailOnly && <TaskDetail open title={<TaskStatusTitle title={title} status={status} label={stateLabel} />} dirty={detailDirty} onClose={() => { setSelectedId(null); setChangeId(null); }} footer={(row.executionSession?.available || canPause || (!terminalStates.includes(row.status) && !waiting)) && <div className="ba-row-actions">
        {row.executionSession?.available && <Button variant="ghost" disabled={!onOpenExecution || busy !== null} onClick={async () => {
          setBusy(`execution:${row.id}`); setError('');
          try { await onOpenExecution(row.executionSession); } catch (cause) { setError(`执行会话暂时无法打开：${cause.message || cause}`); }
          finally { setBusy(null); }
        }}>{busy === `execution:${row.id}` ? '正在打开执行会话…' : '查看执行会话'}</Button>}
        {canPause && <Button variant="ghost" disabled={busy !== null} onClick={() => lifecycle(row, 'ticketPause')}>{busy === row.id ? '正在提交暂停…' : '暂停工单'}</Button>}
        {!terminalStates.includes(row.status) && !waiting && <Button variant="outline" disabled={busy !== null} onClick={() => stop(row)}>{busy === row.id ? '正在提交停止…' : '停止工单'}</Button>}
      </div>}>
        {error && <p role="alert">{error}</p>}
        <TicketWaiting key={`${row.id}:${row.instructionRevision}:${row.resultVersion}`} api={api} ticket={row} onRefresh={() => setGeneration(value => value + 1)} onOpenResources={() => setChangeId(row.id)} showQuestion={false} />
        {!safetyWait && status !== 'uncertain' && <section className="ba-stack" aria-label="待处理交互">{row.attentions?.map(attention => <TicketAttention key={`${attention.id}:${row.instructionRevision}`} api={api} ticket={row} attention={attention} onAnswered={() => setGeneration(value => value + 1)} />)}</section>}
        {result && <section className="ba-ticket-result-summary"><h3>{status === 'completed' ? '结果摘要' : '最近结果'}</h3><p>{result.delivery?.text || result.finalSummary || result.summary || '当前结果没有文字摘要。'}</p></section>}
        {!result && !waiting && summary && <section className="ba-ticket-result-summary"><h3>当前进展</h3><p>{summary}</p></section>}
        <TaskExecution key={row.id} execution={activity.execution} ticketStatus={status} stale={!!error} />
        <section className="ba-task-instructions"><h3>任务要求</h3><p>{row.target}</p>{row.acceptance && <><h3>验收条件</h3><p>{row.acceptance}</p></>}</section>
        <p className="ba-note">{row.mandate?.source?.channel === 'feishu' ? '飞书' : '桌面'} · {delivery ? deliveryStates[delivery.state] || delivery.state : '尚无交付结果'}</p>
        {result && <Disclosure title={<>查看结果与证据 · 要求版本 {result.instructionRevision ?? 1}</>}>{(result.instructionRevision ?? 1) !== (row.instructionRevision ?? 1) && <p className="ba-note">这是旧要求的结果，当前版本尚待执行。</p>}{result.selfCheck && <p>自检：{result.selfCheck.summary}</p>}{result.failure && <p>无法完成：{result.failure.cause}<br />已尝试：{result.failure.attempted}<br />继续条件：{result.failure.resumeConditions}</p>}<ul>{result.evidenceRefs?.map((ref, index) => <li key={index}>会话：{ref.sessionId || '—'}{ref.runId ? ` · 执行：${ref.runId}` : ''}</li>)}</ul></Disclosure>}
        {delivery?.lastError && <p role="status" className="ba-note">{delivery.lastError}</p>}
        <section className="ba-stack" aria-label="工单操作"><TicketChange api={api} ticket={row} reload={async () => setGeneration(value => value + 1)} onDirtyChange={detailChanged} startOpen={changeId === row.id} />
        <TicketCheckpoints ticket={row} list={async input => (await api('checkpointList', input)).checkpoints} preview={input => api('checkpointPreview', input)} restore={input => api('checkpointRestore', input)} reload={async () => setGeneration(value => value + 1)} /></section>
      </TaskDetail>}</React.Fragment>;

  };
  return <section className="ba-group ba-tasks" aria-label="工单">{confirmation}<style>{taskCss}</style><div className="ba-group-head"><div><h2>工单</h2><p>查看执行进展，确认结果与下一步。</p></div><div className="ba-task-actions">{onSchedule && <Button variant="ghost" type="button" className="ba-task-secondary" onClick={onSchedule}><UIIcon name="schedules" size={16} />定时任务</Button>}{onCreateGoal && <Button type="button" className="ba-primary" onClick={onCreateGoal}><UIIcon name="plus" size={16} />新建持续目标</Button>}<Button variant="ghost" type="button" className="ba-task-secondary" onClick={() => { setSettingsOpen(true); setConfigRevision(null); void loadConfig(); }}><UIIcon name="settings" size={16} />设置</Button></div></div>
    <Modal open={settingsOpen} onClose={closeSettings} title="工单设置" closeLabel="关闭" footer={<><Button variant="ghost" className="cmd-dialog-button" disabled={busy === 'configuration'} onClick={closeSettings}>取消</Button><Button className="cmd-dialog-button cmd-dialog-primary" type="submit" form="ba-worker-settings" disabled={configRevision === null || busy === 'configuration' || !Number.isInteger(Number(concurrency)) || Number(concurrency) < 1}>{busy === 'configuration' ? '保存中…' : '保存'}</Button></>}><form id="ba-worker-settings" className="cmd-rename-form ba-worker-settings" aria-label="并发执行设置" onSubmit={saveConcurrency}><div className="ba-worker-settings-intro"><UIIcon name="settings" size={22} /><div><strong>执行容量</strong><p id="ba-worker-concurrency-help">设置同时执行的工单数量，按设备性能与模型额度调整。</p></div></div><label htmlFor="ba-worker-concurrency">并发数</label><div className="ba-worker-settings-input"><input id="ba-worker-concurrency" aria-describedby="ba-worker-concurrency-help" autoFocus type="number" min="1" step="1" required value={concurrency} disabled={configRevision === null || busy === 'configuration'} onChange={event => setConcurrency(event.target.value)} /><span>项工单</span></div>{configRevision === null && !configError && <p className="ba-worker-settings-status" role="status"><UIIcon name="refresh" size={16} />正在读取执行设置…</p>}{configError && <p className="ba-worker-settings-error" role="alert"><UIIcon name="close" size={16} /><span>{configError}</span><Button variant="ghost" type="button" disabled={busy === 'configuration'} onClick={loadConfig}>重新读取</Button></p>}</form></Modal>
    <TicketViewControls disabled={listDirty || detailDirty} view={view} onViewChange={setView} archiveScope={archiveScope} onArchiveScopeChange={switchArchiveScope} query={query} onQueryChange={setQuery} count={filteredRows.length} total={visibleRows?.length} panelId={`${viewId}-panel`} tabIdPrefix={`${viewId}-tab`} />
    {error && (rows === null ? <ResourceState kind="error" title="工单暂时无法读取" description={error} onAction={() => setGeneration(value => value + 1)} /> : <div className="ba-task-feedback" role="alert"><UIIcon name="close" size={18} /><span tabIndex={0} aria-label="工单错误详情">工单未能更新：{error}</span><Button variant="ghost" type="button" className="ba-quiet" onClick={() => setGeneration(value => value + 1)}>重试读取</Button></div>)}
    {rows === null && !error && <ResourceState kind="loading" title="正在读取工单" description="正在同步执行进展与交付结果。" />}
    {rows !== null && selectedId && !selectedRow && !error && (loadedDetailId !== selectedId ? <ResourceState kind="loading" title="正在读取工单详情" description="正在读取原工单、成果与执行记录。" /> : <ResourceState kind="error" title="关联工单暂不可用" description="工单可能已移除，或尚未同步。" actionLabel="重新读取" onAction={() => setGeneration(value => value + 1)} />)}
    {visibleRows?.length === 0 && !error && <ResourceState icon="box" title={archiveScope === 'archived' ? '暂无归档工单' : '暂无工单'} description={archiveScope === 'archived' ? '工单确认送达并关闭后，会自动收进这里，成果与执行记录仍可查看。' : '在聊天中交办任务，或创建一个持续目标。已关单的记录可在“已归档”中查看。'} actionLabel={archiveScope === 'archived' ? '查看当前工单' : '新建持续目标'} onAction={archiveScope === 'archived' ? () => switchArchiveScope('active') : onCreateGoal} />}
    {visibleRows?.length > 0 && <div id={`${viewId}-panel`} role="tabpanel" aria-labelledby={`${viewId}-tab-${view}`}>
      {!filteredRows.length ? <ResourceState icon="search" title="没有匹配的工单" description="换个关键词，或清除搜索查看全部工单。" actionLabel="清除搜索" onAction={() => setQuery('')} />
        : view === 'board' ? <TicketBoard rows={filteredRows} renderTicket={row => renderTicket(row)} />
        : <div className="ba-task-list">{filteredRows.map(row => renderTicket(row))}</div>}
    </div>}
    {selectedRow && renderTicket(selectedRow, true)}
  </section>;
}
