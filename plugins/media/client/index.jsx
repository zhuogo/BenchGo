import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconMicrophoneOutlineMedium, IconStopFillRegular, Menu, Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import { Tooltip } from '../../shared/client/ui/tooltip.jsx';
import { createVoiceController } from './controller.mjs';
import { CallOrb, CallStageIcon } from './call-stage.jsx';
import { createCallPresentation } from './call-presentation.mjs';
import { VoiceCallHost } from './call-host.jsx';
import { CallEntry } from './call-entry.jsx';
import { MIC_SHORTCUT_KEYS, createMicTargets, installMicShortcut } from './mic-shortcut.mjs';
import { registerVoiceConversationRows } from './conversation-records.jsx';
import { registerMediaGenerationResults } from './generation-results.jsx';
import { callStreamingReason } from '../src/call-streaming.mjs';
import { mediaSettingsPayload, voiceSettingsPatch, listeningDraft } from './settings-state.mjs';
import { moduleSource } from '../../base/client/modules.mjs';
import { providerOption } from '../../base/client/provider-brand-icon.jsx';
import { prioritizeRouterGo } from '../../base/client/provider-options.mjs';
import { routerGo } from '../../base/shared/builtin-providers.mjs';
import css from './style.css';
import mediaCss from './media-settings.css';
import { SegmentedControl } from '../../shared/client/segmented-control.jsx';
import { UIIcon } from '../../base/client/iconsax.jsx';
import { Loading } from '../../shared/client/ui/loading.jsx';
import { Disclosure } from '../../shared/client/ui/collapsible.jsx';
import { CustomSelect } from '../../shared/client/custom-select.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import { VOICE_API_TYPES, protocolOptions, protocolDescriptor } from '../shared/protocol-catalog.mjs';

export const inject = ['slots', 'sessions', 'conversation', 'uiSession', 'connection', 'uiConversation', 'uiWorkspace'];
let activeController;
let settingsTab = 'generation';
const settingsTabListeners = new Set();
const readSettingsTab = () => settingsTab;
const subscribeSettingsTab = listener => {
  settingsTabListeners.add(listener);
  return () => settingsTabListeners.delete(listener);
};
function selectSettingsTab(tab) {
  if (tab === settingsTab) return;
  settingsTab = tab;
  for (const listener of settingsTabListeners) listener();
}

export function apply(ctx) {
  registerVoiceConversationRows(ctx);
  registerMediaGenerationResults(ctx);
  const controller = createVoiceController(ctx);
  const callView = createCallPresentation(controller, { title: id => ctx.sessions.list.getSnapshot().byId[id]?.title, subscribeTitle: listener => ctx.sessions.list.subscribe(listener), openSession: id => ctx.uiWorkspace.openSession(id) });
  activeController = controller;
  const micTargets = createMicTargets();
  ctx.effect(() => async () => { if (activeController === controller) activeController = undefined; callView.dispose(); await controller.dispose(); });
  const openSettings = () => {
    selectSettingsTab('voice');
    if (!openSettingsSection(ctx, 'media')) throw Error('请打开设置 → 媒体 → 语音。');
  };
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'benchgo-voice-call', inject: () => ({ controller, callView, sessionStatus: ctx.uiSession.sessionStatus, openSettings }) }, VoiceCallHost));
  ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({ name: 'conversation.input.activity', priority: -10, inject: () => ({ controller, callView, sessionStatus: ctx.uiSession.sessionStatus, micTargets }) }, VoiceActivity));
  ctx.inject(['shortcuts'], scope => { scope.effect(() => installMicShortcut({ shortcuts: scope.shortcuts, controller, targets: micTargets }), 'voice: microphone shortcut'); });
  void controller.load().catch(() => {});
}
function openSettingsSection(ctx, id) {
  const shell = ctx.slots.entries('sidebar.settings').find(entry => entry.children?.['settings.section']);
  const actions = shell?.store?.create().actions;
  if (!actions?.openSection) return false;
  actions.openSection(id);
  return true;
}

export function mountMediaSettings(ctx) {
  const style = document.createElement('style'); style.textContent = css + mediaCss; document.head.append(style);
  ctx.effect(() => () => style.remove());
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'media', order: 35, label: () => '媒体',
    inject: () => ({ openModels: () => openSettingsSection(ctx, 'models') }),
  }, MediaSettings));
}
function useVoice(controller) { return useSyncExternalStore(fn => controller.state.subscribe(fn), () => controller.state.getSnapshot()); }
function Hint({ label, shortcutKeys, children }) { return <Tooltip label={label} shortcutKeys={shortcutKeys} delayMs={450} portal>{children}</Tooltip>; }
const speakerAssets = {"on": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\"><path d=\"M2 10v4c0 2 1 3 3 3h1.43c.37 0 .74.11 1.06.3l2.92 1.83c2.52 1.58 4.59.43 4.59-2.54V7.41c0-2.98-2.07-4.12-4.59-2.54L7.49 6.7c-.32.19-.69.3-1.06.3H5c-2 0-3 1-3 3Z\" stroke-width=\"1.5\" stroke=\"currentColor\"/><path d=\"M18 8a6.66 6.66 0 0 1 0 8M19.83 5.5a10.83 10.83 0 0 1 0 13\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke=\"currentColor\"/></svg>", "off": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\"><path d=\"M15 8.37v-.96c0-2.98-2.07-4.12-4.59-2.54L7.49 6.7c-.32.19-.69.3-1.06.3H5c-2 0-3 1-3 3v4c0 2 1 3 3 3h2M10.41 19.13c2.52 1.58 4.59.43 4.59-2.54v-3.64M18.81 9.42c.9 2.15.63 4.66-.81 6.58M21.15 7.8a10.82 10.82 0 0 1-1.32 10.7M22 2 2 22\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke=\"currentColor\"/></svg>"};
function Speaker({ active }) { return <span className="voice-speaker-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: speakerAssets[active ? 'on' : 'off'] }} />; }
const callAsset = "<svg viewBox=\"0 0 24 24\" fill=\"none\"><path d=\"M3 8.25v7.5M7.5 5.75v12.5M12 3.25v17.5M16.5 5.75v12.5M21 8.25v7.5\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke=\"currentColor\"/></svg>";
function CallIcon() { return <span className="voice-speaker-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: callAsset }} />; }
export const DEFAULT_TTS_SPEED = 1.2;
const TTS_SPEED_MIN = 0.25, TTS_SPEED_MAX = 4;
export function normalizeTtsSpeed(value) {
  const speed = Number(value);
  return Number.isFinite(speed) && speed >= TTS_SPEED_MIN && speed <= TTS_SPEED_MAX ? Math.round(speed * 100) / 100 : DEFAULT_TTS_SPEED;
}
const phaseLabels = { idle: '准备中', starting: '正在连接', listening: '正在聆听', transcribing: '正在识别', thinking: '正在思考', speaking: '正在回应', waiting: '等待授权或交互' };
function VoiceActivity({ controller, callView, sessionStatus, sessionId, inputActions, locked, onActiveChange, micTargets }) {
  const state = useVoice(controller), [pending, setPending] = useState(false), [error, setError] = useState('');
  const [hasHistory, setHasHistory] = useState(false);
  const generation = useRef(0), activityRef = useRef(null), mic = useRef(null);
  mic.current = null;
  const own = state.sessionId === sessionId, active = own && state.mode !== 'idle';
  const recording = active && state.mode === 'dictation', calling = active && state.mode === 'call';
  const reading = own && state.readEnabled && state.phase === 'speaking';
  const pendingInteraction = useSyncExternalStore(listener => sessionStatus?.subscribe(listener) || (() => {}), () => !!sessionStatus?.getSnapshot().get(sessionId)?.pendingInteraction);
  const waiting = own && (pendingInteraction || state.phase === 'waiting');
  // Keep the draft mounted; restore editable controls after call/session teardown.
  useEffect(() => {
    if (!calling || waiting) return;
    const activity = activityRef.current, card = activity?.closest('[data-composer-card]');
    if (!card) return;
    card.classList.add('voice-call-composer');
    const previous = [...card.children].filter(child => !child.contains(activity)).map(child => [child, child.inert]);
    for (const [child] of previous) child.inert = true;
    return () => { card.classList.remove('voice-call-composer'); for (const [child, inert] of previous) child.inert = inert; };
  }, [calling, sessionId, waiting]);
  useEffect(() => { onActiveChange?.(active); return () => onActiveChange?.(false); }, [active, onActiveChange]);
  useEffect(() => {
    generation.current++; setError(''); setPending(false); setHasHistory(false);
    controller.selectSession?.(sessionId);
    if (callView.getSnapshot().sessionId !== sessionId) callView.minimize();
    return () => { generation.current++; callView.leave(sessionId); controller.releaseSessionView(sessionId); };
  }, [controller, callView, sessionId]);
  const run = async operation => {
    const version = generation.current; setPending(true); setError('');
    try { await operation(); } catch (failure) { if (version === generation.current) setError(failure.message || '语音操作失败'); }
    finally { if (version === generation.current) setPending(false); }
  };
  useEffect(() => {
    if (!own || state.mode !== 'idle' || !state.recoveryText || locked) return;
    try { controller.recoverToDraft(inputActions); }
    catch (failure) { setError(failure.message || '语音文字暂时无法写入草稿'); }
  }, [controller, inputActions, own, locked, state.mode, state.recoveryText]);
  useEffect(() => {
    if (!controller.readConversationHistory) return;
    const abort = new AbortController();
    controller.readConversationHistory(sessionId, { signal: abort.signal }).then(result => { if (!abort.signal.aborted) setHasHistory(!!result.items?.length); }).catch(() => {});
    return () => abort.abort();
  }, [controller, sessionId]);
  // The M shortcut drives this composer's dictation through the same operations as its buttons.
  useEffect(() => micTargets?.add({ element: () => activityRef.current, actions: () => mic.current }), [micTargets]);
  const startCall = event => {
    const rect = event?.currentTarget?.getBoundingClientRect();
    return callView.start({ sessionId, inputActions, origin: rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null });
  };
  const config = state.config;
  if (!config) return state.error ? <span className="voice-inline-error" role="status">语音配置加载失败，请在设置中重试</span> : null;
  const asrReady = !!(config.asr?.configured && config.asr?.model && protocolDescriptor('asr', config.asr?.protocol || '')), ttsReady = !!(config.tts?.configured && config.tts?.model && protocolDescriptor('tts', config.tts?.protocol || ''));
  const unavailable = [!asrReady && 'ASR', !ttsReady && 'TTS'].filter(Boolean).join('、');
  const callReason = callStreamingReason(config), callReady = asrReady && ttsReady && !callReason;
  const canStart = !locked && !pending && state.mode === 'idle';
  mic.current = { sessionId, ready: () => !!config.dictation && asrReady && canStart,
    start: () => run(() => controller.startDictation({ sessionId, inputActions, hold: true })), keep: () => controller.keepDictation(inputActions),
    send: () => run(() => controller.sendDictation()), stop: () => run(() => controller.stopDictation()) };
  const message = error || (own ? state.error : '');
  if (calling) return <div ref={activityRef} className={'voice-activity voice-expanded voice-calling voice-call-phase-' + state.phase}>
    <div className="voice-call-capsule"><button type="button" className="voice-call-restore" aria-label="返回语音通话" onClick={() => callView.expand()}><CallOrb state={state} /><span>{waiting ? '等待确认 · 请在对话中处理' : message ? '通话遇到问题' : state.muted ? '麦克风已关闭' : phaseLabels[state.phase] || '返回通话'}</span><CallStageIcon name="expand" /></button></div>
  </div>;
  return <div ref={activityRef} className={'voice-activity ' + (active ? 'voice-expanded ' : '') + (recording ? 'voice-dictating' : '')}>
    {recording ? <div className="voice-recording-strip"><span className="voice-recording-pulse" role="img" aria-label="麦克风实时音量" style={{ '--voice-level': state.level || 0 }}>{Array.from({ length: 31 }, (_, i) => <i key={i} style={{ '--voice-band': .22 + .78 * Math.abs(Math.sin(i * 1.7)) }} />)}</span><span className="voice-recording-caption" role="status">{state.transcript || (state.phase === 'starting' ? '正在准备麦克风…' : state.dictationHold ? '正在聆听 · 松开发送' : '正在聆听')}</span><Hint label="停止转录"><button type="button" className="voice-icon-button voice-stop-recording" aria-label="停止语音转录" onClick={() => run(() => controller.stopDictation())}><IconStopFillRegular size={16} /></button></Hint></div> : config.dictation && !calling && <Hint label={!asrReady ? '请先在设置 → 媒体 → 语音中配置 ASR 模型' : micTargets ? '语音转文本；按住 M 说话，松开发送' : '语音转文本'} shortcutKeys={asrReady && micTargets ? MIC_SHORTCUT_KEYS : undefined}><button type="button" className="voice-icon-button" data-available={asrReady} aria-label="语音转文本" disabled={!canStart || !asrReady} onClick={() => run(() => controller.startDictation({ sessionId, inputActions }))}><IconMicrophoneOutlineMedium size={18} /></button></Hint>}
    {config.readAloud && <Hint label={state.mode === 'call' ? '通话期间由原会话播放语音' : !ttsReady ? 'TTS 不可用，请打开设置 → 媒体 → 语音' : state.readEnabled ? '自动朗读开启' : '自动朗读关闭'}><button type="button" className="voice-icon-button voice-read-button" data-available={ttsReady} aria-label={!ttsReady ? 'TTS 不可用，请打开设置 → 媒体 → 语音' : state.readEnabled ? '自动朗读开启' : '自动朗读关闭'} aria-pressed={!!state.readEnabled} disabled={state.mode === 'call' || !ttsReady && !state.readEnabled} onClick={() => run(() => controller.toggleRead(sessionId))}><Speaker active={!!state.readEnabled} /></button></Hint>}
    {!recording && (config.call || hasHistory || own && state.conversationMessages?.length > 0) && <CallEntry available={!!config.call && callReady} disabled={state.mode !== 'call' && (!config.call || !canStart || !callReady)} hint={state.mode === 'call' ? '查看正在进行的通话；结束后可在此开始新通话' : callReady && config.call ? '开始通话' : callReason || unavailable + ' 不可用，请打开设置 → 媒体 → 语音'} onStart={startCall} onHistory={() => callView.history(sessionId)}><CallIcon /></CallEntry>}
    {!recording && (active || reading) && <div className={'voice-status voice-phase-' + state.phase} role="status"><span className="voice-status-dot" /><span className="voice-status-text">{state.transcript || phaseLabels[state.phase] || '语音处理中'}</span></div>}
    {!active && pending && <span className="voice-inline-note" role="status">连接中…</span>}
    {message && <span className="voice-inline-error" role="alert">{message}</span>}
  </div>;
}
export function draftFrom(config) {
  const endpoint = name => ({ providerId: config[name]?.providerId || '', baseURL: config[name]?.baseURL || '', model: config[name]?.model || '', apiKey: '', apiType: config[name]?.apiType === 'auto' ? '' : config[name]?.apiType || '', protocol: config[name]?.protocol === 'auto' ? '' : config[name]?.protocol || '', ...(name === 'tts' ? { voice: config.tts?.voice || '', speed: normalizeTtsSpeed(config.tts?.speed), stream: config.tts?.stream !== false } : { realtime: config.asr?.realtime || { url: '', query: {} } }) });
  return { dictation: !!config.dictation, readAloud: !!config.readAloud, call: !!config.call, asr: endpoint('asr'), tts: endpoint('tts'), conversation: { providerId: config.conversation?.providerId || '', model: config.conversation?.model || '' }, listening: listeningDraft(config.listening) };
}
async function modelCatalog(action, args = {}, signal) {
  const response = await fetch(new URL('api/commander/tooling', document.baseURI), { method: 'POST', credentials: 'same-origin', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args }) });
  const data = await response.json(); if (!response.ok) throw Error(data.error || '无法读取模型服务'); return data;
}
function Toggle({ label, detail, checked, onChange, disabled }) {
  return <div className="voice-setting-toggle"><span><strong>{label}</strong>{detail && <small>{detail}</small>}</span>
    <Switch label={label} checked={!!checked} onChange={onChange} disabled={disabled} />
  </div>;
}
async function voiceProtocolRequest(action, args, signal) {
  const response = await fetch(new URL('api/voice', document.baseURI), { method: 'POST', credentials: 'same-origin', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args }) });
  const data = await response.json(); if (!response.ok) throw Error(data.error || '语音接口检测失败'); return data;
}
function ModelActions({ loading, disabled, manual, refresh, toggle }) {
  return <div className="voice-model-actions"><Hint label={loading ? '正在获取模型列表' : '刷新列表'}><button type="button" className="voice-icon-button" aria-label="刷新列表" aria-busy={loading} disabled={loading || disabled} onClick={refresh}><UIIcon name="refresh" size={17} /></button></Hint><Hint label={manual ? '从列表选择' : '手动填写'}><button type="button" className="voice-icon-button" aria-label={manual ? '从列表选择' : '手动填写'} aria-pressed={manual} disabled={disabled} onClick={toggle}><UIIcon name={manual ? 'category' : 'edit'} size={17} /></button></Hint></div>;
}
function protocolIdentity(name, draft, clearKey, requirement) {
  return JSON.stringify([name, draft, !!clearKey, requirement]);
}
function useProtocolCheck({ name, draft, config, clearKey, disabled, requirement, providerAvailable, update, formDraft }) {
  const [view, setView] = useState(null), operation = useRef(null);
  const identity = protocolIdentity(name, draft, clearKey, requirement), current = useRef(identity); current.current = identity;
  const complete = !!(draft.model?.trim() && !clearKey && (draft.providerId ? providerAvailable : draft.baseURL?.trim() && (draft.apiKey?.trim() || config?.apiKeyConfigured)));
  const record = view?.identity === identity ? view : null;
  const run = async action => {
    operation.current?.abort(); const abort = new AbortController(); operation.current = abort;
    setView({ identity, result: null, busy: action });
    try {
      const data = await voiceProtocolRequest(action, { kind: name, config: { ...draft, ...(clearKey ? { clearApiKey: true } : {}) }, requirement }, abort.signal);
      if (abort.signal.aborted || current.current !== identity) return;
      if (action === 'protocol.detect' && data.result?.status === 'supported') {
        const selected = { apiType: data.result.apiType, protocol: data.result.protocol };
        if (!VOICE_API_TYPES.some(type => type.value === selected.apiType) || !protocolDescriptor(name, selected.protocol)) throw Error('匹配返回了不支持的接口，请重试');
        setView({ identity: protocolIdentity(name, { ...draft, ...selected }, clearKey, requirement), result: data.result, busy: '', action });
        update(selected);
      } else setView({ identity, result: data.result, busy: '', action });
    } catch (failure) {
      if (!abort.signal.aborted && current.current === identity) setView({ identity, result: { status: 'inconclusive', message: failure.message || '检测失败，请重试' }, busy: '', action });
    } finally { if (operation.current === abort) operation.current = null; }
  };
  const cancel = () => { operation.current?.abort(); operation.current = null; setView(null); };
  useEffect(() => { operation.current?.abort(); operation.current = null; setView(previous => previous?.busy ? null : previous); return () => operation.current?.abort(); }, [identity, disabled, formDraft]);
  return { result: record?.result, action: record?.action, busy: record?.busy || '', run, cancel, complete };
}
function ProtocolStatus({ check, name, draft, config, justSaved }) {
  if (check.busy) return <p role="status" className="voice-protocol-summary">{check.busy === 'protocol.detect' ? '正在匹配协议…' : '正在测试协议…'}</p>;
  if (check.result && check.result.status !== 'supported') return <p role="status" className="voice-settings-error">{check.result.message || '暂时无法确认，请重试'}</p>;
  const selected = protocolDescriptor(name, draft.protocol), saved = draft.protocol === config?.protocol && draft.apiType === config?.apiType;
  return <p role="status" className={'voice-protocol-summary' + (check.result?.status === 'supported' ? ' is-verified' : '')}>{check.result?.status === 'supported' ? (check.action === 'protocol.detect' && !saved ? '已匹配 · ' : '已验证 · ') : selected ? justSaved ? '已保存 · ' : '已选择 · ' : '待匹配协议'}{selected?.label}{check.action === 'protocol.detect' && !saved ? ' · 待保存' : ''}</p>;
}
function ProtocolMatch({ check, disabled }) {
  return <><Hint label="自动匹配"><span><button type="button" className="voice-icon-button voice-protocol-match" aria-label="自动匹配" disabled={disabled || !!check.busy || !check.complete} onClick={() => check.run('protocol.detect')}><UIIcon name="scan" size={17} /></button></span></Hint>{check.busy && <Hint label="取消检测"><button type="button" className="voice-icon-button voice-protocol-match" aria-label="取消检测" onClick={check.cancel}><UIIcon name="close" size={17} /></button></Hint>}</>;
}
function ProtocolCheck({ check, draft, name, disabled }) {
  const testBlocked = disabled || !!check.busy || !check.complete || !protocolDescriptor(name, draft.protocol);
  return <div className="voice-protocol-inspection"><div className="voice-protocol-actions"><Hint label={!protocolDescriptor(name, draft.protocol) ? '请先匹配或选择协议' : '测试当前协议'}><span><button type="button" className="voice-icon-button" aria-label="测试当前协议" disabled={testBlocked} onClick={() => check.run('protocol.test')}><UIIcon name="experiment" size={17} /></button></span></Hint></div>{check.result?.attempts?.length > 0 && <ul className="voice-protocol-attempts">{check.result.attempts.map((attempt, index) => <li key={index}><span>{protocolDescriptor(name, attempt.protocol)?.label || attempt.protocol}</span><small>{({ supported: '可用', unsupported: '不支持', inconclusive: '未确认', 'not-tested': '未测试' })[attempt.status] || attempt.status}{Number.isFinite(attempt.firstOutputMs) ? ' · 首输出 ' + Math.round(attempt.firstOutputMs) + ' ms' : ''}{Number.isFinite(attempt.completionMs) ? ' · 完成 ' + Math.round(attempt.completionMs) + ' ms' : ''}{attempt.message ? ' · ' + attempt.message : ''}</small></li>)}</ul>}</div>;
}
function VoiceSelect({ label, value, options, onChange, placeholder = '请选择', disabled, hideLabel = false }) {
  const id = useId(), selected = options.find(option => option.value === value);
  const items = options.map(option => ({ ...option, searchText: option.label + ' ' + (option.hint || ''),
    label: option.hint ? <span className="voice-select-copy"><span>{option.label}</span><small>{option.hint}</small></span> : option.label }));
  return <div className="voice-select">{!hideLabel && <label htmlFor={id} className="voice-field-label">{label}</label>}<CustomSelect id={id} className="voice-select-trigger" aria-label={label + ' ' + (selected?.label || value || placeholder)} value={value} options={items} onChange={onChange} placeholder={value || placeholder} disabled={disabled} searchable /></div>;
}
function mediaProviderOptions(catalog, providerId, { standalone, generation = false } = {}) {
  const unavailable = catalog.error ? '供应商目录读取失败' : catalog.loading ? '正在读取供应商目录…' : '当前供应商暂不可用';
  const providers = catalog.providers.map(item => {
    const credentialMissing = !item.configured;
    const subscription = generation && item.authMode === 'subscription';
    return { ...item, disabled: credentialMissing || subscription, reason: credentialMissing ? '供应商尚未配置' : subscription ? '生成需要 API 凭据' : undefined };
  });
  if (providerId && providerId !== routerGo.id && !providers.some(item => item.id === providerId)) providers.push({ id: providerId, disabled: true, reason: unavailable });
  const options = prioritizeRouterGo(providers, { ...routerGo, disabled: true, reason: catalog.loading || catalog.error ? unavailable : '请先在模型设置中配置 RouterGo' }).map(providerOption);
  if (standalone) options.push(standalone);
  return options;
}
function ProviderSettings({ name, draft, config, catalog, update, clearKey, toggleClear, disabled, hideTitle = false, requirement = 'any', formDraft, justSaved = false }) {
  const { providers } = catalog;
  const [models, setModels] = useState([]), [loading, setLoading] = useState(false), [error, setError] = useState(''), [manualModel, setManualModel] = useState(false), [revision, setRevision] = useState(0);
  const modelRoute = useRef('');
  const selectedProvider = providers.find(item => item.id === draft.providerId);
  const providerAvailable = selectedProvider ? !!selectedProvider.configured : !!(draft.providerId && config?.providerId === draft.providerId && config?.configured);
  const check = useProtocolCheck({ name, draft, config, clearKey, disabled, requirement, providerAvailable, update, formDraft });
  const providerId = draft.providerId, provider = providers.find(item => item.id === providerId);
  useEffect(() => {
    setError(''); setLoading(false); setManualModel(false);
    const route = JSON.stringify([providerId, name]); if (modelRoute.current !== route) { modelRoute.current = route; setModels([]); }
    if (!providerId) return;
    const abort = new AbortController(); setLoading(true);
    modelCatalog('models', { providerId }, abort.signal).then(data => { if (!abort.signal.aborted) setModels((data.models || []).filter(item => item.kinds?.includes(name))); }).catch(failure => { if (!abort.signal.aborted) setError(failure.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [providerId, name, revision]);
  const providerOptions = mediaProviderOptions(catalog, providerId, { standalone: { value: '', label: '独立配置', hint: '手动填写服务与密钥' } });
  const supported = !draft.protocol || !!protocolDescriptor(name, draft.protocol);
  const [advanced, setAdvanced] = useState(!providerId || !supported);
  useEffect(() => { if (!providerId || !supported) setAdvanced(true); }, [providerId, supported]);
  const modelLabel = name === 'asr' ? '语音识别模型' : '语音合成模型';
  return <fieldset disabled={disabled} className="voice-provider-settings">{!hideTitle && <legend>{name === 'asr' ? '语音识别' : '声音'}</legend>}
    <div className="voice-route-fields">
      <VoiceSelect label="模型供应商" value={providerId} options={providerOptions} disabled={disabled} onChange={id => { if (id === providerId) return; setModels([]); update({ providerId: id, baseURL: providers.find(item => item.id === id)?.baseURL || '', model: '', apiKey: '', apiType: '', protocol: '', ...(name === 'asr' ? { realtime: { url: '', query: {} } } : { voice: '' }) }); }} />
      <div className="voice-model-field">
        {providerId && !manualModel ? <VoiceSelect label={modelLabel} value={draft.model} options={models.map(model => ({ value: model.id, label: model.name || model.id, hint: model.id }))} placeholder={loading ? '正在获取模型…' : '选择模型'} disabled={disabled || loading && !models.length} onChange={model => update({ model })} /> : <label>{modelLabel}<input type="text" autoComplete="off" placeholder="填写模型 ID" value={draft.model} onChange={event => update({ model: event.target.value })} /></label>}
        <div className="voice-model-tools">{providerId && <ModelActions loading={loading} disabled={disabled} manual={manualModel} refresh={() => setRevision(value => value + 1)} toggle={() => setManualModel(value => !value)} />}<ProtocolMatch check={check} disabled={disabled} /></div>
      </div>
    </div>
    {providerId && !manualModel && !loading && !models.length && <p className="voice-provider-hint">没有可选模型，可手动填写。</p>}
    {error && <p role="status" className="voice-settings-error">{error}；可手动填写模型 ID。</p>}
    {name === 'tts' && <div className="voice-sound-fields"><label>音色<input type="text" autoComplete="off" placeholder="留空使用默认音色" value={draft.voice} onChange={event => update({ voice: event.target.value })} /></label><label className="voice-speed-field"><span className="voice-field-label">语速 <output>{normalizeTtsSpeed(draft.speed).toFixed(2)}×</output></span><input type="range" min={TTS_SPEED_MIN} max={TTS_SPEED_MAX} step="0.05" value={normalizeTtsSpeed(draft.speed)} aria-label="语速" onChange={event => update({ speed: normalizeTtsSpeed(event.target.value) })} /></label></div>}
    {!supported && <p role="alert" className="voice-settings-error">当前协议 {draft.protocol} 已不支持，请在高级设置中重新选择。</p>}
    <ProtocolStatus check={check} name={name} draft={draft} config={config} justSaved={justSaved} />
    <Disclosure title="高级设置" open={advanced} onOpenChange={setAdvanced} className="voice-connection-settings">
      <div className="voice-protocol-fields"><VoiceSelect label="接口类型" value={draft.apiType} options={VOICE_API_TYPES} disabled={disabled} onChange={apiType => update({ apiType, protocol: '' })} placeholder="选择接口类型" />
      <VoiceSelect label="协议" value={draft.protocol} options={protocolOptions(name, draft.apiType || undefined)} placeholder="选择协议" disabled={disabled} onChange={protocol => update({ protocol })} /></div>
      {name === 'asr' && draft.protocol === 'openai-websocket' && <label>WebSocket 地址<input type="url" autoComplete="off" placeholder="留空使用默认地址" value={draft.realtime?.url || ''} onChange={event => update({ realtime: { ...draft.realtime, url: event.target.value } })} /></label>}
      {name === 'tts' && <Toggle label="流式播放" detail="收到音频即播放" checked={draft.stream !== false} onChange={stream => update({ stream })} />}
      {!providerId && <><label>API 地址<input type="url" inputMode="url" autoComplete="off" placeholder="https://api.example.com/v1" value={draft.baseURL} onChange={event => update({ baseURL: event.target.value })} /></label><label>API Key<div className="voice-key-field"><input type="password" autoComplete="new-password" spellCheck={false} placeholder={clearKey ? '保存后清除密钥' : config?.apiKeyConfigured ? '已配置，留空保留' : '填写 API Key'} value={draft.apiKey} onChange={event => update({ apiKey: event.target.value })} />{(config?.apiKeyConfigured || clearKey) && <button type="button" onClick={toggleClear}>{clearKey ? '撤销清除' : '清除密钥'}</button>}</div></label></>}
      <ProtocolCheck check={check} draft={draft} name={name} disabled={disabled} />
    </Disclosure>
  </fieldset>;
}
const voiceTabs = [{ id: 'dictation', label: '语音转文本', detail: '转为草稿，确认后发送', kinds: ['asr'] }, { id: 'readAloud', label: '朗读', detail: '自动朗读新的回复', kinds: ['tts'] }, { id: 'call', label: '实时通话', detail: '直接交谈，随时打断', kinds: ['asr', 'tts'] }];
const callSettingsTabs = [{ value: 'conversation', label: '交互模型' }, { value: 'asr', label: '语音识别' }, { value: 'tts', label: '语音合成' }];
function ListeningSettings({ draft, config, update, clearKey, toggleClear, disabled }) {
  const [checking, setChecking] = useState(false), [result, setResult] = useState(null), [error, setError] = useState('');
  const operation = useRef(null), identity = JSON.stringify([draft, !!clearKey]);
  useEffect(() => {
    operation.current?.abort(); operation.current = null; setChecking(false); setResult(null); setError('');
    return () => operation.current?.abort();
  }, [identity]);
  useEffect(() => { if (disabled) { operation.current?.abort(); operation.current = null; setChecking(false); } }, [disabled]);
  const testConnection = async () => {
    operation.current?.abort(); const abort = new AbortController(); operation.current = abort;
    setChecking(true); setResult(null); setError('');
    const config = { ...draft }; if (!config.apiKey?.trim()) delete config.apiKey;
    try {
      const response = await voiceProtocolRequest('listening.test', { config, clearApiKey: !!clearKey }, abort.signal);
      if (!abort.signal.aborted) setResult(response.result);
    } catch (failure) { if (!abort.signal.aborted) setError(failure.message || '连接测试失败，请检查地址和密钥。'); }
    finally { if (operation.current === abort) { operation.current = null; setChecking(false); } }
  };
  const availableName = config?.superagentAvailable && config.superagentName || '';
  const wakeWord = draft.wakeSource === 'superagent' ? availableName : draft.wakeWord.trim();
  const routeChanged = draft.endpoint !== (config?.endpoint ?? listeningDraft().endpoint);
  const canTest = !!draft.endpoint.trim() && !clearKey && !!(draft.apiKey.trim() || config?.apiKeyConfigured && !routeChanged);
  return <fieldset disabled={disabled} aria-label="决策设置" className="voice-provider-settings voice-listening-settings">
    <p className="voice-provider-hint">仅保存配置并支持固定示例测试，通话内容不会发送到决策服务。</p>
    <Toggle label="判断是否在对我说话" checked={draft.enabled} onChange={enabled => update({ enabled })} />
    <label>决策接口地址<input type="url" inputMode="url" autoComplete="off" spellCheck={false} value={draft.endpoint} placeholder="填写完整决策接口地址" onChange={event => update({ endpoint: event.target.value })} /></label>
    <label>决策模型 ID<input autoComplete="off" spellCheck={false} value={draft.model} placeholder="填写模型 ID（接口支持时可留空）" onChange={event => update({ model: event.target.value })} /></label>
    <label>决策 API Key<div className="voice-key-field"><input aria-label="决策 API Key" type="password" autoComplete="new-password" spellCheck={false} placeholder={clearKey ? '保存后清除密钥' : config?.apiKeyConfigured ? '已配置，留空保留' : '填写 API Key'} value={draft.apiKey} onChange={event => update({ apiKey: event.target.value })} />{(config?.apiKeyConfigured || clearKey) && <button type="button" onClick={toggleClear}>{clearKey ? '撤销清除' : '清除密钥'}</button>}</div></label>
    <div className="voice-listening-check"><button type="button" className="voice-text-button" disabled={disabled || checking || !canTest} aria-busy={checking} onClick={testConnection}>{checking ? '正在测试…' : '测试连接'}</button>{checking && <button type="button" className="voice-text-button" onClick={() => { operation.current?.abort(); operation.current = null; setChecking(false); }}>取消</button>}<span role="status">{result?.supported ? '连接可用' + (Number.isFinite(result.latencyMs) ? ` · ${Math.round(result.latencyMs)}ms` : '') : checking ? '正在判断固定示例' : '仅发送固定示例，不使用会话内容'}</span></div>
    {error && <p role="alert" className="voice-settings-error">{error}</p>}
    <VoiceSelect label="唤醒词来源" value={draft.wakeSource} options={[{ value: 'custom', label: '自定义' }, { value: 'superagent', label: '跟随 SuperAgent 称呼', hint: availableName || '暂无可用的称呼', disabled: !availableName }]} disabled={disabled} onChange={wakeSource => update({ wakeSource })} />
    {routeChanged && config?.apiKeyConfigured && !draft.apiKey.trim() && <p role="status" className="voice-provider-hint">地址已修改，请填写此地址的密钥，或保存地址后再测试。</p>}
    {draft.wakeSource === 'custom' && <label>唤醒词<input autoComplete="off" maxLength={100} value={draft.wakeWord} placeholder="填写称呼；留空仅依据上下文判断" onChange={event => update({ wakeWord: event.target.value })} /></label>}
    <p className="voice-listening-word" role="status">{draft.wakeSource === 'superagent' && !availableName ? 'SuperAgent 称呼暂不可用，请设置称呼或选择自定义。' : wakeWord ? `当前称呼：${wakeWord}` : '未设置称呼，仅依据上下文判断。'}</p>
    {config?.unavailableReason && draft.enabled && <p role="status" className="voice-provider-hint">当前保存的配置：{config.unavailableReason}</p>}
  </fieldset>;
}
function ConversationSettings({ draft, config, catalog, update, disabled }) {
  const [models, setModels] = useState([]), [loading, setLoading] = useState(false), [error, setError] = useState(''), [manual, setManual] = useState(false), [revision, setRevision] = useState(0);
  const providerId = draft.providerId;
  useEffect(() => {
    setModels([]); setError(''); setLoading(false); setManual(false);
    if (!providerId) return;
    const abort = new AbortController(); setLoading(true);
    modelCatalog('models', { providerId }, abort.signal).then(data => { if (!abort.signal.aborted) setModels(data.models || []); }).catch(failure => { if (!abort.signal.aborted) setError(failure.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [providerId, revision]);
  const options = mediaProviderOptions(catalog, providerId, { standalone: { value: '', label: '使用原会话模型' } });
  const savedRoute = providerId === config?.providerId && draft.model === config?.model;
  return <fieldset disabled={disabled} className="voice-provider-settings"><legend>交互模型</legend>
    <p className="voice-provider-hint">默认关闭思考。SuperAgent 沿用自己的模型。</p>
    <div className="voice-route-fields">
      <VoiceSelect label="交互模型供应商" value={providerId} options={options} disabled={disabled} onChange={id => { if (id !== providerId) update({ providerId: id, model: '' }); }} />
      {providerId && <div className="voice-model-field">
        {manual || !models.length && !loading ? <label>交互模型 ID<input type="text" autoComplete="off" placeholder="填写模型 ID" value={draft.model} onChange={event => update({ model: event.target.value })} /></label> : <VoiceSelect label="交互模型" value={draft.model} options={models.map(item => ({ value: item.id, label: item.name || item.id, hint: item.id }))} placeholder={loading ? '正在获取模型…' : '选择交互模型'} disabled={disabled || loading} onChange={model => update({ model })} />}
        <div className="voice-model-tools"><ModelActions loading={loading} disabled={disabled} manual={manual} refresh={() => setRevision(value => value + 1)} toggle={() => setManual(value => !value)} /></div>
      </div>}
    </div>
    {providerId && error && <p role="status" className="voice-settings-error">模型列表读取失败：{error}，可手动填写。</p>}
    <p className={'media-availability' + (savedRoute && config?.configured ? ' is-available' : '')} role="status">{!providerId ? '未配置，使用原会话模型。' : savedRoute && config?.unavailableReason ? '当前配置不可用：' + config.unavailableReason : ''}</p>
  </fieldset>;
}
const mediaTabs = [
  { id: 'image', label: '图片', icon: 'picture', capabilities: ['image-generation', 'image-edit'] },
  { id: 'video', label: '视频', icon: 'category', capabilities: ['video'] },
  { id: 'audio', label: '音频', icon: 'volume', capabilities: ['tts'] },
];

function useMediaProviders() {
  const [providers, setProviders] = useState([]), [error, setError] = useState('');
  const [loading, setLoading] = useState(true), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError('');
    modelCatalog('providers', {}, abort.signal)
      .then(data => { if (!abort.signal.aborted) setProviders(data.providers || []); })
      .catch(failure => { if (!abort.signal.aborted) setError(failure.message); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [attempt]);
  return { providers, error, loading, reload: () => setAttempt(value => value + 1) };
}

async function requestMediaSettings(signal, update) {
  const response = await fetch(new URL('api/benchgo/media/settings', document.baseURI), {
    credentials: 'same-origin',
    signal,
    ...(update ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(update) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(Error(response.status === 404 ? '媒体服务未连接。请检查「设置 → 插件」中的媒体模块状态。' : data?.error || '媒体设置请求失败'), { status: response.status });
  if (!data?.settings) throw Error('媒体设置响应格式有误');
  return data.settings;
}

const settingsTabs = [{ value: 'generation', label: '媒体生成' }, { value: 'voice', label: '语音' }];

function MediaSettings({ openModels, controller }) {
  const { voice: voiceReady } = useSyncExternalStore(moduleSource.subscribe, moduleSource.getSnapshot);
  const voice = controller ?? (voiceReady ? activeController : undefined);
  const tab = useSyncExternalStore(subscribeSettingsTab, readSettingsTab);
  const id = useId();
  const catalog = useMediaProviders();
  return <section className="voice-settings media-settings">
    <header className="media-settings-navigation"><h2>媒体</h2>
      <SegmentedControl options={settingsTabs} value={tab} onChange={selectSettingsTab}
        label="媒体设置" tabIdPrefix={id} panelId={id + '-panel'} />
    </header>
    <div id={id + '-panel'} role="tabpanel" aria-labelledby={id + '-' + tab}>
      <div hidden={tab !== 'generation'}><GenerationSettings catalog={catalog} openModels={openModels} /></div>
      <div hidden={tab !== 'voice'}>{voice
        ? <VoiceSettings controller={voice} catalog={catalog} />
        : <div className="media-settings-state" role="status"><UIIcon name="mic" size={24} /><strong>语音设置暂不可用</strong><p>请检查「设置 → 插件」中的媒体模块状态。</p></div>}</div>
    </div>
  </section>;
}

function GenerationSettings({ catalog, openModels }) {
  const tabsId = useId(), [tab, setTab] = useState('image');
  const [original, setOriginal] = useState(null), [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(''), [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const active = mediaTabs.find(item => item.id === tab);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setLoadError('');
    requestMediaSettings(abort.signal).then(settings => {
      if (abort.signal.aborted) return;
      setDraft(settings);
      setOriginal(settings);
    }).catch(failure => { if (!abort.signal.aborted) setLoadError(failure.message); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [attempt]);

  const change = update => { setDraft(value => ({ ...value, [tab]: { ...value[tab], ...update } })); setError(''); setSaved(false); };
  const reload = () => { setError(''); setSaved(false); setAttempt(value => value + 1); };
  const dirty = !!draft && mediaTabs.some(({ id }) => draft[id] !== original[id]);
  const save = async event => {
    event.preventDefault();
    if (!dirty || busy || loading) return;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const settings = await requestMediaSettings(undefined, { settings: mediaSettingsPayload(draft, original), revision: original.revision });
      setOriginal(settings);
      setDraft(settings);
      setSaved(true);
    } catch (failure) {
      setError(failure.status === 409 ? '媒体配置已在其他页面更新。请选择重新加载后再保存。' : failure.message || '保存失败');
    } finally { setBusy(false); }
  };

  return <>
    <SegmentedControl options={mediaTabs.map(item => ({
        value: item.id, label: item.label, icon: <UIIcon name={item.icon} size={16} />,
      }))} value={tab} onChange={setTab} label="媒体类型" tabIdPrefix={tabsId} panelId={tabsId + '-panel'} />
    <div id={tabsId + '-panel'} role="tabpanel" aria-labelledby={tabsId + '-' + tab}>
      {!draft ? loadError ? <div className="media-settings-state" role="alert"><UIIcon name="close" size={24} /><strong>暂时无法加载媒体设置</strong><p>{loadError}</p><Button variant="ghost" onClick={reload}>重新加载</Button></div>
          : <Loading label="正在加载媒体设置…" />
        : <form className="voice-settings-content" onSubmit={save} aria-busy={loading || busy}>
          <GenerationRoutes key={tab} kind={active} value={draft[tab]} catalog={catalog} openModels={openModels} update={change} disabled={loading || busy} />
          {catalog.error && <p className="voice-settings-error" role="alert">供应商目录读取失败：{catalog.error} <Button variant="ghost" disabled={catalog.loading || busy} onClick={catalog.reload}>重试</Button></p>}
          {loadError && <p className="voice-settings-error" role="alert">媒体配置刷新失败：{loadError}</p>}
          {error && <p className="voice-settings-error" role="alert">{error}</p>}
          <footer><button className="voice-save" type="submit" disabled={!dirty || busy || loading}>{busy ? '保存中…' : '保存设置'}</button>
            <span role="status">{loading ? '正在刷新' : saved ? '已保存' : dirty ? '有未保存的修改' : ''}</span>
            {(loadError || error) && <Button variant="ghost" disabled={loading || busy} onClick={reload}>{dirty ? '放弃修改并重新加载' : '重新加载'}</Button>}
          </footer>
        </form>}
    </div>
  </>;
}

function GenerationRoutes({ kind, value, catalog, openModels, update, disabled }) {
  const { enabled, routes } = value;
  const writeRoutes = routes => update({ routes });
  const add = () => writeRoutes([...routes, { providerId: '', modelId: '' }]);
  const remove = index => writeRoutes(routes.filter((_, row) => row !== index));
  const move = (index, step) => {
    const next = [...routes];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    writeRoutes(next);
  };
  const title = kind.label + '生成';
  const hasProviders = catalog.providers.some(item => item.configured && item.authMode !== 'subscription');
  return <fieldset className="voice-provider-settings" disabled={disabled}>
    <Toggle label={'在对话中生成' + kind.label} checked={enabled} onChange={enabled => update({ enabled })} disabled={disabled} />
    {routes.length > 0 ? <>
      <div className="media-route-heading" aria-hidden="true"><span>供应商</span><span>模型 ID</span></div>
      {routes.map((route, index) => <GenerationRoute key={index} kind={kind} route={route} position={index + 1}
        catalog={catalog} disabled={disabled} canMoveUp={index > 0} canMoveDown={index + 1 < routes.length}
        update={next => writeRoutes(routes.map((previous, row) => row === index ? next : previous))}
        remove={() => remove(index)} move={step => move(index, step)} />)}
      {routes.length < 3 && <Button variant="ghost" size="sm" className="media-add-route" onClick={add}><UIIcon name="plus" size={16} />添加备用模型</Button>}
    </> : <div className="media-settings-state" role="status">
        <UIIcon name={kind.icon} size={24} /><strong>还没有{title}模型</strong>
        <p>{catalog.loading ? '正在读取可用供应商…' : '添加首选模型后，可配置备用模型。'}</p>
        {!catalog.loading && (hasProviders
          ? <Button variant="ghost" onClick={add}>添加模型</Button>
          : openModels && <Button variant="ghost" onClick={openModels}>前往模型设置</Button>)}
    </div>}
  </fieldset>;
}

function GenerationRoute({ kind, route, position, catalog, disabled, canMoveUp, canMoveDown, update, remove, move }) {
  const id = useId();
  const { providerId, modelId } = route;
  const audio = kind.id === 'audio';
  const providerOptions = mediaProviderOptions(catalog, providerId, { generation: true });
  const actions = [
    ...(canMoveUp ? [{ id: 'up', label: '上移', icon: <IconChevronUpOutlineRegular />, run: () => move(-1) }] : []),
    ...(canMoveDown ? [{ id: 'down', label: '下移', icon: <IconChevronDownOutlineRegular />, run: () => move(1) }] : []),
    { id: 'remove', label: '移除模型', icon: <UIIcon name="trash" size={16} />, danger: true, run: remove },
  ];
  return <div className="media-route" role="group" aria-labelledby={id}>
    <span id={id} className="media-route-position">顺位 {position}</span>
    <VoiceSelect label="模型供应商" hideLabel value={providerId} options={providerOptions} disabled={disabled}
      onChange={id => { if (id !== providerId) update({ providerId: id, modelId: '' }); }} />
    <GenerationModel key={providerId} kind={kind} providerId={providerId} modelId={modelId} position={position}
      disabled={disabled} actions={actions} update={next => {
        if (next !== modelId) update({ ...route, modelId: next, ...(audio && { voices: undefined, defaultVoice: undefined }) });
      }} />
    {audio && providerId && modelId.trim() && <GenerationVoices id={id} voices={route.voices} defaultVoice={route.defaultVoice}
      update={(voices, defaultVoice) => update({ ...route, voices, defaultVoice })} />}
  </div>;
}

function GenerationVoices({ id, voices = [], defaultVoice, update }) {
  const defaultIndex = Math.max(0, voices.findIndex(voice => voice.name === defaultVoice));
  const edit = (index, field, value) => {
    const next = voices.map((voice, row) => row === index ? { ...voice, [field]: value } : voice);
    update(next, next[defaultIndex].name);
  };
  const remove = index => {
    const next = voices.filter((_, row) => row !== index);
    update(next, index === defaultIndex ? next[0]?.name : defaultVoice);
  };
  return <div className="media-voices" role="group" aria-labelledby={id + '-voices'}>
    <div className="media-voices-header">
      <strong id={id + '-voices'}>音色</strong>
      <Button variant="ghost" size="sm" disabled={voices.length >= 20} onClick={() => update([...voices, { name: '' }], defaultVoice)}>
        <UIIcon name="plus" size={16} />添加音色
      </Button>
    </div>
    {voices.map(({ name, description }, index) => <div className="media-voice-row" key={index}>
      <input type="text" className="media-route-input" aria-label={'音色名称 ' + (index + 1)} placeholder="供应商音色名称"
        autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={100} value={name}
        onChange={event => edit(index, 'name', event.target.value)} />
      <input type="text" className="media-route-input media-voice-description" aria-label={'听感说明 ' + (index + 1)}
        placeholder="听感说明（选填）" maxLength={160} value={description ?? ''} onChange={event => edit(index, 'description', event.target.value)} />
      <label className="media-voice-default">
        <input type="radio" name={id + '-default-voice'} aria-label={'将音色 ' + (index + 1) + '设为默认'}
          checked={index === defaultIndex} disabled={!name} onChange={() => update(voices, name)} />默认
      </label>
      <Hint label="移除音色"><Button variant="ghost" size="icon" className="media-voice-remove" aria-label={'移除音色 ' + (index + 1)}
        onClick={() => remove(index)}><UIIcon name="trash" size={16} /></Button></Hint>
    </div>)}
  </div>;
}

function GenerationModel({ kind, providerId, modelId, position, disabled, actions, update }) {
  const [models, setModels] = useState([]), [loading, setLoading] = useState(!!providerId);
  const [manual, setManual] = useState(false), [error, setError] = useState(''), [attempt, setAttempt] = useState(0), [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!providerId) return;
    const abort = new AbortController();
    setLoading(true);
    setError('');
    modelCatalog('models', { providerId }, abort.signal)
      .then(data => { if (!abort.signal.aborted) setModels((data.models || []).filter(model => kind.capabilities.some(capability => model.capabilities?.includes(capability)))); })
      .catch(failure => { if (!abort.signal.aborted) setError(failure.message); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [providerId, kind, attempt]);
  const options = models.map(model => ({ value: model.id, label: model.name || model.id, hint: model.name !== model.id ? model.id : '' }));
  if (modelId && !models.some(item => item.id === modelId)) options.push({ value: modelId, label: modelId, hint: '目录未标记此能力，已保留原始 ID' });
  const items = [
    { id: 'refresh', label: loading ? '正在刷新列表…' : '刷新列表', icon: <UIIcon name="refresh" size={16} />, disabled: !providerId || loading, run: () => setAttempt(value => value + 1) },
    { id: 'manual', label: manual ? '从列表选择' : '手动填写', icon: <UIIcon name={manual ? 'category' : 'edit'} size={16} />, disabled: !providerId, run: () => setManual(value => !value) },
    ...actions,
  ];
  return <>
    {manual ? <input className="media-route-input" aria-label="模型 ID" autoComplete="off" autoCapitalize="none" spellCheck={false}
      value={modelId} placeholder="填写模型 ID" disabled={disabled} onChange={event => update(event.target.value)} />
      : <VoiceSelect label="模型 ID" hideLabel value={modelId} options={options} disabled={disabled || !providerId || (loading && !options.length)}
        placeholder={loading ? '正在获取模型…' : '选择模型'} onChange={update} />}
    <Menu open={menuOpen && !disabled} onClose={() => setMenuOpen(false)} items={items}
      onSelect={id => { setMenuOpen(false); items.find(item => item.id === id)?.run(); }}
      align="end" portal dense autoFocus listClassName="media-route-menu-list"
      anchor={<Button variant="ghost" size="icon" className="media-route-menu-trigger" title="模型操作"
        aria-label={'顺位 ' + position + ' 模型操作'} aria-haspopup="menu" aria-expanded={menuOpen && !disabled}
        aria-busy={loading} disabled={disabled} onClick={() => setMenuOpen(open => !open)}>
        <UIIcon name={loading ? 'refresh' : 'more'} size={16} />
      </Button>} />
    {error ? <p className="media-route-message voice-settings-error" role="status">模型列表读取失败：{error}。可手动填写模型 ID。</p>
      : providerId && !loading && !models.length && !manual && <p className="media-route-message voice-provider-hint" role="status">目录中没有标记为此能力的模型，可手动填写。</p>}
  </>;
}

function VoiceSettings({ controller, catalog }) {
  const { error: catalogError, reload: reloadProviders } = catalog;
  const state = useVoice(controller), [draft, setDraft] = useState(null), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false), [clearKeys, setClearKeys] = useState({}), [tab, setTab] = useState('dictation');
  const original = useRef(null);
  const tabsId = useId();
  const [callSection, setCallSection] = useState('conversation');
  const callTabsId = useId();
  useEffect(() => { if (state.config && !dirty) { original.current = draftFrom(state.config); setDraft(original.current); } }, [state.config, dirty]);
  const update = (field, value) => { setDraft(current => ({ ...current, [field]: value })); setDirty(true); setSaved(false); };
  const endpoint = (name, patch) => { setDraft(current => ({ ...current, [name]: { ...current[name], ...patch } })); setDirty(true); setSaved(false); if (patch.apiKey || patch.providerId) setClearKeys(current => ({ ...current, [name]: false })); };
  const save = async event => {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    try {
      const patch = voiceSettingsPatch(draft, original.current, clearKeys); await controller.configure(patch);
      setDirty(false); setClearKeys({}); setSaved(true);
    } catch (failure) { setError(failure.message || '保存失败'); } finally { setBusy(false); }
  };
  if (!draft) return <section className="voice-settings-content">{state.error ? <div className="media-settings-state" role="status"><UIIcon name="mic" size={24} /><strong>暂时无法加载语音设置</strong><p>{state.error}</p><button type="button" className="voice-text-button" onClick={() => controller.load().catch(failure => setError(failure.message))}>重新加载</button></div> : <Loading label="正在加载语音设置…" />}{error && <p role="alert" className="voice-settings-error">{error}</p>}</section>;
  const current = voiceTabs.find(item => item.id === tab);
  const providerSettings = name => <ProviderSettings key={name} name={name} draft={draft[name]} config={state.config?.[name]} catalog={catalog} update={patch => endpoint(name, patch)} clearKey={clearKeys[name]} toggleClear={() => { setClearKeys(value => ({ ...value, [name]: !value[name] })); endpoint(name, { apiKey: '' }); }} disabled={busy} hideTitle={tab === 'call'} requirement={tab === 'call' ? 'streaming' : 'any'} formDraft={draft} justSaved={saved} />;
  return <form className="voice-settings-content" onSubmit={save}>
    <SegmentedControl options={voiceTabs.map(item => ({ value: item.id, label: item.label }))} value={tab} onChange={setTab} label="语音交互方式" tabIdPrefix={tabsId} panelId={tabsId + '-panel'} />
    <div className="voice-tab-panel" key={tab} id={tabsId + '-panel'} role="tabpanel" aria-labelledby={tabsId + '-' + tab}>
      <fieldset disabled={busy} className="voice-mode-settings"><Toggle label={current.label} detail={current.detail} checked={draft[tab]} onChange={value => update(tab, value)} disabled={busy} /></fieldset>
      {tab === 'call' ? <>{callStreamingReason(draft) && <p role="status" className="voice-settings-error">{callStreamingReason(draft)}，请调整高级设置。</p>}<SegmentedControl options={callSettingsTabs} value={callSection} onChange={setCallSection} label="通话设置" tabIdPrefix={callTabsId} panelId={callTabsId + '-panel'} /><div className="voice-call-settings-panel" id={callTabsId + '-panel'} role="tabpanel" aria-labelledby={callTabsId + '-' + callSection}>{callSection === 'conversation' ? <><ConversationSettings draft={draft.conversation} config={state.config?.conversation} catalog={catalog} update={patch => endpoint('conversation', patch)} disabled={busy} /><Disclosure title="决策（未接入通话）" className="voice-connection-settings"><ListeningSettings draft={draft.listening} config={state.config?.listening} update={patch => endpoint('listening', patch)} clearKey={clearKeys.listening} toggleClear={() => { setClearKeys(value => ({ ...value, listening: !value.listening })); endpoint('listening', { apiKey: '' }); }} disabled={busy} /></Disclosure></> : providerSettings(callSection)}</div></> : current.kinds.map(providerSettings)}
    </div>
    {catalogError && <p role="status" className="voice-provider-hint">暂时无法读取已有供应商：{catalogError}。仍可独立配置。{reloadProviders && <Button variant="ghost" onClick={reloadProviders}>重试</Button>}</p>}
    <footer><button className="voice-save" type="submit" disabled={busy || !dirty}>{busy ? '保存中…' : '保存设置'}</button><span role="status">{saved ? '已保存' : dirty ? '有未保存的修改' : ''}</span></footer>{(error || state.error) && <p role="alert" className="voice-settings-error">{error || state.error}</p>}
  </form>;
}
