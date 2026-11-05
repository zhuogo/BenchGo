import { Disclosure } from '../../shared/client/ui/collapsible.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { useDirtyRegistry } from './dirty-registry.mjs';
import { TicketCheckpoints } from './checkpoints.jsx';
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import taskCss from './tasks.css';
import { TaskListRow, TaskDetail, TaskIconButton } from './task-list.jsx';
import { ResourceState } from './resource-state.jsx';
import { TicketAttention } from './ticket-attention.jsx';
import { TicketWaiting } from './ticket-waiting.jsx';
import { continuationRecovery, ticketSnapshot, ticketWaiting } from './ticket-state.mjs';
import { normalizeTicketTitle } from '../src/ticket-title.mjs';

const states = { open: '已开单', queued: '等待执行', claimed: '执行中', reworking: '原工单补做中', completed: '已完成', waiting: '等待处理', awaiting_user: '等待你的答复', review_wait: '系统自动核验中', continuation_wait: '系统等待续做资源', pausing: '正在暂停', paused: '已暂停', failed: '执行失败', cancelling: '正在停止 · 等待执行确认', cancelled: '已停止', uncertain: '执行待核实', blocked: '授权已变更' };
const deliveryStates = { queued: '等待交付', claimed: '正在交付', sent: '渠道已接收', uncertain: '发送结果待核实' };
const terminalStates = ['completed', 'failed', 'cancelled', 'closed'];

export function TicketChange({ api, ticket, reload, onDirtyChange, startOpen = false }) {
  const [draft, setDraft] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const request = useRef(null);
  useEffect(() => { onDirtyChange?.(!!draft); return () => onDirtyChange?.(false); }, [!!draft, onDirtyChange]);
  const terminal = terminalStates.includes(ticket.status);
  const pending = ticketSnapshot(ticket).safetyWait || ['pausing', 'cancelling', 'uncertain'].includes(ticket.status) || ticket.assignments?.some(row => ['claimed', 'uncertain'].includes(row.state));
  const open = () => {
    setDraft({ operation: terminal ? 'reopen' : 'revise', expectedInstructionRevision: ticket.instructionRevision, target: ticket.target, acceptance: ticket.acceptance || '', reason: '' });
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
    {draft ? <form className="ba-stack" onSubmit={submit}><h3>{draft.operation === 'reopen' ? '重开工单' : '修订工单'} · 要求版本 {draft.expectedInstructionRevision}</h3>
      <p className="ba-note">使用本机授权重新执行，结果投递到桌面。旧结果与来源保留在原版本。</p>
      <fieldset disabled={busy}><label className="ba-connection-field"><span>任务要求</span><textarea required rows={4} value={draft.target} onChange={event => update({ target: event.target.value })} /></label>
        <label className="ba-connection-field"><span>验收条件</span><textarea rows={3} value={draft.acceptance} onChange={event => update({ acceptance: event.target.value })} /></label>
        <label className="ba-connection-field"><span>变更原因</span><textarea required maxLength={10000} rows={2} value={draft.reason} onChange={event => update({ reason: event.target.value })} /></label></fieldset>
      {ticket.instructionRevision !== draft.expectedInstructionRevision && <p role="status" className="ba-note">工单已有新版本。请保留所需内容，关闭表单后重新打开。</p>}
      {error && <p role="alert">{error}</p>}<div className="ba-row-actions"><Button variant="ghost" type="button" className="ba-quiet" disabled={busy} onClick={() => setDraft(null)}>取消</Button><Button type="submit" className="ba-primary" disabled={busy || pending || ticket.instructionRevision !== draft.expectedInstructionRevision || !draft.target.trim() || !draft.reason.trim()}>{busy ? '提交中…' : '保存并排队'}</Button></div>
    </form> : <div><TaskIconButton icon={terminal ? 'refresh' : 'edit'} label={terminal ? '重开工单' : '修订要求'} disabled={pending} onClick={open} />{pending && <p className="ba-note">先暂停或停止，并确认执行已结束后，才能变更要求。</p>}</div>}
    {!!ticket.revisions?.length && <Disclosure title={<>要求修订历史</>}><ol>{ticket.revisions.map(row => <li key={row.instructionRevision}><strong>版本 {row.instructionRevision} · {({ original: '原始要求', revise: '修订', reopen: '重开' })[row.operation] || row.operation}</strong><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{row.target}</p>{row.acceptance && <p>验收条件：{row.acceptance}</p>}{row.reason && <p>原因：{row.reason}</p>}<small>{row.createdAt}</small></li>)}</ol></Disclosure>}
  </section>;
}

export function Tickets({ api, onDirtyChange, onCreateGoal, onOpenGoals, requestedTicket }) {
  const dirtyEditor = useDirtyRegistry(onDirtyChange);
  const [rows, setRows] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(null), [generation, setGeneration] = useState(0);
  const [concurrency, setConcurrency] = useState(''), [configRevision, setConfigRevision] = useState(null), [settingsOpen, setSettingsOpen] = useState(false), [configError, setConfigError] = useState('');
  const [selectedId, setSelectedId] = useState(null), [changeId, setChangeId] = useState(null), [detailDirty, setDetailDirty] = useState(false);
  useEffect(() => { if (requestedTicket?.ticketId) { setSelectedId(requestedTicket.ticketId); setChangeId(null); } }, [requestedTicket]);
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
      try { const value = await api('tickets', {}, controller.signal); if (!controller.signal.aborted) { setRows(value.tickets); setError(''); } }
      catch (cause) { if (!controller.signal.aborted) setError(cause.message); }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, 3000); }
    };
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [api, generation]);
  const stop = async row => {
    if (!window.confirm(`停止“${row.target}”？已发生的外部操作仍会保留，运行中的执行需要核实。`)) return;
    setBusy(row.id);
    try { await api('ticketStop', { ticketId: row.id }); setGeneration(value => value + 1); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(null); }
  };
  const visibleRows = rows?.filter(row => !row.taskMeta?.deleted);
  return <section className="ba-group ba-tasks" aria-label="工单"><style>{taskCss}</style><div className="ba-group-head"><div><h2>工单</h2><p>查看执行进展，确认结果与下一步。</p></div><div className="ba-task-actions">{onCreateGoal && <Button type="button" className="ba-primary" onClick={onCreateGoal}><UIIcon name="plus" size={16} />新建持续目标</Button>}<Button variant="ghost" type="button" className="ba-task-secondary" onClick={() => { setSettingsOpen(true); setConfigRevision(null); void loadConfig(); }}><UIIcon name="settings" size={16} />设置</Button></div></div>
    <Modal open={settingsOpen} onClose={closeSettings} title="工单设置" closeLabel="关闭" footer={<><Button variant="ghost" className="cmd-dialog-button" disabled={busy === 'configuration'} onClick={closeSettings}>取消</Button><Button className="cmd-dialog-button cmd-dialog-primary" type="submit" form="ba-worker-settings" disabled={configRevision === null || busy === 'configuration' || !Number.isInteger(Number(concurrency)) || Number(concurrency) < 1}>{busy === 'configuration' ? '保存中…' : '保存'}</Button></>}><form id="ba-worker-settings" className="cmd-rename-form ba-worker-settings" aria-label="并发执行设置" onSubmit={saveConcurrency}><div className="ba-worker-settings-intro"><UIIcon name="settings" size={22} /><div><strong>执行容量</strong><p id="ba-worker-concurrency-help">设置同时执行的工单数量，按设备性能与模型额度调整。</p></div></div><label htmlFor="ba-worker-concurrency">并发数</label><div className="ba-worker-settings-input"><input id="ba-worker-concurrency" aria-describedby="ba-worker-concurrency-help" autoFocus type="number" min="1" step="1" required value={concurrency} disabled={configRevision === null || busy === 'configuration'} onChange={event => setConcurrency(event.target.value)} /><span>项工单</span></div>{configRevision === null && !configError && <p className="ba-worker-settings-status" role="status"><UIIcon name="refresh" size={16} />正在读取执行设置…</p>}{configError && <p className="ba-worker-settings-error" role="alert"><UIIcon name="close" size={16} /><span>{configError}</span><Button variant="ghost" type="button" disabled={busy === 'configuration'} onClick={loadConfig}>重新读取</Button></p>}</form></Modal>
    {error && (rows === null ? <ResourceState kind="error" title="工单暂时无法读取" description={error} onAction={() => setGeneration(value => value + 1)} /> : <div className="ba-task-feedback" role="alert"><UIIcon name="close" size={18} /><span>工单未能更新：{error}</span><Button variant="ghost" type="button" className="ba-quiet" onClick={() => setGeneration(value => value + 1)}>重试读取</Button></div>)}
    {rows === null && !error && <ResourceState kind="loading" title="正在读取工单" description="正在同步执行进展与交付结果。" />}
    {rows !== null && selectedId && !visibleRows.some(row => row.id === selectedId) && <ResourceState kind="error" title="关联工单暂不可用" description="工单可能已移除，或尚未同步到当前列表。" actionLabel="重新读取" onAction={() => setGeneration(value => value + 1)} />}
    {visibleRows?.length === 0 && !error && <ResourceState icon="box" title="暂无工单" description="在聊天中交办任务，或创建一个持续目标，执行进展会显示在这里。" actionLabel="新建持续目标" onAction={onCreateGoal} />}
    <div className="ba-task-list">{visibleRows?.map(row => {
      const { result, delivery, status, safetyWait } = ticketSnapshot(row);
      const waiting = ticketWaiting(row);
      const stateLabel = safetyWait ? '待核实外部效果' : states[status] || status;
      const recovery = continuationRecovery(row);
      const recover = () => recovery?.goalBudget ? onOpenGoals?.() : lifecycle(row, 'ticketResume', recovery?.input);
      const title = normalizeTicketTitle(row.taskMeta?.title || row.title, row.target);
      const updatedLabel = row.updatedAt ? new Date(row.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      const actions = [];
      if (!terminalStates.includes(row.status)) {
        if (recovery) actions.push({ icon: recovery.goalBudget ? 'settings' : 'play', label: recovery.label, onClick: recover, disabled: busy !== null || (recovery.goalBudget && !onOpenGoals) });
        else if (row.status === 'paused' && !safetyWait) actions.push(row.pauseReason?.kind === 'budget'
          ? { icon: 'settings', label: '管理持续目标额度', onClick: onOpenGoals, disabled: busy !== null || !onOpenGoals }
          : { icon: 'play', label: '继续工单', onClick: () => lifecycle(row, 'ticketResume'), disabled: busy !== null });
        else if (!['pausing', 'cancelling', 'uncertain', 'blocked'].includes(status)) actions.push({ icon: 'pause', label: '暂停工单', onClick: () => lifecycle(row, 'ticketPause'), disabled: busy !== null });
        actions.push({ icon: 'stop', label: '停止工单', onClick: () => stop(row), disabled: busy !== null });
      } else actions.push({ icon: 'refresh', label: '重开工单', onClick: () => { setChangeId(row.id); setSelectedId(row.id); }, disabled: busy !== null });
      return <React.Fragment key={row.id}><TaskListRow api={api} kind="ticket" row={row} title={title} summary={<><span className="ba-task-state" data-state={status}>{stateLabel}</span><span className="ba-task-summary">{result?.delivery?.text || result?.review?.reason || result?.summary || row.acceptance || (row.mandate?.source?.channel === 'feishu' ? '来自飞书' : '来自桌面')}</span>{updatedLabel && <time className="ba-task-updated" dateTime={row.updatedAt}>更新 {updatedLabel}</time>}</>} completed={row.status === 'completed'} completionLocked={row.status === 'completed' && !row.taskMeta?.completed} onChanged={() => setGeneration(value => value + 1)} onOpen={() => { setChangeId(null); setSelectedId(row.id); }} actions={actions} onDirtyChange={dirtyEditor(`rename:${row.id}`)} />
      {selectedId === row.id && <TaskDetail open title={title} dirty={detailDirty} onClose={() => { setSelectedId(null); setChangeId(null); }}><header><span className="ba-goal-status">{stateLabel}</span></header>
        <section className="ba-task-instructions"><h3>任务要求</h3><p>{row.target}</p>{row.acceptance && <><h3>验收条件</h3><p>{row.acceptance}</p></>}</section>
        {error && <p role="alert">{error}</p>}
        <TicketWaiting key={`${row.id}:${row.instructionRevision}:${row.resultVersion}`} api={api} ticket={row} onRefresh={() => setGeneration(value => value + 1)} onOpenResources={resource => resource === 'goals' ? onOpenGoals?.() : setChangeId(row.id)} canOpenGoals={!!onOpenGoals} showQuestion={false} />
        <p className="ba-note">{row.mandate?.source?.channel === 'feishu' ? '飞书' : '桌面'} · {delivery ? deliveryStates[delivery.state] || delivery.state : '尚无交付结果'}</p>
        {!safetyWait && status !== 'uncertain' && <section className="ba-stack" aria-label="待处理交互">{row.attentions?.map(attention => <TicketAttention key={`${attention.id}:${row.instructionRevision}`} api={api} ticket={row} attention={attention} onAnswered={() => setGeneration(value => value + 1)} />)}</section>}
        {result && <Disclosure title={<>查看结果与证据 · 要求版本 {result.instructionRevision ?? 1}</>}>{(result.instructionRevision ?? 1) !== row.instructionRevision && <p className="ba-note">这是旧要求的结果，当前版本尚待执行与验收。</p>}<p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{result.summary}</p>{result.review && <p>验收：{result.review.reason}</p>}<ul>{result.evidenceRefs?.map((ref, index) => <li key={index}>会话：{ref.sessionId || '—'}{ref.runId ? ` · 执行：${ref.runId}` : ''}</li>)}</ul></Disclosure>}
        {delivery?.lastError && <p role="status" className="ba-note">{delivery.lastError}</p>}
        <section className="ba-stack" aria-label="工单操作"><TicketChange api={api} ticket={row} reload={async () => setGeneration(value => value + 1)} onDirtyChange={detailChanged} startOpen={changeId === row.id} />
        <TicketCheckpoints ticket={row} list={async input => (await api('checkpointList', input)).checkpoints} preview={input => api('checkpointPreview', input)} restore={input => api('checkpointRestore', input)} reload={async () => setGeneration(value => value + 1)} /></section>
        {!terminalStates.includes(row.status) && !waiting && <footer><div className="ba-row-actions"><TaskIconButton icon="stop" label="停止工单" disabled={busy === row.id} onClick={() => stop(row)} /></div></footer>}
      </TaskDetail>}</React.Fragment>;
    })}</div>
  </section>;
}
