import { Loading } from '../../shared/client/ui/loading.jsx';
import { useConfirmation } from '../../shared/client/ui/confirmation.jsx';
import { Disclosure } from '../../shared/client/ui/collapsible.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import { ModelSettings } from './model-settings.jsx';
import { retainAssistantSession, assistantBackgroundSessions } from './session-retain.mjs';
import { identityConfigPatch, validateModelSettings } from './model-settings.mjs';
import React, { useCallback, useEffect, useRef, useState, useId, useSyncExternalStore } from 'react';
import { Tooltip, Modal, Menu, IconPinOutlineMedium, IconPinFillMedium, IconArchiveOutlineMedium, IconArchiveOffOutlineMedium, IconEllipsisOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives';
import { UIIcon as BaseIcon } from '../../benchgo/client/iconsax.jsx';
import { BrandLogo } from '../../link/client/brand.jsx';
import { readJsonResponse } from '../../benchgo/client/http-response.mjs';
import { perfTrace } from '../../shared/client/perf-trace.mjs';
import { structuralShare } from './structural-share.mjs';
import { assistantModelCatalog } from '../../benchgo/client/model-catalog.mjs';
import css from './style.css';
import documentsCss from './documents.css';
import { AssistantCard } from './card.jsx';
import { PetSettings } from './pet-settings.jsx';
import { petDesignIntent, petActionForSession, petExpressionForAction } from './pet-state.mjs';
import { IdentityCardEditor } from './identity-card-editor.jsx';
import { assistantConfigSync, saveConfigPatch } from './config-sync.mjs';
import { AssistantConversation, assistantConversationChildren, mountAssistantConversation } from './conversation.jsx';
import { mountSessionRoleControls } from './session-role-controls.jsx';
import { ApprovalReview, reviewApprovalChildren, mountApprovalReview } from './approval-review.jsx';
import { AssistantDocuments } from './documents.jsx';
import { Artifacts } from './artifacts.jsx';
import { SystemFiles } from './system-files.jsx';
import { ResourceIcon } from '../../shared/client/resource-icon.jsx';
import { CustomSelect } from '../../shared/client/custom-select.jsx';
import { SegmentedControl } from '../../shared/client/segmented-control.jsx';
import { ChannelBrandIcon } from '../../shared/client/channel-brand-icon.jsx';
import { sidebarListStorageKey, readSidebarList, channelIsConnected, isFixedChannelThread, sidebarThreads, channelThreadTitle, createSidebarThreadTimeFormatter } from './sidebar-lists.mjs';
import { MemoryPage } from './memory.jsx';
import { Goals } from './goals.jsx';
import { Tickets } from './tickets.jsx';
import { ExecutionSessionPanel, openExecutionSession } from './execution-session.jsx';
import { executionSessionNavigation, registerExecutionSessionDiscovery } from './execution-session-navigation.mjs';
import { registerChannelMessages } from './channel-session.jsx';
import { ActivityPanel, ActivityProvider } from './activity-panel.jsx';
import { mountAssistantActivity } from './activity-remote.jsx';
import { useDirtyRegistry } from './dirty-registry.mjs';
import { Connections } from './connections.jsx';
import { VaultSettingsSection } from '../../shared/client/vault-settings.jsx';
import { ResourceState } from './resource-state.jsx';
import { NotificationSoundSettings } from './notification-sound.jsx';
import { mountReplySound } from './notification-sound-runtime.mjs';

const PANEL = 'benchgo-assistant';
const documentTabs = { soul: 'SOUL.md', 'identity-document': 'IDENTITY.md' };
const SIDEBAR_EXPANDED_KEY = 'benchgo.assistant.sidebarExpanded';
function readAssistantSidebarExpanded() {
  try { return localStorage.getItem(SIDEBAR_EXPANDED_KEY) === 'true'; } catch { return false; }
}
const DEFAULT_NAME = '未命名';
let selectedAssistantThread = 'main';
let selectedAssistantTab = 'chat';
let selectedAssistantTicket = null;
let initialPanelSelected = false;
function dispatchAssistantEvent(name, detail) {
  const event = () => document.dispatchEvent(new CustomEvent(name, { detail }));
  event();
  queueMicrotask(event);
  setTimeout(event, 0);
}
function openAssistantThread(ctx, threadId) {
  executionSessionNavigation.close();
  selectedAssistantThread = threadId || 'main';
  selectedAssistantTab = 'chat';
  selectedAssistantTicket = null;
  ctx.layout.selectPanel(PANEL);
  dispatchAssistantEvent('benchgo:assistant-thread', selectedAssistantThread);
}
function openAssistantTab(ctx, tab, selection) {
  executionSessionNavigation.close();
  selectedAssistantTab = tab;
  selectedAssistantTicket = tab === 'tasks' && typeof selection?.ticketId === 'string' ? { ticketId: selection.ticketId } : null;
  ctx.layout.selectPanel(PANEL);
  dispatchAssistantEvent('benchgo:assistant-tab', tab);
}
export function AssistantSidebarEntry({ ctx, showArchived = false }) {
  const config = useSyncExternalStore(assistantConfigSync.subscribe, assistantConfigSync.getSnapshot);
  const name = config?.name || DEFAULT_NAME;
  const [threads, setThreads] = useState([]), [expanded, setExpanded] = useState(true), [selected, setSelected] = useState(selectedAssistantThread), [error, setError] = useState(''), [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState(null), [renameTarget, setRenameTarget] = useState(null), [saving, setSaving] = useState(false);
  useEffect(() => { setMenu(null); }, [showArchived]);
  const [mainSessionId, setMainSessionId] = useState(null);
  const [loaded, setLoaded] = useState(false), [loadError, setLoadError] = useState(''), [refreshing, setRefreshing] = useState(false);
  const [assistantExpanded, setAssistantExpanded] = useState(readAssistantSidebarExpanded), [selectedTab, setSelectedTab] = useState(selectedAssistantTab);
  const assistantBodyId = useId(), sidebarTabsId = useId(), sidebarBodyId = useId();
  const [sidebarList, setSidebarList] = useState(() => readSidebarList(typeof localStorage === 'undefined' ? null : localStorage));
  const [channels, setChannels] = useState([]), [channelsLoaded, setChannelsLoaded] = useState(false), [channelsError, setChannelsError] = useState('');
  const imList = !showArchived && sidebarList === 'im';
  const listLabel = imList ? 'IM 会话' : '旁聊';
  const selectList = value => {
    setSidebarList(value); setExpanded(true); setMenu(null); setError('');
    try { localStorage.setItem(sidebarListStorageKey, value); } catch { /* Storage may be unavailable. */ }
  };
  const toggleAssistant = () => {
    const next = !assistantExpanded;
    setAssistantExpanded(next); setMenu(null);
    try { localStorage.setItem(SIDEBAR_EXPANDED_KEY, String(next)); } catch { /* Embedded sessions may not provide storage. */ }
  };
  const statusSource = ctx.uiSession?.sessionStatus;
  const statuses = useSyncExternalStore(listener => statusSource?.subscribe(listener) || (() => {}), () => statusSource?.getSnapshot() || EMPTY_STATUSES);
  const sessionSource = ctx.sessions?.list;
  const sessions = useSyncExternalStore(listener => sessionSource?.subscribe(listener) || (() => {}), () => sessionSource?.getSnapshot() || EMPTY_SESSIONS);
  const mainSession = statuses.get(mainSessionId);
  const mainAction = petActionForSession({ ...mainSession, running: mainSession?.running ?? sessions.byId[mainSessionId]?.running });
  const mainStatus = mainSession?.openState === 'error' ? 'error' : mainAction === 'waiting' ? 'waiting' : mainAction === 'focus' ? 'running' : 'idle';
  const mainLabel = { idle: '打开主聊天', running: '打开主聊天，正在进行中', waiting: '打开主聊天，等待你的确认', error: '打开主聊天，会话连接异常' }[mainStatus];
  const menuAnchor = useRef(null);
  const refreshRef = useRef(null), selectionRef = useRef(selected);
  selectionRef.current = selected;
  const panel = useSyncExternalStore(fn => ctx.layout.panelInfo.subscribe(fn), () => ctx.layout.panelInfo.getSnapshot());
  useEffect(() => {
    const controller = new AbortController();
    let latest = 0, pending, queued = false, queuedManual = false, changeTimer;
    const refresh = (force = false) => {
      if (controller.signal.aborted || (document.hidden && force !== true)) return;
      if (force === true) { setLoadError(''); setChannelsError(''); setRefreshing(true); }
      if (pending) { queued = true; queuedManual ||= force === true; return pending; }
      const request = ++latest;
      pending = (async () => {
        try {
          const [stateResult, catalogResult] = await Promise.allSettled([api('state', {}, controller.signal), ...(imList ? [api('connectionCatalog', {}, controller.signal)] : [])]);
          if (controller.signal.aborted || request !== latest) return;
          if (imList) {
            if (catalogResult.status === 'fulfilled') { setChannels(previous => structuralShare(previous, catalogResult.value.channels || [])); setChannelsLoaded(true); setChannelsError(''); }
            else setChannelsError(catalogResult.reason.message || '渠道连接状态暂时不可用');
          }
          if (stateResult.status === 'rejected') throw stateResult.reason;
          const value = stateResult.value;
          if (!controller.signal.aborted && request === latest) {
            setThreads(previous => structuralShare(previous, value.state.threads || [])); setMainSessionId(value.state.mainSessionId || null); setLoaded(true); setLoadError('');
          }
        } catch (cause) {
          if (!controller.signal.aborted && request === latest) setLoadError(cause.message || '连接暂时不可用');
        } finally {
          if (!controller.signal.aborted && request === latest) setRefreshing(false);
          pending = null;
          if (queued && !controller.signal.aborted) { const manual = queuedManual; queued = queuedManual = false; await refresh(manual); }
        }
      })();
      return pending;
    };
    const changed = () => { if (changeTimer) return; changeTimer = setTimeout(() => { changeTimer = null; void refresh(); }, 80); };
    refreshRef.current = refresh;
    const selectedThread = event => { setSelected(event.detail); setSelectedTab('chat'); };
    const selectedTabChanged = event => setSelectedTab(event.detail);
    refresh(); const timer = setInterval(refresh, 30000);
    document.addEventListener('benchgo:assistant-thread', selectedThread);
    document.addEventListener('benchgo:assistant-tab', selectedTabChanged);
    const clearArchived = () => { if (!showArchived) return; setSaving(true); setError(''); api('deleteArchivedThreads').then(() => { if (selectionRef.current !== 'main') openAssistantThread(ctx, 'main'); refresh(); }).catch(cause => setError(cause.message)).finally(() => setSaving(false)); };
    document.addEventListener('benchgo:assistant-changed', changed);
    document.addEventListener('benchgo:clear-archived-threads', clearArchived);
    return () => { controller.abort(); refreshRef.current = null; clearInterval(timer); clearTimeout(changeTimer); document.removeEventListener('benchgo:assistant-thread', selectedThread); document.removeEventListener('benchgo:assistant-tab', selectedTabChanged); document.removeEventListener('benchgo:assistant-changed', changed); document.removeEventListener('benchgo:clear-archived-threads', clearArchived); document.dispatchEvent(new CustomEvent('benchgo:archived-thread-count', { detail: 0 })); };
  }, [showArchived, imList]);
  const createThread = async () => {
    if (creating) return;
    setCreating(true); setError('');
    try {
      const thread = await api('createThread', { title: '新旁聊' });
      const id = thread.thread?.id || thread.id;
      setExpanded(true); openAssistantThread(ctx, id); document.dispatchEvent(new Event('benchgo:assistant-changed'));
    } catch (cause) { setError(cause.message); }
    finally { setCreating(false); }
  };
  const mutate = async operation => { setSaving(true); try { await operation(); document.dispatchEvent(new Event('benchgo:assistant-changed')); setMenu(null); } catch (cause) { setError(cause.message); } finally { setSaving(false); } };
  const visible = sidebarThreads(threads, { list: imList ? 'im' : 'side', archived: showArchived, channels });
  const listError = loadError || (imList && channelsError), listLoading = !loaded || imList && !channelsLoaded;
  const hasConnectedChannels = channels.some(channel => channelIsConnected(channel.status));
  useEffect(() => { document.dispatchEvent(new CustomEvent('benchgo:archived-thread-count', { detail: sidebarThreads(threads, { archived: true }).length })); }, [threads]);
  const current = visible.find(thread => thread.id === menu) || null;
  const formatTime = createSidebarThreadTimeFormatter();
  const row = thread => {
    const fixedSource = isFixedChannelThread(thread);
    const channel = fixedSource && channels.find(item => item.id === thread.source.channel);
    const sourceLabel = fixedSource ? `${channel?.label || thread.source.channel} · ${{ direct: '私聊', group: '群聊', topic: '话题' }[thread.source.sourceType]} · ${thread.source.topicId || thread.source.conversationId}` : undefined;
    const title = fixedSource ? channelThreadTitle(thread, channel) : thread.title;
    const active = panel.activePanelId === PANEL && selectedTab === 'chat' && selected === thread.id;
    const session = sessions.byId[thread.sessionId], status = statuses.get(thread.sessionId);
    const running = status?.running ?? session?.running;
    const state = thread.archived ? 'archived' : !thread.sessionId ? 'idle' : status?.pendingInteraction ? 'pending' : running === true ? 'running' : running === false || status?.completionUnread ? 'idle' : 'unknown';
    const stateLabel = { archived: '已归档', pending: '待确认', running: '忙碌', idle: '空闲', unknown: '状态未知' }[state];
    const updatedAt = session?.updatedAt || thread.createdAt;
    const { hasDate, timeLabel, dateTime, detail } = formatTime(updatedAt);
    const archive = () => void mutate(async () => { await api('archiveThread', { threadId: thread.id, archived: !showArchived }); if (!showArchived && selected === thread.id) openAssistantThread(ctx, 'main'); });
    return <div className={`cmd-session-row ${showArchived ? 'is-archived' : ''} ${active ? 'is-selected' : ''}`} data-source={fixedSource ? 'im' : 'side'} data-menu-open={menu === thread.id || undefined} key={thread.id}>
      <Button variant="ghost" type="button" className={`cmd-session ${active ? 'cmd-selected' : ''}`} title={fixedSource ? `${title}，${sourceLabel}` : undefined} aria-label={fixedSource ? `${title}，${sourceLabel}` : undefined} aria-current={active ? 'page' : undefined} onClick={() => { setMenu(null); openAssistantThread(ctx, thread.id); }}><span className="ba-thread-copy">{fixedSource && <ChannelBrandIcon channel={thread.source.channel} available size={14} />}<span className="ba-thread-title">{title}</span><span className="ba-thread-meta"><Hint label={hasDate ? `${session?.updatedAt ? '最近活动' : '创建于'} ${detail}` : '时间暂不可用'}><time className="ba-thread-time" dateTime={dateTime}>{timeLabel}</time></Hint>{!fixedSource && <span className="ba-thread-status" data-status={state}><i aria-hidden="true" />{stateLabel}</span>}</span></span></Button>
      {!fixedSource && <div className="ba-thread-actions">
        {!showArchived && <Hint label={thread.pinned ? '取消置顶' : '置顶'}><Button variant="ghost" type="button" className="cmd-session-quick" aria-label={thread.pinned ? '取消置顶' : '置顶会话'} aria-pressed={!!thread.pinned} disabled={saving} onClick={event => { event.stopPropagation(); void mutate(() => api('pinThread', { threadId: thread.id, pinned: !thread.pinned })); }}>{thread.pinned ? <IconPinFillMedium size={16} /> : <IconPinOutlineMedium size={16} />}</Button></Hint>}
        <Hint label={showArchived ? '取消归档' : '归档'}><Button variant="ghost" type="button" className="cmd-session-quick" aria-label={showArchived ? '取消归档对话' : '归档对话'} disabled={saving} onClick={event => { event.stopPropagation(); archive(); }}>{showArchived ? <IconArchiveOffOutlineMedium size={16} /> : <IconArchiveOutlineMedium size={16} />}</Button></Hint>
        {showArchived && <Hint label="删除"><Button variant="ghost" type="button" className="cmd-session-quick cmd-danger" aria-label="删除旁聊" disabled={saving} onClick={event => { event.stopPropagation(); void mutate(async () => { await api('deleteThread', { threadId: thread.id }); if (selected === thread.id) openAssistantThread(ctx, 'main'); }); }}><UIIcon name="trash" size={14} /></Button></Hint>}
        {!showArchived && <Hint label="对话操作"><Button variant="ghost" type="button" className="cmd-session-more" aria-label={'对话操作：' + thread.title} aria-expanded={menu === thread.id} aria-haspopup="menu" onClick={event => { menuAnchor.current = event.currentTarget; setMenu(menu === thread.id ? null : thread.id); }}><IconEllipsisOutlineMedium size={16} /></Button></Hint>}
      </div>}
    </div>;
  };
  return <section className="ba-assistant-section" data-collapsed={!showArchived && !assistantExpanded} aria-label={'\u4e2a\u4eba\u52a9\u7406'}>{!showArchived && <div className="ba-card-row"><div className="ba-assistant-heading"><Hint label={mainLabel}><span className="ba-sidebar-main"><AssistantCard avatarSize={32} pet={config?.pet} name={name} html={config?.cardHtml} motion={config?.cardMotion !== false} action={mainAction} expression={petExpressionForAction(config?.pet, mainAction)} status={mainStatus} ariaLabel={mainLabel} current={panel.activePanelId === PANEL && selected === 'main' && selectedTab === 'chat'} onOpen={() => { setMenu(null); openAssistantThread(ctx, 'main'); }} /></span></Hint><Hint label="资源"><Button variant="ghost" type="button" className="ba-assistant-resources" aria-label="打开资源" aria-current={panel.activePanelId === PANEL && selectedTab === 'resources' ? 'page' : undefined} onClick={() => { setMenu(null); openAssistantTab(ctx, 'resources'); }}><UIIcon name="cube" size={16} /></Button></Hint><Hint label={assistantExpanded ? '\u6536\u8d77\u52a9\u624b' : '\u5c55\u5f00\u52a9\u624b'}><Button variant="ghost" type="button" className="ba-assistant-toggle" aria-label={assistantExpanded ? '\u6536\u8d77\u52a9\u624b' : '\u5c55\u5f00\u52a9\u624b'} aria-expanded={assistantExpanded} aria-controls={assistantBodyId} onClick={toggleAssistant}><UIIcon name="chevronDown" size={16} /></Button></Hint></div></div>}<div id={assistantBodyId} className="ba-assistant-body" hidden={!showArchived && !assistantExpanded}><div className="cmd-section-title ba-sidebar-toolbar">{!showArchived && <div className="ba-sidebar-tabs"><SegmentedControl options={[{ value: 'side', label: '旁聊' }, { value: 'im', label: 'IM' }]} value={sidebarList} onChange={selectList} label="会话列表" tabIdPrefix={sidebarTabsId} panelId={sidebarTabsId + '-panel'} /></div>}{!showArchived && !imList && <Hint label="新旁聊"><Button variant="ghost" type="button" className="ba-section-add" aria-label="新建旁聊" disabled={creating} onClick={createThread}><UIIcon name="plus" size={16} /></Button></Hint>}<Button variant="ghost" type="button" className="cmd-section-toggle" aria-label={showArchived ? `${expanded ? '收起' : '展开'}已归档旁聊` : `${expanded ? '收起' : '展开'}${listLabel}`} aria-expanded={expanded} aria-controls={sidebarBodyId} onClick={() => { setExpanded(!expanded); setMenu(null); }}>{showArchived && <span>已归档旁聊</span>}<UIIcon name="chevronDown" size={14} /></Button></div><div id={sidebarTabsId + '-panel'} role={showArchived ? undefined : 'tabpanel'} aria-labelledby={showArchived ? undefined : `${sidebarTabsId}-${sidebarList}`}><div id={sidebarBodyId} className="cmd-section-body ba-sidebar-body" data-open={expanded} inert={!expanded ? '' : undefined}><div className="cmd-section-inner" aria-busy={(listLoading && !listError) || refreshing}>
      {visible.map(row)}
      {listLoading && !visible.length && !listError && <Loading label={`正在加载${listLabel}`} compact />}
      {!listLoading && !visible.length && !listError && !error && <div className="ba-sidebar-state" data-kind="empty">{showArchived ? <ResourceState icon="archive" title="暂无归档旁聊" description="归档后的旁聊会保留在这里。" /> : imList ? <ResourceState icon="devices" title={hasConnectedChannels ? '暂无 IM 会话' : '尚未连接渠道'} description={hasConnectedChannels ? '已连接渠道收到消息后，会显示在这里。' : '连接渠道后接收消息，即可在这里查看。'}><Button variant="ghost" type="button" onClick={() => openAssistantTab(ctx, 'connections')}>连接渠道</Button></ResourceState> : <p className="ba-sidebar-quote">“或许你不需要我”</p>}</div>}
      {(listError || error) && <div className="ba-sidebar-state" data-kind="error"><ResourceState kind="error" title={error ? '操作未完成' : listLoading ? `${listLabel}加载失败` : `${listLabel}暂时无法更新`} description={error || (imList && channelsError ? '无法核实渠道连接状态，请重试。已有会话会保留。' : '请检查连接后重试，已有对话会保留。')}><Button variant="ghost" type="button" disabled={refreshing} onClick={() => { setError(''); return refreshRef.current?.(true); }}><UIIcon name="refresh" size={14} />{refreshing ? '正在重试…' : error ? '重新加载' : '重试加载'}</Button></ResourceState></div>}
    </div></div></div></div><Menu open={!showArchived && assistantExpanded && !!current} onClose={() => { if (!saving) setMenu(null); }} anchor={null} anchorRef={menuAnchor} side="right" align="end" portal autoFocus compact listClassName="cmd-actions-popover">{current && <div className="cmd-session-actions">{!showArchived && <Button variant="ghost" type="button" role="menuitem" disabled={saving} onClick={() => void mutate(() => api('pinThread', { threadId: current.id, pinned: !current.pinned }))}>{current.pinned ? <IconPinFillMedium size={16} /> : <IconPinOutlineMedium size={16} />}<span>{current.pinned ? '取消置顶' : '置顶会话'}</span></Button>}<Button variant="ghost" type="button" role="menuitem" disabled={saving} onClick={() => { setRenameTarget(current); setMenu(null); }}><UIIcon name="edit" size={16} /><span>重命名</span></Button><div className="cmd-session-action-divider" role="separator" /><Button variant="ghost" type="button" role="menuitem" disabled={saving} onClick={() => void mutate(async () => { await api('archiveThread', { threadId: current.id, archived: !showArchived }); if (!showArchived && selected === current.id) openAssistantThread(ctx, 'main'); })}><IconArchiveOutlineMedium size={16} /><span>{showArchived ? '取消归档' : '归档对话'}</span></Button></div>}</Menu><AssistantRenameDialog target={renameTarget} onClose={() => setRenameTarget(null)} onError={setError} /></section>;
}
function loadCatalog() { return assistantModelCatalog.load(); }
function messageText(message) {
  if (typeof message.text === 'string') return message.text;
  if (typeof message.content === 'string') return message.content;
  return Array.isArray(message.content) ? message.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
}
function ResourceTabs({ tabs, value, onChange, label, id }) {
  return <SegmentedControl options={tabs.map(([value, label]) => ({ value, label }))} value={value} onChange={onChange} label={label} tabIdPrefix={id} panelId={id + '-panel'} />;
}
// Mount on first visit; preserve drafts when navigating back from chat.
function RetainedPane({ active, children }) {
  const visited = useRef(false);
  if (active) visited.current = true;
  return visited.current ? <div style={{ display: active ? 'contents' : 'none' }} hidden={!active}>{children}</div> : null;
}
function Studio({ snapshot, ctx, refresh, threadId, SessionProvider, renderSlot, initialSection = 'identity', initialIdentityTab = 'info', requestedTab, requestedTicket, active = true }) {
  const [confirm, confirmation] = useConfirmation();
  const [section, setSection] = useState(documentTabs[requestedTab] ? 'documents' : initialIdentityTab === 'models' ? 'models' : initialSection), [dirtySections, setDirtySections] = useState([]), [taskTab, setTaskTab] = useState('tasks');
  const [systemPreview, setSystemPreview] = useState(false);
  const [taskDetailOpen, setTaskDetailOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(initialSection === 'system-files');
  const body = useRef(null), scrollPositions = useRef(new Map()), restoringScroll = useRef(false);
  useEffect(() => {
    const node = body.current;
    if (!node) return;
    const target = scrollPositions.current.get(section) || 0;
    let observer, deadline;
    restoringScroll.current = target > 0;
    const stop = () => { restoringScroll.current = false; observer?.disconnect(); clearTimeout(deadline); };
    const restore = () => {
      node.scrollTop = target;
      if (Math.abs(node.scrollTop - target) < 1) stop();
    };
    // A revisited list may still be loading. Restore once its content arrives,
    // and yield immediately when the user chooses to scroll elsewhere.
    restore();
    if (restoringScroll.current) {
      observer = new ResizeObserver(restore);
      for (const child of node.children) observer.observe(child);
      deadline = setTimeout(stop, 5000);
    }
    const navigate = event => { if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) stop(); };
    node.addEventListener('wheel', stop, { passive: true });
    node.addEventListener('touchstart', stop, { passive: true });
    node.addEventListener('keydown', navigate);
    return () => { stop(); node.removeEventListener('wheel', stop); node.removeEventListener('touchstart', stop); node.removeEventListener('keydown', navigate); };
  }, [section]);
  useEffect(() => {
    if (['tasks', 'memory', 'connections'].includes(requestedTab)) setSection(requestedTab);
    if (requestedTab === 'goals') { setSection('goals'); }
    if (requestedTab === 'approvals') { setSection('tasks'); setTaskTab('approvals'); }
    if (requestedTab === 'models') setSection('models');
    if (requestedTab === 'pet') setSection('identity');
    if (documentTabs[requestedTab]) setSection('documents');
  }, [requestedTab]);
  useEffect(() => {
    if (requestedTicket?.ticketId) { setSection('tasks'); setTaskTab('tasks'); }
  }, [requestedTicket]);
  const taskTabsId = useId();
  const dirtyEditor = useDirtyRegistry((_dirty, keys) => setDirtySections(keys));
  const dirty = dirtySections.length > 0;
  useEffect(() => {
    if (!dirty) return;
    const guard = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  const groups = [
    { id: 'configuration', label: '配置', items: [['identity', '身份', 'userlib'], ['models', '模型', 'atom'], ['documents', '档案', 'document']] },
    { id: 'workspace', label: '工作区', items: [['tasks', '任务', 'experiment'], ['goals', '目标', 'target'], ['memory', '记忆', 'bulb'], ['artifacts', '产物', 'picture']] },
    { id: 'integrations', label: '接入', items: [['connections', '多平台', 'devices'], ['vault', '保险库', 'key']] },
    { id: 'system', label: '高级', items: [['system-files', '系统文件', 'code']] },
  ];
  const items = groups.flatMap(group => group.items);
  const current = items.find(([id]) => id === section) || items[0];
  const descriptions = {
    identity: '设定名字与形象，让助手更懂你的工作方式。',
    models: '设置身份、工作与辅助模型，按优先顺序调用。',
    documents: '整理关于你和助手的档案，作为每次协作的共同背景。',
    memory: '留下值得记住的偏好、决定与经验。',
    connections: '把助手接入常用平台，在熟悉的地方继续对话。',
    'system-files': '浏览助手的运行文件与目录，查看原始记录。',
  };
  const choose = next => {
    if (next === section) return;
    if (body.current) scrollPositions.current.set(section, body.current.scrollTop);
    if (next === 'system-files') setAdvancedOpen(true);

    setSection(next);
  };
  useEffect(() => {
    const openIdentity = () => {
      if (section === 'identity') return;
      setSection('identity');
    };
    document.addEventListener('benchgo:assistant-open-identity', openIdentity);
    return () => document.removeEventListener('benchgo:assistant-open-identity', openIdentity);
  }, [section]);
  const navigationItem = ([id, label, icon]) => <Button variant="ghost" type="button" key={id} aria-current={section === id ? 'page' : undefined} onClick={() => choose(id)}>
    {['documents', 'vault', 'system-files', 'goals'].includes(id) ? <ResourceIcon name={icon} size={16} /> : <UIIcon name={icon} size={16} />}
    <span><b>{label}{dirtySections.includes(id) && <Hint label="未保存"><span className="ba-draft-dot" aria-label="未保存">●</span></Hint>}</b></span>
  </Button>;
  const panelSource = ctx?.layout?.panelInfo;
  const panelInfo = useSyncExternalStore(listener => panelSource?.subscribe(listener) || (() => {}), () => panelSource?.getSnapshot() || null);
  const visible = active && (!panelInfo || panelInfo.activePanelId === PANEL);
  const taskTabs = <ResourceTabs tabs={[["tickets", "工单"], ["approvals", "审核"]]} value={taskTab === 'tasks' ? 'tickets' : taskTab} onChange={async next => { if (next !== (taskTab === 'tasks' ? 'tickets' : taskTab) && (!dirtySections.includes('tasks') || await confirm({ title: '放弃未保存的修改？', description: '切换分类会放弃当前工单的未保存修改。', confirmLabel: '放弃并切换', cancelLabel: '继续编辑', destructive: true }))) setTaskTab(next === 'tickets' ? 'tasks' : next); }} label="工作分类" id={taskTabsId} />;
  return <div className="ba-studio">{confirmation}<aside className="ba-studio-nav">
    <div className="ba-studio-nav-title"><BrandLogo size={30} decorative /><div><strong>BenchGo</strong><span>资源与设置</span></div></div>
    <nav aria-label="资源分区">{groups.map(group => group.id === 'system'
      ? <Disclosure key={group.id} className="ba-studio-advanced" title="高级" open={advancedOpen} onOpenChange={setAdvancedOpen}>{group.items.map(navigationItem)}</Disclosure>
      : <div className="ba-studio-nav-group" key={group.id}><span className="ba-studio-nav-group-label">{group.label}</span>{group.items.map(navigationItem)}</div>)}</nav>
  </aside><div className="ba-studio-mobile-nav"><label htmlFor="ba-studio-section">资源分区</label><CustomSelect id="ba-studio-section" aria-label="资源分区" value={section} onChange={choose} options={groups.flatMap(group => group.items.map(([id, label]) => ({ value: id, label: `${group.label} · ${label}${dirtySections.includes(id) ? ' · 未保存' : ''}` })))} /></div>
  <div className="ba-studio-body" ref={body} onScroll={event => { if (!restoringScroll.current) scrollPositions.current.set(section, event.currentTarget.scrollTop); }} data-section={section}>
    {!['artifacts', 'vault', 'goals'].includes(section) && !(section === 'system-files' && systemPreview) && !(section === 'tasks' && taskTab === 'tasks' && taskDetailOpen) && <header className="ba-studio-heading"><div className="ba-studio-heading-main"><div className="ba-studio-heading-row"><h1>{section === 'tasks' ? taskTab === 'tasks' ? '工单' : '审核' : current[1]}</h1>{section === 'tasks' && taskTabs}</div>{descriptions[section] && <p>{descriptions[section]}</p>}</div>{dirtySections.includes(section) && <span className="ba-studio-draft" role="status"><span aria-hidden="true" />草稿已保留</span>}</header>}
    <div hidden={section !== 'identity'} style={section !== 'identity' ? { display: 'none' } : undefined}>{(section === 'identity' || dirtySections.includes('identity')) && <Identity snapshot={snapshot} refresh={refresh} onDirtyChange={dirtyEditor('identity')} initialTab={initialIdentityTab === 'models' ? 'info' : initialIdentityTab} requestedTab={requestedTab} onDesign={() => { petDesignIntent.request(threadId); openAssistantThread(ctx, threadId); }} />}</div>
    <div hidden={section !== 'models'} style={section !== 'models' ? { display: 'none' } : undefined}>{(section === 'models' || dirtySections.includes('models')) && <Identity modelsOnly snapshot={snapshot} refresh={refresh} onDirtyChange={dirtyEditor('models')} />}</div>
    <div hidden={section !== 'documents'} style={section !== 'documents' ? { display: 'none' } : undefined}>{(section === 'documents' || dirtySections.includes('documents')) && <AssistantDocuments api={api} refresh={refresh} onDirtyChange={dirtyEditor('documents')} requestedDocument={documentTabs[requestedTab]} />}</div>
    <div hidden={section !== 'tasks'} style={section !== 'tasks' ? { display: 'none' } : undefined}>{(section === 'tasks' || dirtySections.includes('tasks')) && <section className="ba-group"><div id={taskTabsId + '-panel'} role="tabpanel" aria-labelledby={taskTab === 'tasks' && taskDetailOpen ? undefined : taskTabsId + '-' + (taskTab === 'tasks' ? 'tickets' : taskTab)} aria-label={taskTab === 'tasks' && taskDetailOpen ? '工单详情' : undefined}>{taskTab === 'tasks' ? <Tickets api={api} onDetailChange={setTaskDetailOpen} onOpenExecution={execution => openExecutionSession(ctx, execution)} onSchedule={() => ctx.layout.selectPanel('schedules')} requestedTicket={requestedTicket} onDirtyChange={dirtyEditor('tasks')} /> : (visible ? <ApprovalReview ctx={ctx} api={api} SessionProvider={SessionProvider} renderSlot={renderSlot} onOpenReminder={id => openAssistantThread(ctx, id)} /> : null)}</div></section>}</div>
    <div hidden={section !== 'goals'} style={section !== 'goals' ? { display: 'none' } : undefined}>{(section === 'goals' || dirtySections.includes('goals')) && <Goals api={api} onDirtyChange={dirtyEditor('goals')} />}</div>
    <div hidden={section !== 'memory'} style={section !== 'memory' ? { display: 'none' } : undefined}>{(section === 'memory' || dirtySections.includes('memory')) && <MemoryPage api={api} refresh={refresh} onDirtyChange={dirtyEditor('memory')} entries={snapshot.memories || []} threadId={threadId} />}</div>
    <div hidden={section !== 'artifacts'} style={section !== 'artifacts' ? { display: 'none' } : undefined}>{(section === 'artifacts' || dirtySections.includes('artifacts')) && <Artifacts api={api} />}</div>
    <div hidden={section !== 'connections'} style={section !== 'connections' ? { display: 'none' } : undefined}>{(section === 'connections' || dirtySections.includes('connections')) && <Connections api={api} active={visible && section === 'connections'} onDirtyChange={dirtyEditor('connections')} />}</div>
    <div hidden={section !== 'vault'} style={section !== 'vault' ? { display: 'none' } : undefined}>{(section === 'vault' || dirtySections.includes('vault')) && <VaultSettingsSection onDirtyChange={dirtyEditor('vault')} />}</div>
    <div hidden={section !== 'system-files'} style={section !== 'system-files' ? { display: 'none' } : undefined}>{(section === 'system-files' || dirtySections.includes('system-files')) && <SystemFiles api={api} onPreviewChange={setSystemPreview} />}</div>
  </div></div>;
}

function ModelSetupNotice({ onOpen }) {
  return <ResourceState icon="atom" title="还没有配置文本模型" description="添加一个可用模型，即可开始与助手对话。" actionLabel="去设置模型" onAction={onOpen} />;
}
function HistoryNotice({ history, threadId, onClear }) {
  const [busy, setBusy] = useState(false);
  if (!history.error && !(history.failures || []).length) return null;
  const clear = async () => {
    if (busy || threadId !== 'main') return;
    setBusy(true);
    try { await onClear(); }
    finally { setBusy(false); }
  };
  return <>{history.error && <div className="ba-error" role="alert"><span>本次回复未完成，对话记录已保留。请重试或检查模型连接。</span><Disclosure title={<>诊断详情</>}><pre>{typeof history.error === 'string' ? history.error : history.error.message || '回复失败'}</pre></Disclosure>{threadId === 'main' && <Button variant="ghost" type="button" disabled={busy} onClick={clear}>{busy ? '清理中…' : '清理主聊天记录'}</Button>}</div>}{(history.failures || []).length > 0 && <Disclosure className="ba-model-failure" title={<>模型连接记录</>}>{history.failures.map((failure, index) => <div key={index}>{failure.model?.modelId || '候选模型'}：{failure.reason || failure.message || '暂不可用'}</div>)}</Disclosure>}</>;
}
function retainSession(ctx, sessionId, threadId = 'main') {
  const controller = new AbortController();
  let reference;
  const ready = (async () => {
    // Retaining a cold official session also resumes its writer. Let the
    // assistant finish installing its session before the client can retain it.
    const ensured = await api('ensure', { threadId }, controller.signal);
    if (controller.signal.aborted || ensured.sessionId !== sessionId) return;
    reference = await retainAssistantSession(ctx.sessions, sessionId, controller.signal);
    if (controller.signal.aborted) { reference.release(); return; }
    await reference.ready;
  })();
  return { ready, release() { controller.abort(); reference?.release(); } };
}
function PendingCard({ pending, title }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [answers, setAnswers] = useState({});
  useSyncExternalStore(pending.subscribe || (() => () => {}), pending.getSnapshot || (() => null));
  async function respond(value) {
    if (busy) return; setBusy(true); setError('');
    try { await pending.answer(value); } catch (cause) { setError(cause.message); setBusy(false); }
  }
  const questions = pending.questions || [];
  const ready = questions.every(question => answers[question.id]?.selected?.length || answers[question.id]?.custom?.trim());
  return <section className="ba-pending" aria-label="等待你的决定"><strong>{title} · 需要回答</strong>{['question', 'plan-review'].includes(pending.kind) ? <>{questions.map(question => <fieldset key={question.id}><legend>{question.question}</legend>{question.detail && <p>{question.detail}</p>}{(question.options || []).map(option => <label className="ba-checkbox" key={option.label}><input type={question.multiSelect ? 'checkbox' : 'radio'} name={`${pending.key}-${question.id}`} checked={(answers[question.id]?.selected || []).includes(option.label)} onChange={event => { pending.engage?.(); const prior = answers[question.id]?.selected || []; const selected = question.multiSelect ? event.target.checked ? [...prior, option.label] : prior.filter(label => label !== option.label) : [option.label]; setAnswers({ ...answers, [question.id]: { ...answers[question.id], selected } }); }} />{option.label}{option.description && <small>{option.description}</small>}</label>)}<textarea aria-label={`${question.question} 补充回答`} rows={2} value={answers[question.id]?.custom || ''} onChange={event => { pending.engage?.(); setAnswers({ ...answers, [question.id]: { ...answers[question.id], custom: event.target.value } }); }} /></fieldset>)}<Button variant="ghost" disabled={busy || !ready} onClick={() => respond({ answers: questions.map(question => ({ id: question.id, selected: answers[question.id]?.selected || [], ...(answers[question.id]?.custom ? { custom: answers[question.id].custom } : {}) })) })}>提交回答</Button></> : <p>此交互暂不支持，请在原会话中处理。</p>}{error && <p role="alert">{error}</p>}</section>;
}
const EMPTY_STATUSES = new Map();
const EMPTY_SESSIONS = { byId: {} };
function PendingInteractions({ ctx, threads, currentSessionId }) {
  const source = ctx.uiSession?.sessionStatus;
  const statuses = useSyncExternalStore(listener => source?.subscribe(listener) || (() => {}), () => source?.getSnapshot() || EMPTY_STATUSES);
  return <div className="ba-pending-list">{threads.filter(thread => thread.sessionId !== currentSessionId).map(thread => {
    const pending = statuses.get(thread.sessionId)?.pendingInteraction;
    return pending && pending.kind !== 'approval' ? <PendingCard key={pending.key} pending={pending} title={thread.id === 'main' ? '主聊天' : thread.title || '旁聊'} /> : null;
  })}</div>;
}
function UIIcon({ name, ...props }) {
  const mapped = { 'arrow-up': 'chevronDown', 'arrow-down': 'chevronDown', menu: 'more', stop: 'close' };
  const icon = <BaseIcon name={mapped[name] || name} {...props} />;
  return name === 'arrow-up' ? <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>{icon}</span> : icon;
}
async function request(action, args, signal) {
  const url = new URL('api/commander/assistant', document.baseURI), done = perfTrace.time('assistant:' + action);
  try { return await readJsonResponse(await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args }), signal }), url); }
  finally { done(); }
}
// Frequent reads leave the state snapshot valid; every other action may change it.
const STATE_PRESERVING = new Set(['history', 'ensure', 'tickets', 'approvalOrigins', 'executionSessions', 'executionSummaryActivity', 'petCatalog', 'goalList', 'connectionCatalog', 'connectionStatus']);
const ensuredSessions = new Map();
let stateEpoch = 0, stateRead = null;
/** A reader arriving after this point never shares a state read that began before it. */
function invalidateAssistantState() { stateEpoch++; }
function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    // The shared read always has a handler, including after this caller left.
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
// Sidebar, page, board and sounds react to the same invalidation; they share its one read.
function readState(signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  let read = stateRead;
  if (!read || read.epoch !== stateEpoch) {
    const order = assistantConfigSync.begin();
    read = stateRead = { epoch: stateEpoch };
    read.promise = request('state', {}).then(response => ({ ...response, config: assistantConfigSync.accept(response.config, order) }))
      .finally(() => { if (stateRead === read) stateRead = null; });
  }
  return abortable(read.promise, signal);
}
async function api(action, args = {}, signal) {
  if (action === 'state' && !Object.keys(args).length) return readState(signal);
  const order = assistantConfigSync.begin();
  let response;
  try { response = await request(action, args, signal); }
  finally { if (!STATE_PRESERVING.has(action)) invalidateAssistantState(); }
  if (signal?.aborted && action === 'config') signal.throwIfAborted();
  if (['config', 'petApply', 'petRestore'].includes(action)) return assistantConfigSync.accept(response.config || response, order);
  // Every poll and background retain ensures its thread. Only a first or replaced
  // session changes what the sidebar, ownership and review lists must reread.
  const threadId = args.threadId ?? 'main';
  if (action === 'resetMain') ensuredSessions.delete('main');
  if (action === 'resetMain' || (action === 'ensure' && ensuredSessions.get(threadId) !== response.sessionId)) {
    if (action === 'ensure') ensuredSessions.set(threadId, response.sessionId);
    invalidateAssistantState();
    document.dispatchEvent(new Event('benchgo:assistant-changed'));
  }
  return response;
}
function Hint({ label, children }) { return <Tooltip label={label} delayMs={450} portal>{children}</Tooltip>; }
function AssistantRenameDialog({ target, onClose, onError }) {
  const [title, setTitle] = useState(target?.title || ''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { setTitle(target?.title || ''); setError(''); }, [target?.id]);
  const submit = async event => {
    event?.preventDefault();
    const next = title.trim();
    if (!target || !next || busy) return;
    setBusy(true); setError('');
    try { await api('renameThread', { threadId: target.id, title: next }); document.dispatchEvent(new Event('benchgo:assistant-changed')); onClose(); }
    catch (cause) { const message = cause.message; setError(message); onError?.(message); }
    finally { setBusy(false); }
  };
  return <Modal open={!!target} onClose={() => { if (!busy) onClose(); }} title="重命名会话" closeLabel="关闭" footer={<><Button variant="ghost" className="cmd-dialog-button" disabled={busy} onClick={onClose}>取消</Button><Button variant="default" className="cmd-dialog-button cmd-dialog-primary" disabled={busy || !title.trim()} onClick={submit}>{busy ? '保存中…' : '保存'}</Button></>}><form className="cmd-rename-form" onSubmit={submit}><label htmlFor="ba-thread-rename">会话名称</label><input id="ba-thread-rename" aria-label="旁聊名称" autoFocus value={title} disabled={busy} onChange={event => setTitle(event.target.value)} />{error && <p role="alert">{error}</p>}</form></Modal>;
}
function IconButton({ icon, label, ...props }) { return <Button variant="ghost" type="button" className="ba-icon" title={label} aria-label={label} {...props}><UIIcon name={icon} size={17} /></Button>; }
function Field({ label, children }) { return <label className="ba-field"><span>{label}</span>{children}</label>; }
function Picker({ label, value, options, placeholder = '选择', allowCustom = false, onChange }) {
  const id = useId();
  const items = options.map(item => typeof item === 'string' ? { value: item, label: item } : item);
  return <div className="ba-field"><label htmlFor={id}>{label}</label><CustomSelect id={id} aria-label={label} value={value} options={items.map(item => ({ ...item, searchText: item.label + ' ' + item.value }))} placeholder={placeholder} searchable allowCustom={allowCustom} onChange={onChange} /></div>;
}
function ModelFields({ value = {}, onChange, onStatusChange }) {
  const [catalog, setCatalog] = useState(() => assistantModelCatalog.peek() || { providers: [], models: [] }), [error, setError] = useState('');
  const revision = useSyncExternalStore(assistantModelCatalog.subscribe, assistantModelCatalog.getSnapshot);
  const [loading, setLoading] = useState(() => assistantModelCatalog.peek() === null);
  useEffect(() => { onStatusChange?.({ loading, error }); }, [loading, error, onStatusChange]);
  useEffect(() => { let active = true; setLoading(assistantModelCatalog.peek() === null); loadCatalog().then(next => { if (active) { setCatalog(next); setError(''); } }).catch(cause => { if (active) setError(cause.message); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [revision]);
  const providers = catalog.providers.map(provider => ({ value: provider.id, label: (provider.name || provider.id) + (provider.available === false ? ' · 不可用' : '') }));
  const models = catalog.models.filter(model => !value.providerId || model.provider === value.providerId).map(model => ({ value: model.id, label: model.name || model.id }));
  return <><div className="ba-model-fields"><Picker label="供应商" value={value.providerId || ''} options={providers} placeholder="选择供应商" allowCustom onChange={providerId => onChange({ ...value, providerId })} /><Picker label="模型" value={value.modelId || ''} options={models} placeholder="选择模型" allowCustom onChange={modelId => onChange({ ...value, modelId })} /></div>{loading ? <Loading label="正在读取模型目录" compact /> : error ? <p className="ba-model-feedback" data-error="true" role="alert"><span>模型目录加载失败：{error}。可手动填写完整 ID。</span><Button variant="ghost" type="button" className="ba-quiet" onClick={() => assistantModelCatalog.invalidate()}>重试</Button></p> : !providers.length && <p className="ba-model-feedback" role="status"><UIIcon name="server" size={15} /><span>目录中还没有供应商。可先在模型设置中配置，或填写已有供应商与模型的完整 ID。</span></p>}</>;
}
function Identity({ snapshot, refresh, onDirtyChange, initialTab = 'info', onDesign, requestedTab, modelsOnly = false }) {
  const [confirm, confirmation] = useConfirmation();
  const [config, setConfig] = useState(snapshot.config), [baseConfig, setBaseConfig] = useState(snapshot.config);
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState(''), [tab, setTab] = useState(modelsOnly ? 'models' : initialTab);
  const tabsId = useId();
  const [editorReset, setEditorReset] = useState(0);
  const [saveError, setSaveError] = useState(null);
  const errorMessage = useRef(null);
  useEffect(() => { if (saveError) { errorMessage.current?.focus({ preventScroll: true }); errorMessage.current?.scrollIntoView({ block: 'nearest' }); } }, [saveError]);
  useEffect(() => { if (!modelsOnly && requestedTab === 'pet') setTab('pet'); }, [requestedTab, modelsOnly]);
  const patch = identityConfigPatch(config, baseConfig);
  const dirty = Object.keys(patch).length > 0;
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) { setConfig(snapshot.config); setBaseConfig(snapshot.config); }
  }, [snapshot.config, snapshot.profile?.identity]);
  const change = update => { setConfig(value => ({ ...value, ...update })); setSaved(''); setSaveError(null); };
  async function save(event) {
    event?.preventDefault(); if (busy || !dirty) return;
    const invalid = (modelsOnly || tab === 'models') && validateModelSettings(config);
    if (invalid) { setSaveError(invalid); return; }
    setBusy(true); setSaved(''); setSaveError(null);
    try {
      if (Object.keys(patch).length) {
        const response = await saveConfigPatch(api, baseConfig, patch);
        const next = response.config || response; setConfig(next); setBaseConfig(next);
      }
      setSaved('已保存');
      // The config response already updates every subscriber; a state refresh is
      // independent, so a later network failure cannot turn a successful save into failure.
      void refresh().catch(cause => setSaved('已保存；刷新失败：' + cause.message));
    } catch (cause) { setSaveError({ message: cause.message || '保存未完成，请重试。' }); }
    finally { setBusy(false); }
  }
  return <form className="ba-identity-pane" onSubmit={save}>{confirmation}{!modelsOnly && <ResourceTabs tabs={[['info', '信息'], ['pet', '形象']]} value={tab} onChange={setTab} label="身份分类" id={tabsId} />}<fieldset disabled={busy} id={tabsId + '-panel'} role={modelsOnly ? undefined : 'tabpanel'} aria-label={modelsOnly ? '模型设置' : undefined} aria-labelledby={modelsOnly ? undefined : tabsId + '-' + tab} className="ba-identity-panel" data-tab={tab}>
    {tab === 'info' ? <><section className="ba-identity-info"><div className="ba-identity-name"><div className="ba-settings-section-heading"><h2>如何称呼你的助手</h2><p>这个名字会显示在名片和对话中。</p></div><Field label="名字"><input placeholder="未命名（可选）" maxLength={100} value={config.name || ''} onChange={event => change({ name: event.target.value })} /></Field></div><IdentityCardEditor key={`${baseConfig.revision}:${editorReset}`} config={config} onChange={change} defaultName={DEFAULT_NAME} /></section><NotificationSoundSettings /></> : tab === 'pet' ? <PetSettings api={api} config={snapshot.config} onChanged={refresh} onDesign={onDesign} /> : <ModelSettings config={config} validationError={saveError} onChange={change} ModelFields={ModelFields} IconButton={IconButton} />}
  </fieldset>{saveError && <div className="ba-identity-error" role="alert" tabIndex={-1} ref={errorMessage}><UIIcon name="close" size={16} /><span>{saveError.message}</span></div>}
    {(tab !== 'pet' || dirty) && (dirty || saved || busy || saveError) && <footer className="ba-identity-save" data-dirty={dirty}>
      <span role="status"><UIIcon name={busy ? 'refresh' : dirty ? 'edit' : 'check'} size={16} />{busy ? '正在保存…' : saved || '有未保存的修改'}</span>
      <div className="ba-row-actions">{dirty && <Button variant="ghost" type="button" className="ba-quiet" disabled={busy} onClick={async () => { if (!await confirm({ title: '放弃未保存的修改？', description: '取消后将恢复到已保存的设置。', confirmLabel: '放弃修改', cancelLabel: '继续编辑', destructive: true })) return; const latest = assistantConfigSync.getSnapshot() || snapshot.config; setConfig(latest); setBaseConfig(latest); setEditorReset(value => value + 1); setSaved(''); setSaveError(null); }}>取消修改</Button>}<Button variant="default" type="submit" className="ba-primary" disabled={busy || !dirty}>{busy ? '保存中…' : saveError ? '重试保存' : '保存更改'}</Button></div>
    </footer>}
  </form>;
}

function Images({ images = [] }) {
  if (!images.length) return null;
  return <div className="ba-images">{images.filter(image => image.url && /^(https?:|\/|api\/)/i.test(image.url)).map((image, index) => <figure key={image.id || index}><a href={image.url} target="_blank" rel="noreferrer"><img src={image.url} alt={image.prompt || image.name || '生成图片'} loading="lazy" /></a><a href={image.url} download={image.name || true}>下载图片</a></figure>)}</div>;
}
function mergeHistory(previous, incoming, earlier = false) {
  if (!earlier && incoming.sessionId && incoming.sessionId !== previous.sessionId) previous = { messages: [], running: false };
  const unique = values => [...new Map(values.map((value, index) => [value.id || value.url || `${value.role || 'message'}:${value.time || index}:${index}`, value])).values()];
  const stable = (previous.messages || []).filter(message => !message.streaming);
  const messages = earlier ? unique([...(incoming.messages || []), ...(previous.messages || [])]) : unique([...stable, ...(incoming.messages || [])]);
  const pagination = earlier || previous.nextBefore === undefined ? incoming : previous;
  return { ...previous, ...(earlier ? {} : incoming), messages,
    images: unique(earlier ? [...(incoming.images || []), ...(previous.images || [])] : [...(previous.images || []), ...(incoming.images || [])]),
    hasMore: pagination.hasMore, nextBefore: pagination.nextBefore };
}
// Background retention follows every session's status and activity. Owning those
// subscriptions here keeps unrelated sessions from re-rendering the open transcript.
function BackgroundSessions({ ctx, state, selectedSessionId }) {
  const retained = useRef(new Map());
  const statusSource = ctx.uiSession?.sessionStatus, sessionSource = ctx.sessions?.list;
  const statuses = useSyncExternalStore(listener => statusSource?.subscribe(listener) || (() => {}), () => statusSource?.getSnapshot() || EMPTY_STATUSES);
  const sessions = useSyncExternalStore(listener => sessionSource?.subscribe(listener) || (() => {}), () => sessionSource?.getSnapshot() || EMPTY_SESSIONS);
  const ensureScope = async (sessionId, id) => {
    if (!sessionId) throw new Error('助手会话尚未准备就绪');
    if (!retained.current.has(sessionId)) retained.current.set(sessionId, retainSession(ctx, sessionId, id));
    const scope = retained.current.get(sessionId);
    try { await scope.ready; }
    catch (cause) {
      if (retained.current.get(sessionId) !== scope) return;
      retained.current.delete(sessionId); scope.release();
      throw cause;
    }
  };
  useEffect(() => () => { for (const scope of retained.current.values()) scope.release(); retained.current.clear(); }, [ctx]);
  useEffect(() => {
    const background = assistantBackgroundSessions(state, selectedSessionId, statuses, sessions);
    for (const [sessionId, scope] of retained.current) if (!background.has(sessionId)) { scope.release(); retained.current.delete(sessionId); }
    for (const [sessionId, id] of background) void ensureScope(sessionId, id).catch(cause => { console.warn('[BenchGo] background session connection failed', cause); });
  }, [state?.threads, state?.mainSessionId, selectedSessionId, statuses, sessions]);
  return null;
}
export function AssistantPage({ ctx, SessionProvider, renderSlot }) {
  const execution = useSyncExternalStore(executionSessionNavigation.subscribe, executionSessionNavigation.getSnapshot);
  const [snapshot, setSnapshot] = useState(null), [error, setError] = useState(''), [tab, setTab] = useState(selectedAssistantTab);
  const [threadId, setThreadId] = useState(selectedAssistantThread), [history, replaceHistory] = useState({ messages: [], running: false });
  const [requestedTicket, setRequestedTicket] = useState(selectedAssistantTicket);
  useEffect(() => {
    const openThread = event => select(event.detail);
    document.addEventListener('benchgo:assistant-thread', openThread);
    return () => document.removeEventListener('benchgo:assistant-thread', openThread);
  }, []);
  useEffect(() => {
    const openTab = event => { setTab(event.detail || 'chat'); setRequestedTicket(selectedAssistantTicket); };
    document.addEventListener('benchgo:assistant-tab', openTab);
    return () => document.removeEventListener('benchgo:assistant-tab', openTab);
  }, []);
  const current = useRef(threadId), epoch = useRef(0), historyReads = useRef(new Map());
  // Unchanged messages keep their identity, so a poll re-renders only rows whose data moved.
  const setHistory = value => { if (!value.threadId || value.threadId === current.current) replaceHistory(previous => structuralShare(previous, mergeHistory(previous, value))); };
  const readHistory = async id => {
    const requestEpoch = epoch.current;
    const value = await api('history', { threadId: id });
    if (current.current === id && epoch.current === requestEpoch) setHistory(value);
  };
  // One read per thread at a time. Callers arriving meanwhile share a single
  // trailing read, which starts after their change and therefore observes it.
  const refreshHistory = (id, signal) => {
    const reads = historyReads.current, active = reads.get(id);
    const start = () => {
      const entry = { queued: null };
      entry.running = readHistory(id).finally(() => { if (reads.get(id) === entry) reads.delete(id); });
      reads.set(id, entry);
      return entry.running;
    };
    if (!active) return abortable(start(), signal);
    active.queued ||= active.running.then(start, start);
    return abortable(active.queued, signal);
  };
  const latestHistory = useRef(history);
  latestHistory.current = history;
  // The conversation context is memoized on these callbacks; they outlive history commits.
  const loadEarlier = useCallback(async () => {
    const { hasMore, nextBefore } = latestHistory.current;
    if (!hasMore || nextBefore == null) return;
    const id = current.current, requestEpoch = epoch.current;
    const page = await api('history', { threadId: id, before: nextBefore });
    if (current.current === id && epoch.current === requestEpoch) replaceHistory(previous => structuralShare(previous, mergeHistory(previous, page, true)));
  }, []);
  const openExecution = useCallback(target => openExecutionSession(ctx, target), [ctx]);
  const openResources = useCallback((next, selection) => openAssistantTab(ctx, next, selection), [ctx]);
  useEffect(() => {
    if (tab !== 'chat' || !history.sessionId) return;
    let timer, disposed = false;
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (document.hidden) return;
        void refreshHistory(threadId).catch(cause => { if (!disposed) setError(cause.message); });
      }, 100);
    };
    document.addEventListener('benchgo:assistant-history-changed', changed);
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener('benchgo:assistant-history-changed', changed); };
  }, [threadId, tab, history.sessionId]);
  current.current = threadId;
  const refreshCurrent = useRef(null);
  refreshCurrent.current = () => refreshHistory(threadId);
  // Message controls are memoized on this callback; it must outlive history commits.
  const onRefresh = useCallback(() => refreshCurrent.current(), []);
  const stateRequest = useRef(0);
  const refresh = async (signal) => { const request = ++stateRequest.current; const value = await api('state', {}, signal); if (request === stateRequest.current) setSnapshot(previous => structuralShare(previous, { ...value, config: assistantConfigSync.getSnapshot() || value.config })); return value; };
  const execute = async (operation) => { try { setError(''); await operation(); return true; } catch (cause) { setError(cause.message || String(cause)); return false; } };
  const retryLoad = async () => { try { setError(''); await refresh(); if (tab === 'chat') { await api('ensure', { threadId }); await refreshHistory(threadId); } } catch (cause) { setError(cause.message || String(cause)); } };
  const clearingMain = useRef(false), clearCommand = useRef(null);
  const clearMain = async () => {
    if (clearingMain.current || current.current !== 'main') return;
    clearingMain.current = true;
    try {
      await execute(async () => {
        await api('resetMain');
        epoch.current++;
        clearCommand.current.sessionId = null;
        setSnapshot(value => value ? { ...value, state: { ...value.state, mainSessionId: null } } : value);
        if (current.current === 'main') replaceHistory({ messages: [], running: false });
        document.dispatchEvent(new Event('benchgo:assistant-changed'));
        try {
          await refresh();
          if (current.current === 'main') { await api('ensure', { threadId: 'main' }); await refreshHistory('main'); }
        } catch (cause) { setError('主聊天已清理，重新加载失败：' + (cause.message || String(cause))); }
      });
    } finally { clearingMain.current = false; }
  };
  clearCommand.current = { sessionId: threadId === 'main' ? history.sessionId : null, run: clearMain };
  useEffect(() => {
    const registration = ctx.inject(['commandUi'], scope => {
      scope.effect(() => scope.commandUi.register({
        name: 'clear',
        label: () => '清理主聊天',
        description: () => '清空主聊天记录并开始新的对话',
        icon: props => <UIIcon name="trash" {...props} />,
        available: session => !!clearCommand.current?.sessionId && clearCommand.current.sessionId === session.sessionId,
        ui: { kind: 'action', run: session => { if (clearCommand.current?.sessionId === session.sessionId) void clearCommand.current.run(); } },
      }));
    });
    return () => { void registration.dispose(); };
  }, [ctx]);
  useEffect(() => {
    let disposed = false, timer, inFlight, opened = false;
    const visible = () => !document.hidden && (!ctx?.layout?.panelInfo || ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL);
    const tick = async () => {
      clearTimeout(timer);
      if (disposed || inFlight || !visible()) return;
      const controller = new AbortController(); inFlight = controller;
      try {
        const results = await Promise.allSettled([
          refresh(controller.signal),
          ...(tab === 'chat' ? [(async () => {
            if (!opened) { await api('ensure', { threadId }, controller.signal); opened = true; }
            if (!disposed) await refreshHistory(threadId, controller.signal);
          })()] : []),
        ]);
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
      } catch (cause) { if (!disposed && !controller.signal.aborted) setError(cause.message); }
      finally {
        inFlight = null;
        if (!disposed && visible()) timer = setTimeout(tick, controller.signal.aborted ? 0 : 30000);
      }
    };
    const wake = () => { clearTimeout(timer); if (visible()) void tick(); else inFlight?.abort(); };
    const unsubscribe = ctx?.layout?.panelInfo?.subscribe(wake);
    document.addEventListener('visibilitychange', wake);
    document.addEventListener('benchgo:assistant-changed', wake);
    window.addEventListener('online', wake);
    void tick();
    return () => { disposed = true; inFlight?.abort(); clearTimeout(timer); unsubscribe?.(); document.removeEventListener('visibilitychange', wake); document.removeEventListener('benchgo:assistant-changed', wake); window.removeEventListener('online', wake); };
  }, [threadId, tab, ctx]);
  const select = (id) => { const next = id || 'main'; selectedAssistantThread = next; setTab('chat'); if (current.current === next) return; epoch.current++; current.current = next; setThreadId(next); replaceHistory({ messages: [], running: false }); };
  const threads = snapshot?.state?.threads || [];
  const selected = threads.find(thread => thread.id === threadId);
  const view = tab === 'chat' ? 'chat' : 'studio';
  return <ActivityProvider><BackgroundSessions ctx={ctx} state={snapshot?.state} selectedSessionId={history.sessionId} /><div className="ba-root"><main className="ba-main"><div className="ba-assistant-content" hidden={!!execution}>{error && snapshot && <div className="ba-error" role="alert"><span>{error}</span><Button variant="ghost" type="button" onClick={retryLoad}>重试加载</Button><IconButton icon="close" label="关闭错误" onClick={() => setError('')} /></div>}{snapshot && <PendingInteractions ctx={ctx} currentSessionId={tab === 'chat' ? history.sessionId : undefined} threads={[...(snapshot.state.mainSessionId && !threads.some(thread => thread.id === 'main') ? [{ id: 'main', title: '主聊天', sessionId: snapshot.state.mainSessionId }] : []), ...threads.filter(thread => thread.sessionId), ...(!threads.some(thread => thread.sessionId === history.sessionId) && history.sessionId ? [{ id: threadId, title: selected?.title, sessionId: history.sessionId }] : [])]} />}{!snapshot ? <div className="ba-resource-initial"><ResourceState kind={error ? 'error' : 'loading'} title={error ? '暂时无法加载助手' : '正在准备助手'} description={error || '正在读取配置与资源，请稍候。'} onAction={error ? retryLoad : undefined} /></div> : <><RetainedPane active={!execution && view === 'studio'}><Studio active={!execution && view === 'studio'} requestedTab={tab} requestedTicket={requestedTicket} initialSection={['tasks', 'goals', 'memory', 'connections'].includes(tab) ? tab : 'identity'} initialIdentityTab={['models', 'pet'].includes(tab) ? tab : 'info'} snapshot={snapshot} ctx={ctx} refresh={refresh} threadId={threadId} SessionProvider={SessionProvider} renderSlot={renderSlot} /></RetainedPane>{view === 'chat' && <>{!snapshot.config.models?.length && <ModelSetupNotice onOpen={() => { selectedAssistantTab = 'models'; setTab('models'); }} />}<HistoryNotice history={history} threadId={threadId} onClear={clearMain} />{history.sessionId ? <AssistantConversation onOpenExecution={openExecution} key={threadId} ctx={ctx} sessionId={history.sessionId} threadId={threadId} history={history} onLoadEarlier={loadEarlier} onRefresh={onRefresh} SessionProvider={SessionProvider} renderSlot={renderSlot} api={api} assistantName={snapshot.config.name} assistantConfig={snapshot.config} petExpression={snapshot.petExpression} onOpenResources={openResources} /> : <div className="ba-resource-initial">{error ? <ResourceState kind="error" title="聊天暂未连接" description={error} actionLabel="重新连接" onAction={retryLoad} /> : <Loading label={`正在打开${threadId === 'main' ? '主聊天' : '旁聊'}`} />}</div>}<Images images={history.images} /></>}</>}</div>{execution && <ExecutionSessionPanel ctx={ctx} execution={execution} api={api} SessionProvider={SessionProvider} renderSlot={renderSlot} onClose={() => executionSessionNavigation.close()} onOpenTicket={ticketId => openAssistantTab(ctx, 'tasks', { ticketId })} />}</main>{!execution && snapshot && tab === 'chat' && <ActivityPanel onOpenReminder={id => openAssistantThread(ctx, id)} api={api} ctx={ctx} sessionId={history.sessionId} SessionProvider={SessionProvider} renderSlot={renderSlot} onOpenExecution={execution => openExecutionSession(ctx, execution)} assistantConfig={snapshot.config} onOpenResources={(next, selection) => openAssistantTab(ctx, next, selection)} />}</div></ActivityProvider>;
}
export function mountAssistant(ctx) {
  // Other modules announce changes with this event. Capture runs before every
  // consumer's listener, so none of them shares a read older than the change.
  ctx.effect(() => {
    document.addEventListener('benchgo:assistant-changed', invalidateAssistantState, true);
    return () => document.removeEventListener('benchgo:assistant-changed', invalidateAssistantState, true);
  });
  mountReplySound(ctx, api);
  mountAssistantActivity(ctx, api);
  mountSessionRoleControls(ctx, api, async role => {
    if (role.role === 'router') { openAssistantThread(ctx, role.threadId); return; }
    const entries = (await api('executionSessions')).sessions || [];
    const execution = entries.find(row => row.sessionId === role.sessionId);
    if (!execution) throw new Error('执行记录暂不可用，请在原工单查看当前执行。');
    await openExecutionSession(ctx, execution);
  });
  mountAssistantConversation(ctx);
  mountApprovalReview(ctx);
  const loadExecutionSessions = async signal => (await api('executionSessions', {}, signal)).sessions || [];
  registerExecutionSessionDiscovery(ctx, loadExecutionSessions);

  registerChannelMessages(ctx);
  ctx.effect(() => () => {
    if (ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL) ctx.layout.selectPanel(null);
  });
  ctx.effect(() => { const style = document.createElement('style'); style.textContent = css + '\n' + documentsCss; document.head.append(style); return () => style.remove(); });
  ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register({ name: 'main', key: PANEL, children: { ...assistantConversationChildren, ...reviewApprovalChildren }, inject: () => ({ ctx }) }, AssistantPage);
    if (!initialPanelSelected) {
      initialPanelSelected = true;
      openAssistantThread(ctx, 'main');
    }
    return dispose;
  });
}

