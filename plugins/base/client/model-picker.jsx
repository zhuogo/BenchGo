import { Loading } from '../../shared/client/ui/loading.jsx';
import { readJsonResponse } from './http-response.mjs';
import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { moduleSource } from './modules.mjs';
import { pickerCatalog, invalidateModelCatalogs, mountModelCatalogs } from './model-catalog.mjs';
import { createPortal } from 'react-dom';
import { UIIcon } from './iconsax.jsx';
import { Tooltip } from '../../shared/client/ui/tooltip.jsx';
import { ProviderBrandIcon } from './provider-brand-icon.jsx';
import { isRouterGo, prioritizeRouterGo } from './provider-options.mjs';
import { routerGo } from '../shared/builtin-providers.mjs';
import { ToolBrandIcon } from './tool-brand-icon.jsx';
import { availableTools, currentToolId, providersForTool, selectionReasoningEffort } from './model-picker-state.mjs';
import css from './model-picker.css';
import effortCss from './model-effort-picker.css';
import { ModelEffortPicker } from './model-effort-picker.jsx';
import { nativeActivityLabel } from './native-activity.mjs';
import { openSettingsSection } from './settings-shell.mjs';
import { IconPinOutlineRegular, IconPinFillRegular } from '@deepseek-ai/dsh-client-ui-primitives';

function sameModelBinding(previous, next) {
  return previous !== null && previous.bound === next.bound && previous.id === next.id
    && previous.provider === next.provider && previous.model === next.model
    && previous.route?.providerId === next.route?.providerId && previous.route?.model === next.route?.model;
}

function sameSelection(a, b) {
  return a?.provider === b?.provider && a?.model === b?.model && a?.reasoningEffort === b?.reasoningEffort;
}

const emptySelectionProjection = { subscribe: () => () => {}, getSnapshot: () => undefined };

/** Selection, permissions and persistence stay with the official directory. */
export function mountModelPicker(ctx) {
  mountModelCatalogs(ctx);
  ctx.effect(() => moduleSource.subscribe(invalidateModelCatalogs));
  const style = document.createElement('style'); style.textContent = css + effortCss; document.head.append(style);
  ctx.effect(() => () => style.remove());
  ctx.slots.inject('conversation.input.model', () => ctx.slots.register({
    name: 'conversation.input.model', priority: -10,
    inject: sessionId => {
      const directory = ctx.modelDirectories.directoryFor(sessionId);
      const selectionProjection = ctx.sessions.binding(sessionId)?.session.projections.faceOf('modelSelection');
      return { sessionId, selectionProjection, available: ctx.sessions.subagentAddress(sessionId) === undefined, hooks: { directory: directory.store }, load: () => directory.load(), select: selection => directory.select(selection), startNewSession: async () => {
        const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(sessionId));
        const next = await ctx.sessions.create(workspace ? { workspaceId: workspace.workspaceId } : undefined);
        ctx.uiWorkspace.openSession(next);
      }, binding: async () => {
        const response = await fetch(new URL('api/commander', document.baseURI), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'binding', harnessSessionId: sessionId }) });
        const value = await readJsonResponse(response, new URL('api/commander', document.baseURI)); if (value.error) throw Error(value.error || '会话绑定状态读取失败'); return value;
      } };
    },
  }, props => <ModelPicker key={props.sessionId} {...props} />));
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'commander-model-empty', order: -30,
    inject: sessionId => {
      const directory = ctx.modelDirectories.directoryFor(sessionId);
      return { sessionId, available: ctx.sessions.subagentAddress(sessionId) === undefined, hooks: { directory: directory.store }, binding: async () => {
        const response = await fetch(new URL('api/commander', document.baseURI), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'binding', harnessSessionId: sessionId }) });
        const value = await readJsonResponse(response, new URL('api/commander', document.baseURI)); if (value.error) throw Error(value.error || '会话绑定状态读取失败'); return value;
      }, openSettingsSection: id => openSettingsSection(ctx.slots, id) };
    },
  }, ModelEmptyBanner));
}

export function mountNativeActivity(ctx) {
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'commander-native-activity', order: -20,
    inject: sessionId => ({ sessionId }),
  }, NativeActivity));
}

function NativeActivity({ sessionId }) {
  const [activity, setActivity] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    let active = true, timer, nativeId, cursor = 0, events = [];
    const request = async body => {
      const response = await fetch(new URL('api/commander', document.baseURI), { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const value = await readJsonResponse(response, new URL('api/commander', document.baseURI)); if (value.error) throw Error(value.error || '读取原生工具活动失败'); return value;
    };
    const tick = async () => {
      try {
        if (!nativeId) {
          const binding = await request({ action: 'binding', harnessSessionId: sessionId });
          if (!active) return;
          if (!binding.bound) { timer = setTimeout(tick, 2000); return; }
          nativeId = binding.id; cursor = Math.max(0, (binding.cursor || 0) - 40);
        }
        const value = await request({ action: 'events', id: nativeId, after: cursor });
        if (!active) return;
        cursor = value.cursor;
        events = [...events, ...(value.events || [])].slice(-20);
        const rows = events.map(nativeActivityLabel).filter(Boolean).slice(-8);
        if (rows.length) setActivity({ provider: value.session.provider, status: value.session.status, rows });
        if (['running', 'waiting', 'connecting'].includes(value.session.status)) timer = setTimeout(tick, 700);
        else if (!rows.length) setActivity(null);
      } catch { if (active) timer = setTimeout(tick, 2500); }
    };
    void tick();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [sessionId]);
  if (!activity) return null;
  return <section className="cmd-native-activity" aria-label="原生工具活动" aria-live="polite">
    <header><span>{activity.provider === 'codex' ? 'Codex' : activity.provider} 活动</span><span>{activity.status === 'running' ? '运行中' : activity.status === 'waiting' ? '等待确认' : activity.status === 'connecting' ? '连接中' : '已完成'}</span></header>
    <ol>{activity.rows.map((row, index) => <li key={index} data-state={row.state}><span>{row.label}</span>{row.detail && <code>{row.detail}</code>}</li>)}</ol>
  </section>;
}

function ModelEmptyBanner({ sessionId, available, useDirectory, binding, openSettingsSection }) {
  const modules = useSyncExternalStore(moduleSource.subscribe, moduleSource.getSnapshot);
  const state = useDirectory(value => value);
  const catalogRevision = useSyncExternalStore(pickerCatalog.subscribe, pickerCatalog.getSnapshot);
  const [catalog, setCatalog] = useState(null), [catalogError, setCatalogError] = useState(''), [sessionBinding, setSessionBinding] = useState(null);
  const currentTool = currentToolId(state.current?.provider);
  const harnessUnavailable = !modules.harness && currentTool !== 'deepseek';
  useEffect(() => {
    if (!modules.harness) { setSessionBinding({ bound: false }); return; }
    let active = true, timer;
    const refreshBinding = async () => {
      try { const value = await binding(); if (active) setSessionBinding(previous => sameModelBinding(previous, value) ? previous : value); }
      catch { if (active) setSessionBinding(null); }
      finally { if (active) timer = setTimeout(refreshBinding, 2000); }
    };
    void refreshBinding();
    return () => { active = false; clearTimeout(timer); };
  }, [sessionId, modules.harness]);
  useEffect(() => {
    let active = true;
    setCatalogError('');
    pickerCatalog.load().then(value => { if (active) setCatalog(value); }).catch(reason => { if (active) setCatalogError(reason.message); });
    return () => { active = false; };
  }, [catalogRevision, modules.harness]);
  const hasModels = useMemo(() => providersForTool(state.groups, catalog, currentTool).some(entry => entry.models.length > 0), [state.groups, catalog, currentTool]);
  const noProvider = available && catalog !== null && !catalogError && !hasModels && !sessionBinding?.bound;
  if (!noProvider && !harnessUnavailable) return null;
  return <div className="cmd-model-empty" role="status"><span>{harnessUnavailable ? 'Harness 聚合未启用，请启用模块或切换模型' : '无模型可用，请先配置模型供应商'}</span>{!harnessUnavailable && <button type="button" aria-label="前往配置模型供应商" onClick={() => openSettingsSection('models')}><UIIcon name="external" size={13} />前往</button>}</div>;
}

function ModelPicker({ sessionId, locked, available, useDirectory, selectionProjection = emptySelectionProjection, load, select, binding, startNewSession }) {
  const modules = useSyncExternalStore(moduleSource.subscribe, moduleSource.getSnapshot);
  const state = useDirectory(value => value);
  const projected = useSyncExternalStore(selectionProjection.subscribe, selectionProjection.getSnapshot);
  const catalogRevision = useSyncExternalStore(pickerCatalog.subscribe, pickerCatalog.getSnapshot);
  const [open, setOpen] = useState(false), [tool, setTool] = useState('deepseek'), [provider, setProvider] = useState(null), [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState(() => pickerCatalog.peek()), [catalogLoading, setCatalogLoading] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false), [position, setPosition] = useState(null), [error, setError] = useState(''), [catalogError, setCatalogError] = useState('');
  const [sessionBinding, setSessionBinding] = useState(null), [bindingError, setBindingError] = useState('');
  const [optimistic, setOptimistic] = useState(null);
  const [saving, setSaving] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [pinnedModels, setPinnedModels] = useState(() => { try { return JSON.parse(localStorage.getItem('commander.pinned-models') || '{}') || {}; } catch { return {}; } });
  const trigger = useRef(null), menu = useRef(null), search = useRef(null), selecting = useRef(false), toolTrigger = useRef(null);
  // The directory combines the catalog and session state on different schedules.
  const saved = projected?.next ?? state.current;
  const preview = optimistic && (saving || sameSelection(saved, optimistic.previous)) ? optimistic.selection : null;
  const current = state.pending ?? preview ?? saved;
  const id = useId(), currentTool = currentToolId(current?.provider);
  const harnessUnavailable = !modules.harness && currentTool !== 'deepseek';
  const entries = availableTools(catalog).map(entry => entry.id === 'deepseek' || modules.harness ? entry : { ...entry, routeSupported: false, routeReason: 'Harness 聚合未启用' }), activeTool = entries.find(entry => entry.id === tool);
  const currentGroup = state.groups.find(group => group.id === current?.provider);
  const currentModel = currentGroup?.models.find(model => model.id === current?.model);
  const busy = saving || !!state.pending || state.status === 'selecting';
  const loading = (state.status === 'loading' && !state.groups.length) || catalogLoading;
  useEffect(() => {
    if (optimistic && !preview) setOptimistic(null);
  }, [optimistic, preview]);
  useEffect(() => {
    if (!modules.harness) { setSessionBinding({ bound: false }); setBindingError(''); return; }
    let active = true;
    let timer;
    const refreshBinding = async () => {
      try { const value = await binding(); if (active) { setSessionBinding(previous => sameModelBinding(previous, value) ? previous : value); setBindingError(''); } }
      catch (reason) { if (active) setBindingError(reason.message); }
      finally { if (active) timer = setTimeout(refreshBinding, 2000); }
    };
    setSessionBinding(null); setBindingError('');
    void refreshBinding();
    return () => { active = false; clearTimeout(timer); };
  }, [sessionId, modules.harness]);
  const modelLocked = locked || (typeof binding === 'function' && (sessionBinding === null || !!bindingError || !!sessionBinding?.bound && !sessionBinding?.route?.providerId));
  const boundTool = sessionBinding?.bound ? sessionBinding.provider : null;
  const boundProvider = sessionBinding?.bound ? sessionBinding.route?.providerId : null;
  const toolLocked = modelLocked || !!boundTool;
  const bindingHint = harnessUnavailable ? 'Harness 聚合未启用，请启用模块或切换模型' : bindingError || (sessionBinding?.bound && !sessionBinding?.route?.providerId ? '此会话没有有效的 API 绑定' : sessionBinding?.bound ? '当前会话可在已选工具和供应商内切换模型' : sessionBinding === null ? '正在确认会话绑定状态…' : '');
  const close = () => { setOpen(false); setProvider(null); setToolsOpen(false); setQuery(''); };
  const refresh = () => { setError(''); pickerCatalog.invalidate(); void load().catch(reason => setError(reason.message)); };
  useEffect(() => {
    let active = true;
    setCatalogLoading(pickerCatalog.peek() === null); setCatalogError('');
    pickerCatalog.load().then(value => {
      if (!active) return;
      setCatalog(value);
    }).catch(reason => { if (active) setCatalogError(reason.message); }).finally(() => { if (active) setCatalogLoading(false); });
    return () => { active = false; };
  }, [catalogRevision]);
  useEffect(() => {
    if (!open) return;
    const place = event => {
      if (event?.type === 'scroll' && menu.current?.contains(event.target)) return;
      const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
      const width = Math.min(368, window.innerWidth - 24), below = window.innerHeight - rect.bottom, above = rect.top, topSide = above > below;
      const next = { position: 'fixed', width, left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), ...(topSide ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }), maxHeight: Math.max(100, Math.min(520, (topSide ? above : below) - 20)) };
      setPosition(previous => previous && Object.keys(next).every(key => next[key] === previous[key]) ? previous : next);
    };
    place();
    const outside = event => { if (!menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) close(); };
    const key = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (toolsOpen) { setToolsOpen(false); toolTrigger.current?.focus(); } else { close(); trigger.current?.focus(); } } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key, true); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key, true); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, toolsOpen]);
  useEffect(() => { if (open && !toolsOpen) search.current?.focus(); }, [open, provider, toolsOpen]);
  useEffect(() => { if (toolsOpen) menu.current?.querySelector('.cmd-model-tool-menu button[aria-checked="true"]')?.focus(); }, [toolsOpen]);
  const choose = async (group, model, effort, keepOpen = false) => {
    if (busy || selecting.current || modelLocked || catalogLoading || !catalog || catalogError) return;
    if (!modules.harness && currentToolId(group.id) !== 'deepseek') { setError('Harness 聚合未启用'); return; }
    setError('');
    try {
      if (currentToolId(group.id) !== 'deepseek' && !catalog.routes.some(row => row.modelId === model.id && 'commander-' + row.tool === group.id)) throw Error('此工具、供应商和模型组合当前不可用，请重新选择');
      const reasoningEffort = selectionReasoningEffort(group.id, model, current, effort);
      const selection = { provider: group.id, model: model.id, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
      selecting.current = true;
      setSaving(true);
      setOptimistic(sameSelection(selection, saved) ? null : { previous: saved, selection });
      const result = await select(selection);
      if (!result?.ok) throw new Error(result?.error?.message ?? '模型选择不可用');
      if (!keepOpen) { close(); trigger.current?.focus(); }
    } catch (reason) { setOptimistic(null); setError(reason.message); }
    finally { selecting.current = false; setSaving(false); }
  };
  const modelKey = (group, model) => `${group.id}/${model.id}`;
  const isPinned = (group, model) => pinnedModels[modelKey(group, model)] === true;
  const toggleModelPin = (group, model, event) => {
    event.stopPropagation();
    const next = { ...pinnedModels, [modelKey(group, model)]: !isPinned(group, model) };
    try { localStorage.setItem('commander.pinned-models', JSON.stringify(next)); } catch { /* Storage may be unavailable. */ }
    setPinnedModels(next);
  };
  const currentProviders = useMemo(() => providersForTool(state.groups, catalog, currentTool), [state.groups, catalog, currentTool]);
  const providerRows = useMemo(() => tool === currentTool ? currentProviders : providersForTool(state.groups, catalog, tool), [state.groups, catalog, tool, currentTool, currentProviders]);
  const routerRow = catalog?.providers?.find(row => isRouterGo(row.id));
  const routerReason = boundProvider && !isRouterGo(boundProvider) ? '当前会话已绑定其他供应商' : catalogError ? '供应商目录读取失败' : loading || !catalog ? '正在读取供应商目录…' : routerRow ? routerRow.unavailableTools?.[tool] || routerRow.unavailableReason || '暂无兼容模型' : '请先在模型设置中配置 RouterGo';
  const providers = prioritizeRouterGo(providerRows.filter(item => !boundProvider || item.id === boundProvider), { ...routerGo, models: [], reason: routerReason });
  const selectedProvider = providers.find(item => item.id === provider);
  const searchText = query.trim().toLowerCase();
  const matches = text => text.toLowerCase().includes(searchText);
  const visibleProviders = providers.filter(item => isRouterGo(item.id) || matches(item.name + ' ' + item.id));
  const models = (selectedProvider?.models || []).filter(({ model, nativeModelId }) => matches(model.name + ' ' + (nativeModelId || model.id))).sort((a, b) => Number(isPinned(b.group, b.model)) - Number(isPinned(a.group, a.model)));
  const activeEffort = current?.reasoningEffort ?? currentModel?.reasoning?.defaultEffort;
  const currentProviderEntry = currentProviders.find(entry => entry.models.some(({ group, model }) => group.id === current?.provider && model.id === current?.model));
  const currentRoute = catalog?.routes?.find(row => row.modelId === current?.model && ('commander-' + row.tool === current?.provider || (row.tool === 'deepseek' && current?.provider === row.providerId)));
  const currentProviderId = currentProviderEntry?.id || currentRoute?.providerId || boundProvider || (currentTool === 'deepseek' ? current?.provider : undefined);
  const effortModel = currentModel ? { group: currentGroup, model: currentModel, providerName: currentProviderEntry?.name || currentRoute?.providerName || currentGroup?.name || currentGroup?.id } : null;
  const effortOptions = effortModel?.model.reasoning?.efforts || [];
  const commitEffort = effort => {
    if (effortModel && effort !== activeEffort) void choose(effortModel.group, effortModel.model, effort, true);
  };
  const effortName = effortOptions.find(effort => effort.id === activeEffort)?.name ?? activeEffort;
  const effortUnsupported = !busy && !catalogLoading && state.status === 'ready' && currentModel && current?.reasoningEffort !== undefined
    && !effortOptions.some(effort => effort.id === current.reasoningEffort);
  const failures = state.failures?.filter(group => tool === 'deepseek' ? !group.id?.startsWith('commander-') : group.id === 'commander-' + tool) || [];
  const noProvider = !harnessUnavailable && catalog !== null && !catalogError && !currentProviders.some(entry => entry.models.length) && !sessionBinding?.bound;
  const sendUnavailable = noProvider || harnessUnavailable;
  const modelLabel = noProvider ? '无模型可用' : currentModel?.name ?? current?.model ?? '选择模型';
  useEffect(() => {
    if (!sendUnavailable) { delete document.documentElement.dataset.commanderNoProvider; return; }
    document.documentElement.dataset.commanderNoProvider = 'true';
    const blockSend = event => {
      const send = event.target.closest?.('[class*="_primary"], [aria-label="发送消息"]');
      if (!send || event.target.closest?.('.cmd-model-empty')) return;
      event.preventDefault(); event.stopPropagation();
    };
    const blockEnter = event => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      if (!event.target.closest?.('[data-composer-card]')) return;
      event.preventDefault(); event.stopPropagation();
    };
    document.addEventListener('click', blockSend, true);
    document.addEventListener('keydown', blockEnter, true);
    return () => { delete document.documentElement.dataset.commanderNoProvider; document.removeEventListener('click', blockSend, true); document.removeEventListener('keydown', blockEnter, true); };
  }, [sendUnavailable]);
  const message = error || catalogError || state.error || failures.map(group => group.message).join('；');
  const onMenuKey = event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const scope = toolsOpen ? menu.current.querySelector('.cmd-model-tool-menu') : menu.current;
    const buttons = [...scope.querySelectorAll('button:not(:disabled),input')], current = buttons.indexOf(document.activeElement), direction = event.key === 'ArrowDown' ? 1 : -1;
    event.preventDefault(); buttons[(current + direction + buttons.length) % buttons.length]?.focus();
  };
  const effortUnavailable = modelLocked || catalogLoading || !catalog || !!catalogError || !modules.harness && currentTool !== 'deepseek';
  const createNewSession = async () => {
    setCreatingSession(true);
    setError('');
    try { await startNewSession(); close(); }
    catch (reason) { setError(reason.message); }
    finally { setCreatingSession(false); }
  };
  return <>
    <Tooltip label={noProvider ? '无模型可用，请先配置模型供应商' : modelLabel + (effortName ? ' · ' + effortName : '') + (bindingHint ? '。' + bindingHint : '')} portal><button ref={trigger} type="button" className="cmd-model-trigger" data-empty={noProvider || undefined} disabled={modelLocked || !available} aria-label={noProvider ? '无模型可用，请先配置模型供应商' : '选择工具与模型，当前 ' + (entries.find(item => item.id === currentTool)?.name ?? currentTool) + ' ' + (currentModel?.name ?? current?.model ?? '') + (sessionBinding?.bound ? '。可在当前工具和供应商内切换模型' : bindingHint ? '。' + bindingHint : '')} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => { if (open) close(); else { setError(''); setTool(currentTool); setOpen(true); } }}>
      {currentProviderId && !noProvider && <ProviderBrandIcon id={currentProviderId} name={currentProviderEntry?.name || currentRoute?.providerName || currentGroup?.name} declared={currentProviderEntry?.declared} size={16} />}<span className="cmd-model-caption">{modelLabel}{!noProvider && effortName ? ' · ' + effortName : ''}</span><UIIcon name="chevronDown" size={14} />
    </button></Tooltip>
    {open && position && createPortal(<div ref={menu} id={id} role="dialog" aria-label="工具与模型" aria-busy={catalogLoading} className="cmd-model-popup" style={position} onKeyDown={onMenuKey}>
      {catalogLoading && !catalog && <Loading className="cmd-model-loading-overlay" label="正在加载模型目录" />}
      <div className="cmd-model-provider-card"><header className="cmd-model-header">
        {provider ? <button type="button" className="cmd-model-back" aria-label="返回供应商列表" disabled={busy} onClick={() => { setProvider(null); setQuery(''); }}><UIIcon name="chevronLeft" size={16} /><span>{selectedProvider?.name || '供应商'}</span></button> : <span className="cmd-model-heading">选择供应商</span>}
        <Tooltip label={boundTool ? '当前工具为 ' + boundTool + '，只能切换该工具的模型' : '选择 Harness 工具'} portal><button ref={toolTrigger} type="button" className="cmd-model-tool-trigger" aria-label="选择 Harness 工具" aria-haspopup="menu" aria-expanded={toolsOpen} disabled={busy || toolLocked} onClick={() => setToolsOpen(value => !value)}><ToolBrandIcon tool={tool} size={18} muted={!activeTool?.available || !activeTool?.routeSupported} /><span>{activeTool?.name || (catalogLoading ? '识别工具…' : tool)}</span><UIIcon name="chevronDown" size={13} /></button></Tooltip>
      </header>
      {toolsOpen && <div className="cmd-model-tool-menu" role="menu" aria-label="Harness 工具">{entries.map(entry => {
        const unavailable = !entry.routeSupported || !entry.available;
        const unavailableReason = entry.routeReason || (entry.available === false ? '当前工具不可启动' : '当前没有兼容的 API 路由');
        return <button key={entry.id} type="button" role="menuitemradio" disabled={toolLocked || unavailable} aria-checked={tool === entry.id} className={tool === entry.id ? 'is-selected' : ''} onClick={() => { setTool(entry.id); setProvider(null); setQuery(''); setToolsOpen(false); }}><ToolBrandIcon tool={entry.id} size={20} muted={entry.installed === false || unavailable} /><span>{entry.name}{unavailable && <small>{unavailableReason}</small>}</span>{tool === entry.id && <UIIcon name="check" size={16} />}</button>;
      })}<small>{boundTool ? `当前工具为 ${boundTool}，只能切换该工具的模型` : '选择安装并具备兼容 API 路由的工具'}</small></div>}
      <label className="cmd-model-search"><UIIcon name="search" size={16} /><input ref={search} type="search" autoComplete="off" spellCheck={false} aria-label={provider ? '搜索模型' : '搜索供应商'} placeholder={provider ? '搜索模型' : '搜索供应商'} value={query} onChange={event => setQuery(event.target.value)} /></label>

      <div className="cmd-model-options" key={tool + '/' + (provider || '')}>
        {!provider ? visibleProviders.map(entry => {
          const selected = entry.models.some(({ group, model }) => current?.provider === group.id && current?.model === model.id);
          return <button type="button" key={entry.id} disabled={busy || catalogLoading || !catalog || !!catalogError || !entry.models.length} className={'cmd-model-provider' + (selected ? ' is-selected' : '')} onClick={() => { setProvider(entry.id); setQuery(''); }}><span className="cmd-model-provider-mark"><ProviderBrandIcon id={entry.id} name={entry.name} declared={entry.declared} size={22} /></span><span className="cmd-model-provider-copy"><span>{entry.name}</span><small>{entry.reason || entry.models.length + ' 个模型'}</small></span><UIIcon name="chevronLeft" className="cmd-model-next" size={15} /></button>;
        }) : models.map(({ group, model, nativeModelId }) => {
          const selected = current?.provider === group.id && current?.model === model.id;
          const pinned = isPinned(group, model);
          return <div key={group.id + '/' + model.id} className={'cmd-model-choice' + (selected ? ' is-selected' : '')}><button type="button" role="menuitemradio" aria-checked={selected} disabled={busy || catalogLoading || !catalog || !!catalogError || !modules.harness && tool !== 'deepseek'} className={selected ? 'is-selected' : ''} onClick={() => void choose(group, model)}><span>{model.name}{nativeModelId && nativeModelId !== model.name && <small>{nativeModelId}</small>}</span>{selected && <UIIcon name="check" size={16} />}</button><button type="button" className={'cmd-model-pin' + (pinned ? ' is-pinned' : '')} aria-label={pinned ? '取消置顶模型' : '置顶模型'} aria-pressed={pinned} onClick={event => toggleModelPin(group, model, event)}>{pinned ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />}</button></div>;
        })}
        {!(provider ? models : visibleProviders.filter(entry => entry.models.length)).length && <p role="status">{loading ? '正在加载…' : query ? '没有匹配结果' : provider ? '此供应商暂无兼容模型' : tool === 'deepseek' ? '请先在模型设置中添加供应商' : '没有兼容的 API 组合，请检查供应商协议与模型目录'}</p>}
      </div>
      </div>
      {effortModel && <section className="cmd-model-current-card" aria-label="当前模型与推理强度">
        <div className="cmd-model-current-title">
          <span>当前模型</span>
          <strong><em>{effortModel.providerName}</em><i>/</i><b>{effortModel.model.name}</b></strong>
        </div>
        {effortOptions.length > 0 && <ModelEffortPicker key={JSON.stringify([effortModel.group.id, effortModel.model.id])} options={effortOptions} value={activeEffort} disabled={effortUnavailable} saving={busy} onCommit={commitEffort} />}
      </section>}
      {effortUnsupported && <div className="cmd-model-footer" role="alert">当前模型不支持已保存的推理档位 {activeEffort}</div>}
      {catalogLoading && catalog && <p className="cmd-model-refresh-status" role="status">正在更新模型目录…</p>}
      {sessionBinding?.bound && startNewSession && <footer className="cmd-model-footer"><button type="button" disabled={busy || creatingSession} onClick={() => void createNewSession()}>{creatingSession ? '正在新建会话…' : '新建会话切换 Harness 或供应商'}</button></footer>}
      {message && <footer className="cmd-model-footer"><span role="alert">{message}</span><button type="button" onClick={refresh} disabled={busy || loading}>重试</button></footer>}
    </div>, document.body)}
  </>;
}
