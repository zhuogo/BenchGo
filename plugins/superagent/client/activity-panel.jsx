import { TaskDetail, TaskStatusGlyph as StatusGlyph, TaskStatusTitle } from './task-list.jsx';
import { TicketWaiting } from './ticket-waiting.jsx';
import { TaskExecution } from './task-execution.jsx';
import { ticketWaiting } from './ticket-state.mjs';
import taskCss from './task-list.css';
import { Button } from '../../shared/client/ui/button.jsx';
import React, { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { IconPanelLeftOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { Tooltip } from '../../shared/client/ui/tooltip.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import { PetAvatar } from '../../shared/client/pet-avatar.jsx';
import { SegmentedControl } from '../../shared/client/segmented-control.jsx';
import { ResourceState } from './resource-state.jsx';
import { petImageUrl } from './pet-state.mjs';
import { assistantConfigSync } from './config-sync.mjs';
import css from './activity-panel.css';
import { activityLabels as labels, terminalActivityStates as terminal, liveActivityStates, activeActivityStates, attentionActivityStates } from './activity-data.mjs';
import { useAssistantActivity } from './use-activity.jsx';
import { normalizeTicketTitle } from '../src/ticket-title.mjs';

const executionPhases = { preparing: '准备执行', executing: '正在执行', verifying: '正在保存结果' };
const detailPhase = row => row.execution?.observed !== false && ['running', 'active', 'resuming'].includes(row.status) && executionPhases[row.execution?.phase]
  ? executionPhases[row.execution.phase] : `${labels[row.status] || row.status} · ${row.phase}`;

const taskTitle = row => row?.kind === 'ticket' ? normalizeTicketTitle(row.taskMeta?.title || row.title, row.target) : row?.taskMeta?.title || row?.title || '任务详情';

const dateValue = value => { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date : null; };
const stamp = value => dateValue(value)?.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) || '时间未知';
const timeShort = value => {
  const date = dateValue(value); if (!date) return '';
  const today = new Date();
  const hm = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return date.toDateString() === today.toDateString() ? hm : `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
};
function day(value) {
  const date = dateValue(value); if (!date) return '时间未知';
  const today = new Date(), yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return '今天';
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return date.toLocaleDateString('zh-CN');
}
const TabIcon = ({ path, size = 17 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path}</svg>;
const tabIcons = {
  tasks: <TabIcon path={<><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></>} />,
  review: <TabIcon path={<><path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7l8-4Z" /><path d="m8.5 12 2.3 2.3 4.7-4.7" /></>} />,
  identity: <TabIcon path={<><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" /><circle cx="12" cy="12" r="3.2" /></>} />,
};
function BoardPet({ identity, size = 56 }) {
  return <PetAvatar pet={identity?.pet} src={petImageUrl(identity?.pet, document.baseURI)} size={size} motion={false} alt={identity?.name ? `${identity.name}的宠物形象` : '未命名助手的宠物形象'} />;
}
function BoardEmpty({ identity, onReturn }) {
  return <div className="ba-board-empty" role="status">
    <BoardPet identity={identity} size={88} />
    <strong>下一件事，一起完成</strong>
    <p>在聊天里交代一件事，进度和结果会留在这里。</p>
    <Button variant="outline" onClick={onReturn}>回到聊天<UIIcon name="chevronLeft" className="ba-board-arrow" size={14} /></Button>
  </div>;
}
function BoardRow({ row, onOpen }) {
  const title = taskTitle(row);
  const children = row.execution?.children || [];
  const childCounts = row.execution?.childCounts || { total: children.length, completed: children.filter(child => child.status === 'completed').length, failed: children.filter(child => child.status === 'failed').length };
  const hasChildren = childCounts.total > 0;
  const summary = hasChildren && row.progressSummary && row.execution?.phase !== 'verifying'
    ? row.execution.worker?.activity || row.phase : row.progressSummary || row.detail || row.phase;
  const childLabel = `${childCounts.total} 个子任务，${childCounts.completed || 0} 个已返回父 Worker${childCounts.failed ? `，${childCounts.failed} 个失败` : ''}`;
  return <article className="ba-activity-task ba-board-row" data-task-key={row.key}>
    <button type="button" className="ba-board-task-open" aria-label={title} aria-haspopup="dialog" onClick={() => onOpen(row.key)}>
      <span className="ba-board-iconbox" data-status={row.status} aria-hidden="true"><StatusGlyph status={row.status} /></span>
      <span className="ba-board-task-content">
        <span className="ba-board-task-heading"><Tooltip label={title}><strong>{title}</strong></Tooltip><Tooltip label={stamp(row.time)}><time dateTime={dateValue(row.time)?.toISOString()}>{timeShort(row.time) || '时间未知'}</time></Tooltip></span>
        <span className="ba-board-task-meta"><span className="ba-board-chip" data-status={row.status}>{labels[row.status] || row.status || '状态未知'}</span><Tooltip label={summary}><span className="ba-board-summary">{summary}</span></Tooltip>{hasChildren && <Tooltip label={childLabel}><span className="ba-board-children-count" data-failed={childCounts.failed > 0 || undefined} aria-label={childLabel}>子任务 {childCounts.completed || 0}/{childCounts.total}</span></Tooltip>}</span>
      </span>
    </button>
  </article>;
}
const ActivityContext = createContext(null);
const emptyStatuses = new Map();
const emptySubscription = () => () => {};
function useSessionReviews(ctx, threads) {
  const source = ctx?.uiSession?.sessionStatus;
  const statuses = useSyncExternalStore(source ? listener => source.subscribe(listener) : emptySubscription, source ? () => source.getSnapshot() : () => emptyStatuses);
  const seen = new Set();
  return (threads || []).flatMap(thread => {
    if (!thread.sessionId || seen.has(thread.sessionId)) return [];
    seen.add(thread.sessionId);
    const pending = statuses.get(thread.sessionId)?.pendingInteraction;
    return pending ? [{ thread, pending }] : [];
  });
}
export function ActivityProvider({ children }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef(null), id = useId();
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return <ActivityContext.Provider value={{ open, setOpen, trigger, id, close }}><style>{css}</style>{children}</ActivityContext.Provider>;
}
export function ActivityTrigger({ api }) {
  const { open, setOpen, trigger, id } = useContext(ActivityContext);
  const { rows } = useAssistantActivity(api);
  const count = rows?.filter(row => liveActivityStates(row.status)).length || 0;
  const label = open ? '收起看板' : '展开看板';
  return <Tooltip label={label} side="bottom" delayMs={450} portal><Button variant="ghost" ref={trigger} type="button" className="ba-activity-trigger" aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><IconPanelLeftOutlineRegular className="ba-activity-panel-icon" size={15} />{count > 0 && <span className="ba-activity-count" aria-hidden="true">{count}</span>}</Button></Tooltip>;
}
export function ActivityPanel({ api, assistantConfig, onOpenResources, ctx, reviewThreads, onOpenReview }) {
  const { open, id, close } = useContext(ActivityContext);
  const [stopping, setStopping] = useState(null), [actionError, setActionError] = useState(null), [selectedKey, setSelectedKey] = useState(null);
  const [tab, setTab] = useState('tasks'), [fetchedIdentity, setIdentity] = useState(null), [activeOpen, setActiveOpen] = useState(true);
  const [identityError, setIdentityError] = useState(''), [identityLoading, setIdentityLoading] = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const syncedIdentity = useSyncExternalStore(assistantConfigSync.subscribe, assistantConfigSync.getSnapshot);
  const identity = syncedIdentity || fetchedIdentity || assistantConfig;
  const { rows, error, refresh } = useAssistantActivity(api, { live: open });
  const sessionReviews = useSessionReviews(ctx, reviewThreads);
  const panel = useRef(null);
  const previous = useRef(null);
  const identityRequest = useRef(null);
  useEffect(() => { if (assistantConfig) setIdentity(assistantConfig); }, [assistantConfig]);
  const refreshIdentity = useCallback(async () => {
    identityRequest.current?.abort();
    const controller = new AbortController(); identityRequest.current = controller;
    setIdentityLoading(true);
    try {
      const value = await api('state', {}, controller.signal);
      if (!controller.signal.aborted) { setIdentity(value.config || {}); setIdentityError(''); }
    } catch (cause) {
      if (!controller.signal.aborted) setIdentityError(cause.message || '身份信息读取失败');
    } finally {
      if (!controller.signal.aborted) setIdentityLoading(false);
    }
  }, [api]);
  useEffect(() => {
    if (!open) return;
    void refreshIdentity();
    return () => identityRequest.current?.abort();
  }, [open, refreshIdentity]);
  const refreshAll = async () => {
    if (manualRefreshing) return;
    setManualRefreshing(true);
    try { await Promise.all([refresh(), refreshIdentity()]); }
    finally { setManualRefreshing(false); }
  };
  const openResource = (resource, selection) => { setSelectedKey(null); close(); onOpenResources?.(resource, selection); };
  useLayoutEffect(() => {
    const body = panel.current?.querySelector('.ba-activity-body');
    if (!body) return;
    const before = previous.current;
    const elements = [...body.querySelectorAll('[data-task-key]')];
    const top = body.getBoundingClientRect().top;
    const positions = new Map(elements.map(element => [element.dataset.taskKey, element.getBoundingClientRect().top - top + body.scrollTop]));
    const keys = rows === null ? null : new Set(rows.map(row => row.key));
    previous.current = { open, tab, keys, positions };
    if (!open || !before?.open || !before.keys || before.tab !== tab || document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const inserted = elements.filter(element => !before.keys.has(element.dataset.taskKey));
    if (!inserted.length) return;
    const animations = [];
    for (const element of elements) {
      if (!element.animate) continue;
      const key = element.dataset.taskKey;
      const delta = before.positions.has(key) ? before.positions.get(key) - positions.get(key) : 0;
      const frames = !before.keys.has(key)
        ? [{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'translateY(0)' }]
        : delta ? [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }] : null;
      if (frames) animations.push(element.animate(frames, { duration: 240, easing: 'cubic-bezier(.2,.7,.2,1)' }));
    }
    return () => animations.forEach(animation => animation.cancel());
  }, [rows, open, tab]);
  useEffect(() => { if (open) panel.current?.focus(); }, [open ]);
  const stop = async row => {
    if (stopping !== null) return;
    setStopping(row.key); setActionError(null);
    try { await api(row.kind === 'goal' ? 'goalCancel' : 'ticketStop', row.kind === 'goal' ? { id: row.id, rowVersion: row.rowVersion } : { ticketId: row.id }); await refresh(); }
    catch (cause) { setActionError({ message: cause.message || '任务未能停止，请重试。', row }); } finally { setStopping(null); }
  };
  const selected = rows?.find(row => row.key === selectedKey);
  const selectedWaiting = selected?.kind === 'ticket' ? ticketWaiting(selected) : null;
  const sorted = (rows || []).slice().sort((a, b) => (dateValue(b.time)?.getTime() || 0) - (dateValue(a.time)?.getTime() || 0));
  const active = sorted.filter(row => activeActivityStates(row.status));
  const review = sorted.filter(row => row.kind === 'ticket' && !!ticketWaiting(row)?.attention);
  const reviewKeys = new Set(review.map(row => row.key));
  const attention = sorted.filter(row => attentionActivityStates.has(row.status) && !reviewKeys.has(row.key));
  const rest = sorted.filter(row => !activeActivityStates(row.status) && !attentionActivityStates.has(row.status) && !reviewKeys.has(row.key));
  const groups = new Map(); for (const row of rest) { const key = day(row.time); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
  const name = identity?.name || '未命名';
  const modelEntry = identity?.models?.[0];
  const modelLabel = typeof modelEntry === 'string' ? modelEntry : modelEntry?.modelId || modelEntry?.id || modelEntry?.name || '';
  const renderRow = row => <BoardRow key={row.key} row={row} onOpen={setSelectedKey} />;
  const onKeyDown = event => {
    if (selected) return;
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
    if (event.key === 'Tab' && window.matchMedia('(max-width: 1000px)').matches) {
      const buttons = [...panel.current.querySelectorAll('button:not(:disabled), a[href], summary, [tabindex="0"]')].filter(element => element.tabIndex >= 0 && element.getClientRects().length);
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  const tabs = [['tasks', '任务', active.length], ['review', '审核', review.length + sessionReviews.length], ['identity', '身份', 0]].map(([value, label, count]) => ({ value, icon: tabIcons[value], label: <>{label}{count > 0 && <span className="ba-board-tab-count">{count}</span>}</> }));
  const loadingState = <ResourceState kind="loading" title="正在读取任务" description="正在同步进度与结果，请稍候。" />;
  return <><div className="ba-activity-backdrop" data-open={open} onClick={close} aria-hidden="true" />
    <div className="ba-activity-seat" data-open={open} aria-hidden={!open || undefined} inert={!open ? '' : undefined}>
    <aside id={id} ref={panel} tabIndex={-1} className="ba-activity-panel ba-board" aria-label="助手看板" onKeyDown={onKeyDown}>
      <header className="ba-board-head"><div className="ba-board-heading"><span>助手看板</span><Tooltip label="收起看板" side="bottom" delayMs={450} portal><Button variant="ghost" className="ba-icon" aria-label="收起看板" onClick={close}><UIIcon name="close" size={16} /></Button></Tooltip></div>
      </header>
      <nav className="ba-board-tabs" aria-label="看板分页"><SegmentedControl options={tabs} value={tab} onChange={setTab} label="看板分页" panelId={`${id}-content`} tabIdPrefix={`${id}-tab`} /></nav>
      <div id={`${id}-content`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} tabIndex={0} className="ba-activity-body ba-board-body">
        {actionError && <ResourceState kind="error" title="未能停止任务" description={actionError.message} onAction={() => stop(actionError.row)} />}
        {error && tab !== 'identity' && <ResourceState kind="error" title="暂时无法更新任务" description={rows !== null ? '已保留上次的任务记录，请重试。' : '任务记录暂时无法读取，请检查连接后重试。'} onAction={refresh} />}
        {tab === 'tasks' && <>{rows === null && !error && loadingState}
          {attention.length > 0 && <section className="ba-board-section"><h3 className="ba-board-day">待处理<span>{attention.length}</span></h3>{attention.map(renderRow)}</section>}
          {rows !== null && active.length > 0 && <section className="ba-board-section"><button type="button" className="ba-board-section-head" aria-expanded={activeOpen} aria-controls={`${id}-active`} onClick={() => setActiveOpen(value => !value)}><span>进行中</span><span className="ba-board-section-count">{active.length}</span><UIIcon name="chevronDown" size={13} /></button><div id={`${id}-active`} hidden={!activeOpen}>{active.map(renderRow)}</div></section>}
          {rows !== null && [...groups].map(([label, items]) => <section className="ba-activity-day ba-board-section" key={label}><h3 className="ba-board-day">{label}<span>{items.length}</span></h3>{items.map(renderRow)}</section>)}
          {rows !== null && sorted.length === review.length && !error && <BoardEmpty identity={identity} onReturn={close} />}</>}
        {tab === 'review' && <section className="ba-board-section ba-board-review" aria-label="待审核事项">
          {rows === null && !error && loadingState}
          {sessionReviews.map(({ thread, pending }) => <section key={pending.key || thread.sessionId} className="ba-board-session-review" aria-label="会话待审核">
            <strong>{thread.id === 'main' ? '主聊天' : thread.title || '旁聊'}</strong>
            <span>{pending.kind === 'approval' ? '需要授权' : ['question', 'plan-review'].includes(pending.kind) ? '需要回答' : '等待处理'}</span>
            <p>{pending.reason || pending.displayReason?.zh || pending.displayReason?.en || pending.questions?.[0]?.question || pending.toolName || '请在原会话中查看并处理。'}</p>
            <Button variant="outline" disabled={!onOpenReview} onClick={() => { close(); onOpenReview?.(thread); }}>前往会话审核</Button>
          </section>)}
          {review.map(renderRow)}
          {rows !== null && !review.length && !sessionReviews.length && <ResourceState icon="check" title="暂无待审核事项" description="需要你授权或补充回答时，会显示在这里。" />}
        </section>}
        {tab === 'identity' && <section className="ba-board-section ba-board-profile">
          {identityError && <ResourceState kind="error" title="暂时无法更新身份" description={identity ? '当前显示上次的身份信息，请重试。' : '身份信息暂时无法读取，请重试。'} onAction={refreshAll} />}
          {!identity && !identityError && <ResourceState kind="loading" title="正在读取身份" description="正在同步助手形象与配置。" />}
          {identity && <><div className="ba-board-companion"><BoardPet identity={identity} size={32} /><div className="ba-board-identity"><Tooltip label={name}><strong>{name}</strong></Tooltip></div></div>{modelLabel && <p className="ba-board-model-id"><span>模型</span><span>{modelLabel}</span></p>}</>}
          <div className="ba-board-links">
            {[['models', '模型配置', 'atom'], ['memory', '记忆与档案', 'archive']].map(([key, title, icon]) => <Button variant="ghost" key={key} onClick={() => openResource(key)}><UIIcon name={icon} size={17} /><strong>{title}</strong><UIIcon name="chevronLeft" className="ba-board-arrow" size={15} /></Button>)}
          </div></section>}
      </div><footer className="ba-board-footer"><Button variant="ghost" className="ba-board-manage" onClick={() => openResource('tasks')}><UIIcon name="schedules" size={16} />任务管理</Button><Tooltip label="刷新看板" side="top" delayMs={450} portal><Button variant="ghost" className="ba-icon ba-board-refresh" aria-label="刷新看板" aria-busy={manualRefreshing || undefined} disabled={manualRefreshing} onClick={refreshAll}><UIIcon name="refresh" size={16} /></Button></Tooltip></footer>
    </aside></div><style>{taskCss}</style>
    <TaskDetail open={!!selected && open} title={selected && <TaskStatusTitle title={taskTitle(selected)} status={selected.status} label={selected.kind === 'ticket' ? labels[selected.status] : detailPhase(selected)} />} onClose={() => setSelectedKey(null)} footer={selected && <div className="ba-activity-detail-actions"><Button variant="ghost" onClick={() => openResource('tasks', selected.kind === 'ticket' ? { ticketId: selected.id } : undefined)}>前往任务管理</Button>{!terminal.has(selected.status) && !selectedWaiting && <Button variant="outline" disabled={stopping !== null} onClick={() => stop(selected)}>{stopping === selected.key ? '正在停止…' : '停止任务'}</Button>}</div>}>{selected && <>
      {actionError?.row.key === selected.key && <ResourceState kind="error" title="未能停止任务" description={actionError.message} onAction={() => stop(selected)} />}
      {selected.kind === 'ticket' && <TicketWaiting key={`${selected.id}:${selected.instructionRevision}:${selected.resultVersion}`} api={api} ticket={selected} onRefresh={refresh} onOpenResources={openResource} />}
      {selected.detail && selected.detail !== selectedWaiting?.reason && <section className="ba-activity-detail"><h3>{selected.status === 'completed' ? '结果摘要' : '当前进展'}</h3><p>{selected.detail}</p></section>}
      {selected.kind === 'ticket' && <TaskExecution key={selected.key} execution={selected.execution} ticketStatus={selected.status} stale={!!error} />}
      {!selectedWaiting && !selected.detail && !selected.execution?.worker && !selected.execution?.children?.length && <p className="ba-activity-detail-note">{selected.phase}</p>}
    </>}</TaskDetail></>;
}
