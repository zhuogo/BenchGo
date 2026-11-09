import { Disclosure } from '../../shared/client/ui/collapsible.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import { ModelSettings } from './model-settings.jsx';
import { retainAssistantSession } from './session-retain.mjs';
import { identityConfigPatch } from './model-settings.mjs';
import React, { useEffect, useRef, useState, useId, useSyncExternalStore } from 'react';
import { Tooltip, Modal, Menu, IconPinOutlineMedium, IconPinFillMedium, IconArchiveOutlineMedium, IconArchiveOffOutlineMedium, IconEllipsisOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives';
import { UIIcon as BaseIcon } from '../../benchgo/client/iconsax.jsx';
import { BrandLogo } from '../../link/client/brand.jsx';
import { readJsonResponse } from '../../benchgo/client/http-response.mjs';
import css from './style.css';
import documentsCss from './documents.css';
import { AssistantCard } from './card.jsx';
import { PetSettings } from './pet-settings.jsx';
import { petDesignIntent, petActionForSession, petExpressionForAction } from './pet-state.mjs';
import { IdentityCardEditor } from './identity-card-editor.jsx';
import { assistantConfigSync, saveConfigPatch } from './config-sync.mjs';
import { AssistantConversation, assistantConversationChildren, mountAssistantConversation } from './conversation.jsx';
import { ApprovalReview, reviewApprovalChildren, mountApprovalReview } from './approval-review.jsx';
import { AssistantDocuments } from './documents.jsx';
import { Artifacts } from './artifacts.jsx';
import { SystemFiles } from './system-files.jsx';
import { ResourceIcon } from '../../shared/client/resource-icon.jsx';
import { CustomSelect } from '../../shared/client/custom-select.jsx';
import { SegmentedControl } from '../../shared/client/segmented-control.jsx';
import { MemoryPage } from './memory.jsx';
import { Goals } from './goals.jsx';
import { Tickets } from './tickets.jsx';
import { ActionPermissions } from './action-permissions.jsx';
import { registerExecutionSessionRows, openExecutionSession } from './execution-session.jsx';
import { registerExecutionSessionDiscovery } from './execution-session-navigation.mjs';
import { registerChannelSessionRows } from './channel-session.jsx';
import { ActivityPanel, ActivityProvider } from './activity-panel.jsx';
import { Evaluations } from './evaluations.jsx';
import { useDirtyRegistry } from './dirty-registry.mjs';
import { Connections } from './connections.jsx';
import { VaultSettingsSection } from '../../shared/client/vault-settings.jsx';
import { ResourceState } from './resource-state.jsx';

const PANEL = 'benchgo-assistant';
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
  selectedAssistantThread = threadId || 'main';
  selectedAssistantTab = 'chat';
  selectedAssistantTicket = null;
  ctx.layout.selectPanel(PANEL);
  dispatchAssistantEvent('benchgo:assistant-thread', selectedAssistantThread);
}
function openAssistantTab(ctx, tab, selection) {
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
  const assistantBodyId = useId();
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
    let latest = 0;
    const refresh = async (force = false) => {
      if (document.hidden && force !== true) return;
      const request = ++latest;
      if (force === true) { setLoadError(''); setRefreshing(true); }
      try {
        const value = await api('state', {}, controller.signal);
        if (!controller.signal.aborted && request === latest) {
          setThreads(value.state.threads || []); setMainSessionId(value.state.mainSessionId || null); setLoaded(true); setLoadError('');
        }
      } catch (cause) {
        if (!controller.signal.aborted && request === latest) setLoadError(cause.message || '连接暂时不可用');
      } finally {
        if (!controller.signal.aborted && request === latest) setRefreshing(false);
      }
    };
    refreshRef.current = refresh;
    const selectedThread = event => { setSelected(event.detail); setSelectedTab('chat'); };
    const selectedTabChanged = event => setSelectedTab(event.detail);
    refresh(); const timer = setInterval(refresh, 5000);
    document.addEventListener('benchgo:assistant-thread', selectedThread);
    document.addEventListener('benchgo:assistant-tab', selectedTabChanged);
    const clearArchived = () => { if (!showArchived) return; setSaving(true); setError(''); api('deleteArchivedThreads').then(() => { if (selectionRef.current !== 'main') openAssistantThread(ctx, 'main'); refresh(); }).catch(cause => setError(cause.message)).finally(() => setSaving(false)); };
    document.addEventListener('benchgo:assistant-changed', refresh);
    document.addEventListener('benchgo:clear-archived-threads', clearArchived);
    return () => { controller.abort(); refreshRef.current = null; clearInterval(timer); document.removeEventListener('benchgo:assistant-thread', selectedThread); document.removeEventListener('benchgo:assistant-tab', selectedTabChanged); document.removeEventListener('benchgo:assistant-changed', refresh); document.removeEventListener('benchgo:clear-archived-threads', clearArchived); document.dispatchEvent(new CustomEvent('benchgo:archived-thread-count', { detail: 0 })); };
  }, [showArchived]);
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
  const visible = threads.filter(thread => thread.id !== 'main' && !!thread.archived === !!showArchived).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  useEffect(() => { document.dispatchEvent(new CustomEvent('benchgo:archived-thread-count', { detail: threads.filter(thread => thread.archived && thread.id !== 'main').length })); }, [threads]);
  const current = visible.find(thread => thread.id === menu) || null;
  const row = thread => {
    const active = panel.activePanelId === PANEL && selectedTab === 'chat' && selected === thread.id;
    const session = sessions.byId[thread.sessionId], status = statuses.get(thread.sessionId);
    const running = status?.running ?? session?.running;
    const state = thread.archived ? 'archived' : !thread.sessionId ? 'idle' : status?.pendingInteraction ? 'pending' : running === true ? 'running' : running === false || status?.completionUnread ? 'idle' : 'unknown';
    const stateLabel = { archived: '已归档', pending: '待确认', running: '忙碌', idle: '空闲', unknown: '状态未知' }[state];
    const updatedAt = session?.updatedAt || thread.createdAt;
    const date = new Date(updatedAt), hasDate = !!updatedAt && !Number.isNaN(date.getTime());
    const today = new Date();
    const timeLabel = hasDate ? date.toDateString() === today.toDateString() ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) }) : '—';
    const archive = () => void mutate(async () => { await api('archiveThread', { threadId: thread.id, archived: !showArchived }); if (!showArchived && selected === thread.id) openAssistantThread(ctx, 'main'); });
    return <div className={`cmd-session-row ${showArchived ? 'is-archived' : ''} ${active ? 'is-selected' : ''}`} data-menu-open={menu === thread.id || undefined} key={thread.id}>
      <Button variant="ghost" type="button" className={`cmd-session ${active ? 'cmd-selected' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => { setMenu(null); openAssistantThread(ctx, thread.id); }}><span className="ba-thread-copy"><span className="ba-thread-title">{thread.title}</span><span className="ba-thread-meta"><Hint label={hasDate ? `${session?.updatedAt ? '最近活动' : '创建于'} ${date.toLocaleString('zh-CN')}` : '时间暂不可用'}><time className="ba-thread-time" dateTime={hasDate ? date.toISOString() : undefined}>{timeLabel}</time></Hint><span className="ba-thread-status" data-status={state}><i aria-hidden="true" />{stateLabel}</span></span></span></Button>
      <div className="ba-thread-actions">
        {!showArchived && <Hint label={thread.pinned ? '取消置顶' : '置顶'}><Button variant="ghost" type="button" className="cmd-session-quick" aria-label={thread.pinned ? '取消置顶' : '置顶会话'} aria-pressed={!!thread.pinned} disabled={saving} onClick={event => { event.stopPropagation(); void mutate(() => api('pinThread', { threadId: thread.id, pinned: !thread.pinned })); }}>{thread.pinned ? <IconPinFillMedium size={16} /> : <IconPinOutlineMedium size={16} />}</Button></Hint>}
        <Hint label={showArchived ? '取消归档' : '归档'}><Button variant="ghost" type="button" className="cmd-session-quick" aria-label={showArchived ? '取消归档对话' : '归档对话'} disabled={saving} onClick={event => { event.stopPropagation(); archive(); }}>{showArchived ? <IconArchiveOffOutlineMedium size={16} /> : <IconArchiveOutlineMedium size={16} />}</Button></Hint>
        {showArchived && <Hint label="删除"><Button variant="ghost" type="button" className="cmd-session-quick cmd-danger" aria-label="删除旁聊" disabled={saving} onClick={event => { event.stopPropagation(); void mutate(async () => { await api('deleteThread', { threadId: thread.id }); if (selected === thread.id) openAssistantThread(ctx, 'main'); }); }}><UIIcon name="trash" size={14} /></Button></Hint>}
        {!showArchived && <Hint label="对话操作"><Button variant="ghost" type="button" className="cmd-session-more" aria-label={'对话操作：' + thread.title} aria-expanded={menu === thread.id} aria-haspopup="menu" onClick={event => { menuAnchor.current = event.currentTarget; setMenu(menu === thread.id ? null : thread.id); }}><IconEllipsisOutlineMedium size={16} /></Button></Hint>}
      </div>
    </div>;
  };
  return <section className="ba-assistant-section" data-collapsed={!showArchived && !assistantExpanded} aria-label={'\u4e2a\u4eba\u52a9\u7406'}>{!showArchived && <div className="ba-card-row"><div className="ba-assistant-heading"><Hint label={mainLabel}><span className="ba-sidebar-main"><AssistantCard avatarSize={32} pet={config?.pet} name={name} html={config?.cardHtml} motion={config?.cardMotion !== false} action={mainAction} expression={petExpressionForAction(config?.pet, mainAction)} status={mainStatus} ariaLabel={mainLabel} current={panel.activePanelId === PANEL && selected === 'main' && selectedTab === 'chat'} onOpen={() => { setMenu(null); openAssistantThread(ctx, 'main'); }} /></span></Hint><Hint label="资源"><Button variant="ghost" type="button" className="ba-assistant-resources" aria-label="打开资源" aria-current={panel.activePanelId === PANEL && selectedTab === 'resources' ? 'page' : undefined} onClick={() => { setMenu(null); openAssistantTab(ctx, 'resources'); }}><UIIcon name="cube" size={16} /></Button></Hint><Hint label={assistantExpanded ? '\u6536\u8d77\u52a9\u624b' : '\u5c55\u5f00\u52a9\u624b'}><Button variant="ghost" type="button" className="ba-assistant-toggle" aria-label={assistantExpanded ? '\u6536\u8d77\u52a9\u624b' : '\u5c55\u5f00\u52a9\u624b'} aria-expanded={assistantExpanded} aria-controls={assistantBodyId} onClick={toggleAssistant}><UIIcon name="chevronDown" size={16} /></Button></Hint></div></div>}<div id={assistantBodyId} className="ba-assistant-body" hidden={!showArchived && !assistantExpanded}><div className="cmd-section-title"><Button variant="ghost" type="button" className="cmd-section-toggle" aria-expanded={expanded} aria-controls="cmd-assistant-section" onClick={() => setExpanded(!expanded)}><span>{showArchived ? '已归档旁聊' : '旁聊'}</span><UIIcon name="chevronDown" size={12} /></Button>{!showArchived && <Hint label="新旁聊"><Button variant="ghost" type="button" className="ba-section-add" aria-label="新建旁聊" disabled={creating} onClick={createThread}><UIIcon name="plus" size={16} /></Button></Hint>}</div><div id="cmd-assistant-section" className="cmd-section-body" data-open={expanded} inert={!expanded ? '' : undefined}><div className="cmd-section-inner" aria-busy={(!loaded && !loadError) || refreshing}>
      {visible.map(row)}
      {!loaded && !visible.length && !loadError && <div className="ba-sidebar-loading" role="status"><span className="ba-sidebar-loading-label">正在加载旁聊</span><div className="ba-sidebar-skeleton" aria-hidden="true"><span><i /><i /></span><span><i /><i /></span></div></div>}
      {loaded && !visible.length && !loadError && !error && <div className="ba-sidebar-state" data-kind="empty">{showArchived ? <ResourceState icon="archive" title="暂无归档旁聊" description="归档后的旁聊会保留在这里。" /> : <p className="ba-sidebar-quote">“或许你不需要我”</p>}</div>}
      {(loadError || error) && <div className="ba-sidebar-state" data-kind="error"><ResourceState kind="error" title={error ? '操作未完成' : loaded ? '旁聊暂时无法更新' : '旁聊加载失败'} description={error || '请检查连接后重试，已有对话会保留。'}><Button variant="ghost" type="button" disabled={refreshing} onClick={() => { setError(''); return refreshRef.current?.(true); }}><UIIcon name="refresh" size={14} />{refreshing ? '正在重试…' : error ? '重新加载' : '重试加载'}</Button></ResourceState></div>}
    </div></div></div><Menu open={!showArchived && assistantExpanded && !!current} onClose={() => { if (!saving) setMenu(null); }} anchor={null} getAnchorRect={() => menuAnchor.current?.getBoundingClientRect() ?? null} side="right" align="end" portal autoFocus compact listClassName="cmd-actions-popover">{current && <div className="cmd-session-actions">{!showArchived && <Button variant="ghost" type="button" role="menuitem" disabled={saving} onClick={() => void mutate(() => api('pinThread', { threadId: current.id, pinned: !current.pinned }))}>{current.pinned ? <IconPinFillMedium size={16} /> : <IconPinOutlineMedium size={16} />}<span>{current.pinned ? '取消置顶' : '置顶会话'}</span></Button>}<Button variant="ghost" type="button" role="menuitem" disabled={saving} onClick={() => { setRenameTarget(current); setMenu(null); }}><UIIcon name="edit" size={16} /><span>重命名</span></Button><div className="cmd-session-action-divider" role="separator" /><Button variant="ghost" type="button" role="menuitem" disabled={saving} onClick={() => void mutate(async () => { await api('archiveThread', { threadId: current.id, archived: !showArchived }); if (!showArchived && selected === current.id) openAssistantThread(ctx, 'main'); })}><IconArchiveOutlineMedium size={16} /><span>{showArchived ? '取消归档' : '归档对话'}</span></Button></div>}</Menu><AssistantRenameDialog target={renameTarget} onClose={() => setRenameTarget(null)} onError={setError} /></section>;
}
let catalogRequest;
function loadCatalog() {
  if (!catalogRequest) catalogRequest = api('catalog').catch(error => { catalogRequest = null; throw error; });
  return catalogRequest;
}
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
function Studio({ snapshot, ctx, execute, refresh, threadId, SessionProvider, renderSlot, active = true, initialSection = 'identity', initialIdentityTab = 'info', requestedTab, requestedTicket }) {
  const [section, setSection] = useState(initialSection), [dirtySections, setDirtySections] = useState([]), [taskTab, setTaskTab] = useState('tasks');
  useEffect(() => {
    if (['tasks', 'memory'].includes(requestedTab)) setSection(requestedTab);
    if (requestedTab === 'goals') { setSection('tasks'); setTaskTab('goals'); setCreatingGoal(false); }
    if (requestedTab === 'approvals') { setSection('tasks'); setTaskTab('approvals'); setCreatingGoal(false); }
    if (['models', 'pet'].includes(requestedTab)) setSection('identity');
  }, [requestedTab]);
  useEffect(() => {
    if (requestedTicket?.ticketId) { setSection('tasks'); setTaskTab('tasks'); setCreatingGoal(false); }
  }, [requestedTicket]);
  const taskTabsId = useId();
  const [creatingGoal, setCreatingGoal] = useState(false);
  const dirtyEditor = useDirtyRegistry((_dirty, keys) => setDirtySections(keys));
  const dirty = dirtySections.length > 0;
  useEffect(() => {
    if (!dirty) return;
    const guard = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  const groups = [
    { id: 'configuration', label: '配置', items: [['identity', '身份', 'userlib'], ['documents', '档案', 'document']] },
    { id: 'workspace', label: '工作区', items: [['tasks', '任务', 'experiment'], ['memory', '记忆', 'bulb'], ['artifacts', '产物', 'picture']] },
    { id: 'integrations', label: '接入', items: [['connections', '多平台', 'category'], ['vault', '保险库', 'lock'], ['permissions', '授权管理', 'lock']] },
    { id: 'system', label: '系统', items: [['system-files', '系统文件', 'code']] },
  ];
  const items = groups.flatMap(group => group.items);
  const current = items.find(([id]) => id === section) || items[0];
  const descriptions = {
    identity: '设定名字、形象与模型，让助手更懂你的工作方式。',
    documents: '整理关于你和助手的档案，作为每次协作的共同背景。',
    tasks: '跟进工单与持续目标，在审核中集中处理待授权操作。',
    memory: '留下值得记住的偏好、决定与经验。',
    artifacts: '查看、预览和管理助手交付的文件。',
    connections: '把助手接入常用平台，在熟悉的地方继续对话。',
    vault: '集中保管凭据，按需提供给指定工具。',
    permissions: '查看网站许可与动作记录，按需撤销授权。',
    'system-files': '浏览助手的运行文件与目录，查看原始记录。',
  };
  const choose = next => {
    if (next === section) return;
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
  return <div className="ba-studio"><aside className="ba-studio-nav"><div className="ba-studio-nav-title"><BrandLogo size={30} decorative /><div><strong>SuperAgent</strong><span>资源与设置</span></div></div><nav aria-label="资源分区">{groups.map(group => <div className="ba-studio-nav-group" key={group.id}><span className="ba-studio-nav-group-label">{group.label}</span>{group.items.map(([id, label, icon]) => <Button variant="ghost" type="button" key={id} aria-current={section === id ? 'page' : undefined} onClick={() => choose(id)}>{id === 'documents' ? <ResourceIcon name="document" size={16} /> : id === 'vault' ? <ResourceIcon name="key" size={16} /> : id === 'system-files' ? <ResourceIcon name="code" size={16} /> : <UIIcon name={icon} size={16} />}<span><b>{label}{dirtySections.includes(id) && <span className="ba-draft-dot" aria-label="未保存" title="未保存">●</span>}</b></span></Button>)}</div>)}</nav></aside><div className="ba-studio-mobile-nav"><label htmlFor="ba-studio-section">资源分区</label><CustomSelect id="ba-studio-section" aria-label="资源分区" value={section} onChange={choose} options={groups.flatMap(group => group.items.map(([id, label]) => ({ value: id, label: `${group.label} · ${label}${dirtySections.includes(id) ? ' · 未保存' : ''}` })))} /></div><div className="ba-studio-body"><header className="ba-studio-heading"><div><h1>{current[1]}</h1><p>{descriptions[section]}</p></div>{dirtySections.includes(section) && <span className="ba-studio-draft" role="status"><span aria-hidden="true" />草稿已保留</span>}</header>
    <div hidden={section !== 'identity'} style={section !== 'identity' ? { display: 'none' } : undefined}>{(section === 'identity' || dirtySections.includes('identity')) && <Identity snapshot={snapshot} execute={execute} refresh={refresh} onDirtyChange={dirtyEditor('identity')} initialTab={initialIdentityTab} requestedTab={requestedTab} onDesign={() => { petDesignIntent.request(threadId); openAssistantThread(ctx, threadId); }} />}</div>
    <div hidden={section !== 'documents'} style={section !== 'documents' ? { display: 'none' } : undefined}>{(section === 'documents' || dirtySections.includes('documents')) && <AssistantDocuments api={api} refresh={refresh} onDirtyChange={dirtyEditor('documents')} />}</div>
    <div hidden={section !== 'tasks'} style={section !== 'tasks' ? { display: 'none' } : undefined}>{(section === 'tasks' || dirtySections.includes('tasks')) && <section className="ba-group"><ResourceTabs tabs={[["tickets", "工单"], ["approvals", "审核"], ["goals", "持续目标"], ["evaluations", "待处置评估"]]} value={taskTab === 'tasks' ? 'tickets' : taskTab} onChange={next => { if (next !== taskTab && (!dirtySections.includes('tasks') || window.confirm('切换分类会放弃未保存的目标。'))) { setCreatingGoal(false); setTaskTab(next === 'tickets' ? 'tasks' : next); } }} label="工作分类" id={taskTabsId} /><div id={taskTabsId + '-panel'} role="tabpanel" aria-labelledby={taskTabsId + '-' + (taskTab === 'tasks' ? 'tickets' : taskTab)}>{taskTab === 'tasks' ? <Tickets api={api} onOpenExecution={execution => openExecutionSession(ctx, execution)} onSchedule={() => ctx.layout.selectPanel('schedules')} requestedTicket={requestedTicket} onDirtyChange={dirtyEditor('tasks')} onCreateGoal={() => { setCreatingGoal(true); setTaskTab('goals'); }} /> : taskTab === 'approvals' ? (active ? <ApprovalReview ctx={ctx} api={api} SessionProvider={SessionProvider} renderSlot={renderSlot} /> : null) : taskTab === 'goals' ? <Goals api={api} refresh={refresh} onDirtyChange={dirtyEditor('tasks')} initialCreating={creatingGoal} onViewTickets={() => { setCreatingGoal(false); setTaskTab('tasks'); }} /> : <Evaluations api={api} onDirtyChange={dirtyEditor('tasks')} />}</div></section>}</div>
    <div hidden={section !== 'memory'} style={section !== 'memory' ? { display: 'none' } : undefined}>{(section === 'memory' || dirtySections.includes('memory')) && <MemoryPage api={api} refresh={refresh} onDirtyChange={dirtyEditor('memory')} entries={snapshot.memories || []} threadId={threadId} />}</div>
    <div hidden={section !== 'artifacts'} style={section !== 'artifacts' ? { display: 'none' } : undefined}>{(section === 'artifacts' || dirtySections.includes('artifacts')) && <Artifacts api={api} />}</div>
    <div hidden={section !== 'connections'} style={section !== 'connections' ? { display: 'none' } : undefined}>{(section === 'connections' || dirtySections.includes('connections')) && <Connections api={api} onDirtyChange={dirtyEditor('connections')} />}</div>
    {section === 'permissions' && <ActionPermissions api={api} />}
    <div hidden={section !== 'vault'} style={section !== 'vault' ? { display: 'none' } : undefined}>{(section === 'vault' || dirtySections.includes('vault')) && <VaultSettingsSection onDirtyChange={dirtyEditor('vault')} />}</div>
    <div hidden={section !== 'system-files'} style={section !== 'system-files' ? { display: 'none' } : undefined}>{(section === 'system-files' || dirtySections.includes('system-files')) && <SystemFiles api={api} />}</div>
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
async function api(action, args = {}, signal) {
  const url = new URL('api/commander/assistant', document.baseURI);
  const order = assistantConfigSync.begin();
  const response = await readJsonResponse(await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args }), signal }), url);
  if (signal?.aborted && (action === 'state' || action === 'config')) signal.throwIfAborted();
  if (action === 'state') return { ...response, config: assistantConfigSync.accept(response.config, order) };
  if (['config', 'petApply', 'petRestore'].includes(action)) return assistantConfigSync.accept(response.config || response, order);
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
function ModelFields({ value = {}, onChange }) {
  const [catalog, setCatalog] = useState({ providers: [], models: [] }), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => { let active = true; setLoading(true); loadCatalog().then(next => { if (active) { setCatalog(next); setError(''); } }).catch(cause => { if (active) setError(cause.message); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [revision]);
  const providers = catalog.providers.map(provider => ({ value: provider.id, label: (provider.name || provider.id) + (provider.available === false ? ' · 不可用' : '') }));
  const models = catalog.models.filter(model => !value.providerId || model.provider === value.providerId).map(model => ({ value: model.id, label: model.name || model.id }));
  return <><div className="ba-model-fields"><Picker label="供应商" value={value.providerId || ''} options={providers} placeholder="选择供应商" allowCustom onChange={providerId => onChange({ ...value, providerId })} /><Picker label="模型" value={value.modelId || ''} options={models} placeholder="选择模型" allowCustom onChange={modelId => onChange({ ...value, modelId })} /></div>{loading ? <p className="ba-model-feedback" role="status"><UIIcon name="refresh" size={15} /><span>正在读取模型目录…</span></p> : error ? <p className="ba-model-feedback" data-error="true" role="alert"><span>模型目录加载失败：{error}。可手动填写完整 ID。</span><Button variant="ghost" type="button" className="ba-quiet" onClick={() => { catalogRequest = null; setRevision(value => value + 1); }}>重试</Button></p> : !providers.length && <p className="ba-model-feedback" role="status"><UIIcon name="server" size={15} /><span>目录中还没有供应商。可先在模型设置中配置，或填写已有供应商与模型的完整 ID。</span></p>}</>;
}
function Identity({ snapshot, execute, refresh, onDirtyChange, initialTab = 'info', onDesign, requestedTab }) {
  const [config, setConfig] = useState(snapshot.config), [baseConfig, setBaseConfig] = useState(snapshot.config);
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState(''), [tab, setTab] = useState(initialTab);
  const tabsId = useId();
  const [editorReset, setEditorReset] = useState(0);
  useEffect(() => { if (['models', 'pet'].includes(requestedTab)) setTab(requestedTab); }, [requestedTab]);
  const patch = identityConfigPatch(config, baseConfig);
  const dirty = Object.keys(patch).length > 0;
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) { setConfig(snapshot.config); setBaseConfig(snapshot.config); }
  }, [snapshot.config, snapshot.profile?.identity]);
  const change = update => { setConfig(value => ({ ...value, ...update })); setSaved(''); };
  async function save(event) {
    event?.preventDefault(); if (busy || !dirty) return;
    setBusy(true); setSaved('');
    try { await execute(async () => {
      if (Object.keys(patch).length) {
        const response = await saveConfigPatch(api, baseConfig, patch);
        const next = response.config || response; setConfig(next); setBaseConfig(next);
      }
      setSaved('已保存');
      // The config response already updates every subscriber; a state refresh is
      // independent, so a later network failure cannot turn a successful save into failure.
      void refresh().catch(cause => setSaved('已保存；刷新失败：' + cause.message));
    }); } finally { setBusy(false); }
  }
  return <form className="ba-identity-pane" onSubmit={save}><ResourceTabs tabs={[['info', '信息'], ['pet', '形象'], ['models', '模型']]} value={tab} onChange={setTab} label="身份分类" id={tabsId} /><fieldset disabled={busy} id={tabsId + '-panel'} role="tabpanel" aria-labelledby={tabsId + '-' + tab} className="ba-identity-panel" data-tab={tab}>
    {tab === 'info' ? <><section className="ba-identity-info"><div className="ba-identity-name"><div className="ba-settings-section-heading"><h2>如何称呼你的助手</h2><p>这个名字会显示在名片和对话中。</p></div><Field label="名字"><input placeholder="未命名（可选）" maxLength={100} value={config.name || ''} onChange={event => change({ name: event.target.value })} /></Field></div><IdentityCardEditor key={`${baseConfig.revision}:${editorReset}`} config={config} onChange={change} defaultName={DEFAULT_NAME} /></section></> : tab === 'pet' ? <PetSettings api={api} config={snapshot.config} onChanged={refresh} onDesign={onDesign} /> : <ModelSettings config={config} onChange={change} ModelFields={ModelFields} IconButton={IconButton} />}
  </fieldset>{(tab !== 'pet' || dirty) && <footer className="ba-identity-save" data-dirty={dirty}><span role="status"><UIIcon name={dirty ? 'edit' : 'check'} size={16} />{saved || (dirty ? '有未保存的修改' : '修改后保存生效')}</span><div className="ba-row-actions">{dirty && <Button variant="ghost" type="button" className="ba-quiet" disabled={busy} onClick={() => { if (!window.confirm('取消会放弃未保存的身份修改。')) return; const latest = assistantConfigSync.getSnapshot() || snapshot.config; setConfig(latest); setBaseConfig(latest); setEditorReset(value => value + 1); setSaved(''); }}>取消修改</Button>}<Button variant="default" type="submit" className="ba-primary" disabled={busy || !dirty}>{busy ? '保存中…' : '保存更改'}</Button></div></footer>}</form>;
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
export function AssistantPage({ ctx, SessionProvider, renderSlot }) {
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
  const current = useRef(threadId), epoch = useRef(0), latestRequest = useRef(0);
  const setHistory = value => { if (!value.threadId || value.threadId === current.current) replaceHistory(previous => mergeHistory(previous, value)); };
  const refreshHistory = async (id, signal) => {
    const requestEpoch = epoch.current, request = ++latestRequest.current;
    await api('ensure', { threadId: id }, signal);
    const value = await api('history', { threadId: id }, signal);
    if (current.current === id && epoch.current === requestEpoch && latestRequest.current === request) setHistory(value);
  };
  const loadEarlier = async () => {
    if (!history.hasMore || history.nextBefore == null) return;
    const id = threadId, requestEpoch = epoch.current;
    const page = await api('history', { threadId: id, before: history.nextBefore });
    if (current.current === id && epoch.current === requestEpoch) replaceHistory(previous => mergeHistory(previous, page, true));
  };
  const retained = useRef(new Map());
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
    const sessions = new Map((snapshot?.state?.threads || []).filter(thread => thread.sessionId && !thread.archived).map(thread => [thread.sessionId, thread.id]));
    if (snapshot?.state?.mainSessionId) sessions.set(snapshot.state.mainSessionId, 'main');
    const historyThreadId = history.threadId || threadId;
    if (history.sessionId && (historyThreadId === 'main' || snapshot?.state?.threads?.some(thread => thread.id === historyThreadId && !thread.archived))) sessions.set(history.sessionId, historyThreadId);
    for (const [sessionId, scope] of retained.current) if (!sessions.has(sessionId)) { scope.release(); retained.current.delete(sessionId); }
    for (const [sessionId, id] of sessions) void ensureScope(sessionId, id).catch(cause => { console.warn('[BenchGo] background session connection failed', cause); });
  }, [snapshot?.state?.threads, snapshot?.state?.mainSessionId, history.sessionId, history.threadId, threadId]);
  current.current = threadId;
  const stateRequest = useRef(0);
  const refresh = async (signal) => { const request = ++stateRequest.current; const value = await api('state', {}, signal); if (request === stateRequest.current) setSnapshot({ ...value, config: assistantConfigSync.getSnapshot() || value.config }); return value; };
  const execute = async (operation) => { try { setError(''); await operation(); return true; } catch (cause) { setError(cause.message || String(cause)); return false; } };
  const retryLoad = async () => { try { setError(''); await refresh(); if (tab === 'chat') await refreshHistory(threadId); } catch (cause) { setError(cause.message || String(cause)); } };
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
          if (current.current === 'main') await refreshHistory('main');
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
    let disposed = false, timer; const controller = new AbortController();
    const tick = async () => {
      const active = !document.hidden && (!ctx?.layout?.panelInfo || ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL);
      if (active) try {
        await refresh(controller.signal);
        if (!disposed && tab === 'chat') await refreshHistory(threadId, controller.signal);
      } catch (cause) { if (!disposed) setError(cause.message); }
      if (!disposed) timer = setTimeout(tick, 1500);
    };
    tick(); return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [threadId, tab, ctx]);
  const select = (id) => { const next = id || 'main'; selectedAssistantThread = next; setTab('chat'); if (current.current === next) return; epoch.current++; current.current = next; setThreadId(next); replaceHistory({ messages: [], running: false }); };
  const threads = snapshot?.state?.threads || [];
  const selected = threads.find(thread => thread.id === threadId);
  const view = tab === 'chat' ? 'chat' : 'studio';
  return <ActivityProvider><div className="ba-root"><main className="ba-main">{error && snapshot && <div className="ba-error" role="alert"><span>{error}</span><Button variant="ghost" type="button" onClick={retryLoad}>重试加载</Button><IconButton icon="close" label="关闭错误" onClick={() => setError('')} /></div>}{snapshot && <PendingInteractions ctx={ctx} currentSessionId={tab === 'chat' ? history.sessionId : undefined} threads={[...(snapshot.state.mainSessionId && !threads.some(thread => thread.id === 'main') ? [{ id: 'main', title: '主聊天', sessionId: snapshot.state.mainSessionId }] : []), ...threads.filter(thread => thread.sessionId), ...(!threads.some(thread => thread.sessionId === history.sessionId) && history.sessionId ? [{ id: threadId, title: selected?.title, sessionId: history.sessionId }] : [])]} />}{!snapshot ? <div className="ba-resource-initial"><ResourceState kind={error ? 'error' : 'loading'} title={error ? '暂时无法加载助手' : '正在准备助手'} description={error || '正在读取配置与资源，请稍候。'} onAction={error ? retryLoad : undefined} /></div> : <><RetainedPane active={view === 'studio'}><Studio active={view === 'studio'} requestedTab={tab} requestedTicket={requestedTicket} initialSection={['tasks', 'memory'].includes(tab) ? tab : 'identity'} initialIdentityTab={['models', 'pet'].includes(tab) ? tab : 'info'} snapshot={snapshot} ctx={ctx} execute={execute} refresh={refresh} threadId={threadId} SessionProvider={SessionProvider} renderSlot={renderSlot} /></RetainedPane>{view === 'chat' && <>{!snapshot.config.models?.length && <ModelSetupNotice onOpen={() => { selectedAssistantTab = 'models'; setTab('models'); }} />}<HistoryNotice history={history} threadId={threadId} onClear={clearMain} />{history.sessionId ? <AssistantConversation onOpenExecution={execution => openExecutionSession(ctx, execution)} key={threadId} ctx={ctx} sessionId={history.sessionId} threadId={threadId} history={history} onLoadEarlier={loadEarlier} onRefresh={() => refreshHistory(threadId)} SessionProvider={SessionProvider} renderSlot={renderSlot} api={api} assistantName={snapshot.config.name} assistantConfig={snapshot.config} petExpression={snapshot.petExpression} onOpenResources={(next, selection) => openAssistantTab(ctx, next, selection)} /> : <div className="ba-empty" role="status">正在打开{threadId === 'main' ? '主聊天' : '旁聊'}…</div>}<Images images={history.images} /></>}</>}</main>{snapshot && tab === 'chat' && <ActivityPanel api={api} assistantConfig={snapshot.config} onOpenResources={(next, selection) => openAssistantTab(ctx, next, selection)} />}</div></ActivityProvider>;
}
export function mountAssistant(ctx) {
  mountAssistantConversation(ctx);
  mountApprovalReview(ctx);
  const loadExecutionSessions = async signal => (await api('executionSessions', {}, signal)).sessions || [];
  registerExecutionSessionDiscovery(ctx, loadExecutionSessions);
  registerExecutionSessionRows(ctx, loadExecutionSessions);
  registerChannelSessionRows(ctx);
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

