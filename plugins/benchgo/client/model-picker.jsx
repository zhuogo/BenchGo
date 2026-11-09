import { Loading } from '../../shared/client/ui/loading.jsx';
import { readJsonResponse } from './http-response.mjs';
import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { moduleSource } from './modules.mjs';
import { createPortal } from 'react-dom';
import { UIIcon } from './iconsax.jsx';
import { Tooltip } from '../../shared/client/ui/tooltip.jsx';
import { ProviderBrandIcon } from './provider-brand-icon.jsx';
import { ToolBrandIcon } from './tool-brand-icon.jsx';
import { availableTools, currentToolId, providersForTool, selectionReasoningEffort, providerAllowsTool } from './model-picker-state.mjs';
import css from './model-picker.css';
import { nativeActivityLabel } from './native-activity.mjs';
import { IconPinOutlineRegular, IconPinFillRegular } from '@deepseek-ai/dsh-client-ui-primitives';

/** Selection, permissions and persistence stay with the official directory. */
export function mountModelPicker(ctx) {
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  ctx.effect(() => () => style.remove());
  ctx.slots.inject('conversation.input.model', () => ctx.slots.register({
    name: 'conversation.input.model', priority: -10,
    inject: sessionId => {
      const directory = ctx.modelDirectories.directoryFor(sessionId);
      return { available: ctx.sessions.subagentAddress(sessionId) === undefined, hooks: { directory: directory.store }, load: () => directory.load(), select: selection => directory.select(selection), binding: async () => {
        const response = await fetch(new URL('api/commander', document.baseURI), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'binding', harnessSessionId: sessionId }) });
        const value = await readJsonResponse(response, new URL('api/commander', document.baseURI)); if (value.error) throw Error(value.error || '会话绑定状态读取失败'); return value;
      }, openSettingsSection: id => {
        const shell = ctx.slots.entries('sidebar.settings').find(entry => entry.children?.['settings.section']);
        const actions = shell?.store?.create().actions;
        if (!actions?.openSection) throw Error('请从侧栏设置打开对应页面。');
        actions.openSection(id);
      } };
    },
  }, ModelPicker));
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'commander-model-empty', order: -30,
    inject: sessionId => {
      const directory = ctx.modelDirectories.directoryFor(sessionId);
      return { available: ctx.sessions.subagentAddress(sessionId) === undefined, hooks: { directory: directory.store }, load: () => directory.load(), binding: async () => {
        const response = await fetch(new URL('api/commander', document.baseURI), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'binding', harnessSessionId: sessionId }) });
        const value = await readJsonResponse(response, new URL('api/commander', document.baseURI)); if (value.error) throw Error(value.error || '会话绑定状态读取失败'); return value;
      }, openSettingsSection: id => {
        const shell = ctx.slots.entries('sidebar.settings').find(entry => entry.children?.['settings.section']);
        const actions = shell?.store?.create().actions;
        if (!actions?.openSection) throw Error('请从侧栏设置打开对应页面。');
        actions.openSection(id);
      } };
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

function ModelEmptyBanner({ available, useDirectory, load, binding, openSettingsSection }) {
  const modules = useSyncExternalStore(moduleSource.subscribe, moduleSource.getSnapshot);
  const state = useDirectory(value => value);
  const [catalog, setCatalog] = useState(null), [catalogError, setCatalogError] = useState(''), [sessionBinding, setSessionBinding] = useState(null);
  const currentTool = currentToolId(state.current?.provider);
  const harnessUnavailable = !modules.harness && currentTool !== 'deepseek';
  useEffect(() => {
    if (!modules.harness) { setSessionBinding({ bound: false }); return; }
    let active = true, timer;
    const refreshBinding = async () => {
      try { const value = await binding(); if (active) setSessionBinding(value); }
      catch { if (active) setSessionBinding(null); }
      finally { if (active) timer = setTimeout(refreshBinding, 2000); }
    };
    void refreshBinding();
    return () => { active = false; clearTimeout(timer); };
  }, [modules.harness]);
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      const response = await fetch(new URL('api/commander/tooling', document.baseURI), { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pickerCatalog' }) });
      const value = await readJsonResponse(response, new URL('api/commander/tooling', document.baseURI));
      if (value.error) throw Error(typeof value.error === 'string' ? value.error : value.error?.message || '工具目录加载失败');
      if (!controller.signal.aborted) setCatalog(value);
    })().catch(reason => { if (!controller.signal.aborted) setCatalogError(reason.message); });
    return () => controller.abort();
  }, [modules.harness, state.groups?.map(group => group.id + ':' + (group.models?.length || 0)).join('|')]);
  const configuredProviders = providersForTool(state.groups, catalog, currentTool).filter(entry => catalog?.providers?.some(row => row.id === entry.id) && (entry.models.length || entry.nativeRequired));
  const noProvider = available && catalog !== null && !catalogError && !configuredProviders.length && !sessionBinding?.bound;
  if (!noProvider && !harnessUnavailable) return null;
  return <div className="cmd-model-empty" role="status"><span>{harnessUnavailable ? 'Harness 聚合未启用，请启用模块或切换模型' : '无模型可用，请先配置模型供应商'}</span>{!harnessUnavailable && <button type="button" aria-label="前往配置模型供应商" onClick={() => { try { openSettingsSection('models'); } catch { /* The model trigger keeps its own error. */ } }}><UIIcon name="external" size={13} />前往</button>}</div>;
}

function ModelPicker({ locked, available, useDirectory, load, select, binding, openSettingsSection }) {
  const modules = useSyncExternalStore(moduleSource.subscribe, moduleSource.getSnapshot);
  const state = useDirectory(value => value);
  const [open, setOpen] = useState(false), [tool, setTool] = useState('deepseek'), [provider, setProvider] = useState(null), [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState(null), [catalogLoading, setCatalogLoading] = useState(false), [revision, setRevision] = useState(0);
  const [toolsOpen, setToolsOpen] = useState(false), [position, setPosition] = useState(null), [error, setError] = useState(''), [catalogError, setCatalogError] = useState('');
  const [sessionBinding, setSessionBinding] = useState(null), [bindingError, setBindingError] = useState('');
  const [effortDrag, setEffortDrag] = useState(null);
  const [effortOptimistic, setEffortOptimistic] = useState(null);
  const pinnedModels = useRef((() => { try { return JSON.parse(localStorage.getItem('commander.pinned-models') || '{}') || {}; } catch { return {}; } })());
  const trigger = useRef(null), menu = useRef(null), search = useRef(null), selecting = useRef(false), toolTrigger = useRef(null);
  const id = useId(), currentTool = currentToolId(state.current?.provider);
  const harnessUnavailable = !modules.harness && currentTool !== 'deepseek';
  const entries = availableTools(catalog).map(entry => entry.id === 'deepseek' || modules.harness ? entry : { ...entry, routeSupported: false, routeReason: 'Harness 聚合未启用' }), activeTool = entries.find(entry => entry.id === tool);
  const currentGroup = state.groups.find(group => group.id === state.current?.provider);
  const currentModel = currentGroup?.models.find(model => model.id === state.current?.model);
  const busy = state.status === 'selecting', loading = state.status === 'loading' || catalogLoading;
  useEffect(() => {
    setEffortDrag(null);
    setEffortOptimistic(null);
  }, [state.current?.provider, state.current?.model]);
  useEffect(() => {
    if (!modules.harness) { setSessionBinding({ bound: false }); setBindingError(''); return; }
    let active = true;
    let timer;
    const refreshBinding = async () => {
      try { const value = await binding(); if (active) { setSessionBinding(value); setBindingError(''); } }
      catch (reason) { if (active) setBindingError(reason.message); }
      finally { if (active) timer = setTimeout(refreshBinding, 2000); }
    };
    setSessionBinding(null); setBindingError('');
    void refreshBinding();
    return () => { active = false; clearTimeout(timer); };
  }, [modules.harness]);
  const modelLocked = locked || (typeof binding === 'function' && (sessionBinding === null || !!bindingError || !!sessionBinding?.bound && !sessionBinding?.route?.providerId));
  const boundTool = sessionBinding?.bound ? sessionBinding.provider : null;
  const boundProvider = sessionBinding?.bound ? sessionBinding.route?.providerId : null;
  const toolLocked = modelLocked || !!boundTool;
  const bindingHint = harnessUnavailable ? 'Harness 聚合未启用，请启用模块或切换模型' : bindingError || (sessionBinding?.bound && !sessionBinding?.route?.providerId ? '此对话使用本机默认模型，当前不能在会话中切换供应商模型' : sessionBinding?.bound ? '当前会话可在已选工具和供应商内切换模型' : sessionBinding === null ? '正在确认会话绑定状态…' : '');
  const close = () => { setOpen(false); setProvider(null); setToolsOpen(false); setQuery(''); setEffortDrag(null); };
  const refresh = () => { setError(''); setRevision(value => value + 1); void load().catch(reason => setError(reason.message)); };
  useEffect(() => {
    const controller = new AbortController(); setCatalogLoading(true); setCatalogError('');
    (async () => {
      const response = await fetch(new URL('api/commander/tooling', document.baseURI), { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pickerCatalog' }) });
      const value = await readJsonResponse(response, new URL('api/commander/tooling', document.baseURI)); if (value.error) throw Error(typeof value.error === 'string' ? value.error : value.error?.message || '工具目录加载失败');
      if (controller.signal.aborted) return;
      setCatalog(value); setTool(current => availableTools(value).some(entry => entry.id === current && entry.routeSupported) ? current : 'deepseek');
    })().catch(reason => { if (!controller.signal.aborted) setCatalogError(reason.message); }).finally(() => { if (!controller.signal.aborted) setCatalogLoading(false); });
    return () => controller.abort();
  }, [revision, modules.harness]);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
      const width = Math.min(368, window.innerWidth - 24), below = window.innerHeight - rect.bottom, above = window.top ? rect.top : rect.top, topSide = above > below;
      setPosition({ position: 'fixed', width, left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), ...(topSide ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }), maxHeight: Math.max(100, Math.min(520, (topSide ? above : below) - 20)) });
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
    if (selecting.current || modelLocked || catalogLoading || !catalog || catalogError) return false;
    if (!modules.harness && currentToolId(group.id) !== 'deepseek') { setError('Harness 聚合未启用'); return false; }
    selecting.current = true; setError('');
    try {
      const route = catalog.routes?.find(row => row.modelId === model.id && 'commander-' + row.tool === group.id);
      const identity = catalog.providers?.find(entry => entry.id === (route?.providerId || group.id));
      if (!providerAllowsTool(identity, currentToolId(group.id))) throw Error('此订阅仅允许使用对应的 Harness 工具');
      const reasoningEffort = selectionReasoningEffort(group.id, model, state.current, effort);
      const result = await select({ provider: group.id, model: model.id, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) });
      if (!result?.ok) throw new Error(result?.error?.message ?? '模型选择不可用');
      if (!keepOpen) { close(); trigger.current?.focus(); }
      return true;
    } catch (reason) { setError(reason.message); return false; } finally { selecting.current = false; }
  };
  const modelKey = (group, model) => `${group.id}/${model.id}`;
  const isPinned = (group, model) => (pinnedModels.current || {})[modelKey(group, model)] === true;
  const toggleModelPin = (group, model, event) => {
    event.stopPropagation();
    pinnedModels.current = { ...(pinnedModels.current || {}), [modelKey(group, model)]: !isPinned(group, model) };
    try { localStorage.setItem('commander.pinned-models', JSON.stringify(pinnedModels.current)); } catch { /* Storage may be unavailable. */ }
    setRevision(value => value + 1);
  };
  const providers = providersForTool(state.groups, catalog, tool).filter(item => !boundProvider || item.id === boundProvider), selectedProvider = providers.find(item => item.id === provider);
  const matches = text => text.toLowerCase().includes(query.trim().toLowerCase());
  const visibleProviders = providers.filter(item => matches(item.name + ' ' + item.id));
  const models = (selectedProvider?.models || []).filter(({ model, nativeModelId }) => matches(model.name + ' ' + (nativeModelId || model.id))).sort((a, b) => Number(isPinned(b.group, b.model)) - Number(isPinned(a.group, a.model)));
  const activeEffort = currentModel && selectionReasoningEffort(currentGroup.id, currentModel, state.current);
  const currentProviderEntry = providersForTool(state.groups, catalog, currentTool).find(entry => entry.models.some(({ group, model }) => group.id === state.current?.provider && model.id === state.current?.model));
  const currentRoute = catalog?.routes?.find(row => row.modelId === state.current?.model && ('commander-' + row.tool === state.current?.provider || (row.tool === 'deepseek' && state.current?.provider === row.providerId)));
  const effortModel = currentModel ? { group: currentGroup, model: currentModel, providerName: currentProviderEntry?.name || currentRoute?.providerName || currentGroup?.name || currentGroup?.id } : null;
  const effortOptions = effortModel?.model.reasoning?.efforts || [];
  const effectiveEffortId = effortOptimistic !== null && effortOptions.some(item => item.id === effortOptimistic) ? effortOptimistic : activeEffort;
  const committedIndex = Math.max(0, effortOptions.findIndex(effort => effort.id === effectiveEffortId));
  const stepCount = Math.max(1, effortOptions.length - 1);
  const snappedRatio = effortOptions.length > 1 ? committedIndex / stepCount : 1;
  const activeRatio = effortDrag !== null ? effortDrag : snappedRatio;
  const activeIndex = effortOptions.length > 1 ? Math.round(activeRatio * stepCount) : 0;
  const activeOption = effortOptions[activeIndex] || effortOptions[0];
  const isOff = effortDrag === null && (!activeOption || activeOption.id === 'off' || (effortOptions.length > 1 && activeIndex === 0 && /off|关|无/i.test(activeOption.id + ' ' + activeOption.name)));
  const intensity = isOff ? 0 : effortDrag !== null ? Math.max(0.45, activeRatio) : (effortOptions.length > 1 ? Math.max(0.2, activeRatio) : 1);
  const commitEffortIndex = async index => {
    const target = effortOptions[index];
    if (!target || !effortModel) return;
    setEffortOptimistic(target.id);
    if (target.id === activeEffort) return;
    const ok = await choose(effortModel.group, effortModel.model, target.id, true);
    if (!ok) setEffortOptimistic(null);
  };
  const ratioFromPointer = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    const pad = 16;
    const usable = Math.max(1, rect.width - pad * 2);
    return Math.max(0, Math.min(1, (event.clientX - rect.left - pad) / usable));
  };
  const effortName = currentModel?.reasoning?.efforts?.find(effort => effort.id === effectiveEffortId)?.name;
  const failures = state.failures?.filter(group => tool === 'deepseek' ? !group.id?.startsWith('commander-') : group.id === 'commander-' + tool) || [];
  const configuredProviders = providersForTool(state.groups, catalog, currentTool).filter(entry => catalog?.providers?.some(row => row.id === entry.id) && (entry.models.length || entry.nativeRequired));
  const noProvider = !harnessUnavailable && catalog !== null && !catalogError && !configuredProviders.length && !sessionBinding?.bound;
  const sendUnavailable = noProvider || harnessUnavailable;
  const modelLabel = noProvider ? '无模型可用' : currentModel?.name ?? state.current?.model ?? '选择模型';
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
  const sliderDisabled = busy || !catalog || !!catalogError || !modules.harness && currentTool !== 'deepseek';
  return <>
    <Tooltip label={noProvider ? '无模型可用，请先配置模型供应商' : modelLabel + (effortName ? ' · ' + effortName : '') + (bindingHint ? '。' + bindingHint : '')} portal><button ref={trigger} type="button" className="cmd-model-trigger" data-empty={noProvider || undefined} disabled={modelLocked || !available || busy} aria-label={noProvider ? '无模型可用，请先配置模型供应商' : '选择工具与模型，当前 ' + (entries.find(item => item.id === currentTool)?.name ?? currentTool) + ' ' + (currentModel?.name ?? state.current?.model ?? '') + (sessionBinding?.bound ? '。可在当前工具和供应商内切换模型' : bindingHint ? '。' + bindingHint : '')} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => { if (open) close(); else { setTool(currentTool); setProvider(null); setQuery(''); setToolsOpen(false); setOpen(true); refresh(); } }}>
      <span className="cmd-model-caption">{modelLabel}{!noProvider && effortName ? ' · ' + effortName : ''}</span><UIIcon name="chevronDown" size={14} />
    </button></Tooltip>
    {open && position && createPortal(<div ref={menu} id={id} role="dialog" aria-label="工具与模型" className="cmd-model-popup" style={position} onKeyDown={onMenuKey}>
      {catalogLoading && <Loading className="cmd-model-loading-overlay" label="正在加载模型目录" />}
      <div className="cmd-model-provider-card"><header className="cmd-model-header">
        {provider ? <button type="button" className="cmd-model-back" aria-label="返回供应商列表" disabled={busy} onClick={() => { setProvider(null); setQuery(''); }}><UIIcon name="chevronLeft" size={16} /><span>{selectedProvider?.name || '供应商'}</span></button> : <span className="cmd-model-heading">选择供应商</span>}
        <Tooltip label={boundTool ? '当前工具为 ' + boundTool + '，只能切换该工具的模型' : '选择 Agent 工具'} portal><button ref={toolTrigger} type="button" className="cmd-model-tool-trigger" aria-label="选择 Agent 工具" aria-haspopup="menu" aria-expanded={toolsOpen} disabled={busy || toolLocked} onClick={() => setToolsOpen(value => !value)}><ToolBrandIcon tool={tool} size={18} muted={!activeTool?.installed || !activeTool?.routeSupported} /><span>{activeTool?.name || (catalogLoading ? '识别工具…' : tool)}</span><UIIcon name="chevronDown" size={13} /></button></Tooltip>
      </header>
      {toolsOpen && <div className="cmd-model-tool-menu" role="menu" aria-label="本机可用 Agent 工具">{entries.map(entry => <button key={entry.id} type="button" role="menuitemradio" disabled={toolLocked || !entry.routeSupported || !providerAllowsTool(selectedProvider, entry.id)} aria-checked={tool === entry.id} className={tool === entry.id ? 'is-selected' : ''} onClick={() => { if (!providerAllowsTool(selectedProvider, entry.id)) return; setTool(entry.id); setProvider(null); setQuery(''); setToolsOpen(false); }}><ToolBrandIcon tool={entry.id} size={20} muted={!entry.installed || !entry.routeSupported} /><span>{entry.name}{!providerAllowsTool(selectedProvider, entry.id) ? <small>此订阅仅限对应工具</small> : !entry.routeSupported && <small>{entry.routeReason || '供应商隔离待适配'}</small>}</span>{tool === entry.id && <UIIcon name="check" size={16} />}</button>)}<small>{boundTool ? `当前工具为 ${boundTool}，可在当前供应商内切换模型` : catalogLoading ? '正在识别本机工具…' : '自动识别本机已安装的对话工具'}</small></div>}
      <label className="cmd-model-search"><UIIcon name="search" size={16} /><input ref={search} type="search" autoComplete="off" spellCheck={false} aria-label={provider ? '搜索模型' : '搜索供应商'} placeholder={provider ? '搜索模型' : '搜索供应商'} value={query} onChange={event => setQuery(event.target.value)} /></label>

      <div className="cmd-model-options" key={tool + '/' + (provider || '')}>
        {!provider ? visibleProviders.map(entry => {
          const selected = entry.models.some(({ group, model }) => state.current?.provider === group.id && state.current?.model === model.id);
          return <button type="button" key={entry.id} disabled={busy || catalogLoading || !catalog || !!catalogError || !entry.models.length && !entry.nativeRequired} className={'cmd-model-provider' + (selected ? ' is-selected' : '')} onClick={() => { setProvider(entry.id); setQuery(''); }}><span className="cmd-model-provider-mark"><ProviderBrandIcon id={entry.id} name={entry.name} declared={entry.declared} size={22} /></span><span className="cmd-model-provider-copy"><span>{entry.name}</span><small>{entry.nativeRequired ? '订阅 · 使用本机登录' : entry.models.length + ' 个模型'}</small></span><UIIcon name="chevronLeft" className="cmd-model-next" size={15} /></button>;
        }) : models.map(({ group, model, nativeModelId }) => {
          const selected = state.current?.provider === group.id && state.current?.model === model.id;
          const pinned = isPinned(group, model);
          return <div key={group.id + '/' + model.id} className={'cmd-model-choice' + (selected ? ' is-selected' : '')}><button type="button" role="menuitemradio" aria-checked={selected} disabled={busy || catalogLoading || !catalog || !!catalogError || !modules.harness && tool !== 'deepseek'} className={selected ? 'is-selected' : ''} onClick={() => void choose(group, model)}><span>{model.name}{nativeModelId && nativeModelId !== model.name && <small>{nativeModelId}</small>}</span>{selected && <UIIcon name="check" size={16} />}</button><button type="button" className={'cmd-model-pin' + (pinned ? ' is-pinned' : '')} aria-label={pinned ? '取消置顶模型' : '置顶模型'} aria-pressed={pinned} onClick={event => toggleModelPin(group, model, event)}>{pinned ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />}</button></div>;
        })}
        {selectedProvider?.nativeRequired ? <div className="cmd-model-native-required"><p role="status">{selectedProvider.routeReason || '此订阅仅能用于对应工具，请使用该工具的本机登录。'}</p><Tooltip label={modules.harness ? '打开 Harness 工具' : 'Harness 聚合未启用'} portal><button type="button" disabled={busy || !modules.harness} onClick={() => { try { openSettingsSection('harness-tools'); close(); } catch (reason) { setError(reason.message); } }}><UIIcon name="settings" size={15} />打开 Harness 工具</button></Tooltip></div> : !(provider ? models : visibleProviders).length && <p role="status">{loading ? '正在加载…' : query ? '没有匹配结果' : provider ? '暂无可用模型' : tool === 'deepseek' ? '请先在模型设置中添加供应商' : '暂无可用供应商，请在模型设置中配置此工具'}</p>}
      </div>
      </div>
      {effortModel && <section className="cmd-model-current-card" aria-label="当前模型与推理强度">
        <div className="cmd-model-current-title">
          <span>当前模型</span>
          <strong><em>{effortModel.providerName}</em><i>/</i><b>{effortModel.model.name}</b></strong>
        </div>
        {effortOptions.length > 0 && <div className="cmd-model-effort-section">
          <div className="cmd-model-effort-heading">
            <span>推理强度</span>
            <strong data-off={isOff ? 'true' : 'false'}>{activeOption?.name || effortOptions[0].name}</strong>
          </div>
          <div
            className={'cmd-model-effort-track' + (effortDrag !== null ? ' is-dragging' : '') + (isOff ? ' is-off' : '')}
            role="slider"
            tabIndex={sliderDisabled ? -1 : 0}
            aria-disabled={sliderDisabled}
            aria-label="推理强度档位"
            aria-valuemin={0}
            aria-valuemax={Math.max(0, effortOptions.length - 1)}
            aria-valuenow={activeIndex}
            aria-valuetext={activeOption?.name || effortOptions[0].name}
            style={{ '--effort-ratio': activeRatio, '--effort-intensity': intensity }}
            onPointerDown={event => {
              if (sliderDisabled) return;
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.setPointerCapture?.(event.pointerId);
              setEffortDrag(ratioFromPointer(event));
            }}
            onPointerMove={event => {
              if (effortDrag === null) return;
              event.stopPropagation();
              setEffortDrag(ratioFromPointer(event));
            }}
            onPointerUp={event => {
              if (effortDrag === null) return;
              event.stopPropagation();
              const ratio = ratioFromPointer(event);
              const index = effortOptions.length > 1 ? Math.round(ratio * stepCount) : 0;
              if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              setEffortDrag(null);
              void commitEffortIndex(index);
            }}
            onPointerCancel={event => {
              event.stopPropagation();
              if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              setEffortDrag(null);
            }}
            onClick={event => event.stopPropagation()}
            onKeyDown={event => {
              if (sliderDisabled) return;
              let nextIndex = activeIndex;
              if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') nextIndex = Math.max(0, activeIndex - 1);
              else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') nextIndex = Math.min(effortOptions.length - 1, activeIndex + 1);
              else if (event.key === 'Home') nextIndex = 0;
              else if (event.key === 'End') nextIndex = Math.max(0, effortOptions.length - 1);
              else return;
              event.preventDefault();
              event.stopPropagation();
              setEffortDrag(null);
              void commitEffortIndex(nextIndex);
            }}
          >
            <div className="cmd-model-effort-rail">
              <div className="cmd-model-effort-ticks" aria-hidden="true">
                {effortOptions.map((option, idx) => {
                  const tickRatio = effortOptions.length > 1 ? idx / stepCount : 1;
                  const passed = activeRatio + 0.001 >= tickRatio;
                  return <span key={option.id} className={'cmd-model-effort-tick' + (passed ? ' is-active' : '')} style={{ left: `calc(16px + (100% - 32px) * ${tickRatio})` }} />;
                })}
              </div>
              <div className="cmd-model-effort-fill" aria-hidden="true">
                <span className="cmd-model-effort-ions cmd-model-effort-ions-a" />
                <span className="cmd-model-effort-ions cmd-model-effort-ions-b" />
                <span className="cmd-model-effort-glow" />
              </div>
              <div className="cmd-model-effort-thumb" aria-hidden="true" />
            </div>
          </div>
          {effortOptions.length > 1 && <div className="cmd-model-effort-scale">
            {effortOptions.map((option, idx) => <button key={option.id} type="button" tabIndex={-1} disabled={sliderDisabled} className={'cmd-model-effort-step' + (idx === activeIndex ? ' is-current' : '')} onClick={event => { event.stopPropagation(); setEffortDrag(null); void commitEffortIndex(idx); }}>{option.name}</button>)}
          </div>}
        </div>}
      </section>}
      {message && <footer className="cmd-model-footer"><span role="alert">{message}</span><button type="button" onClick={refresh} disabled={busy || loading}>重试</button></footer>}
    </div>, document.body)}
  </>;
}
