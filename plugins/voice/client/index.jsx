import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Tooltip, IconMicrophoneOutlineMedium, IconStopFillRegular, IconChevronUpOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { createVoiceController } from './controller.mjs';
import { generatedMediaDraft, generatedMediaPatch, voiceSettingsPatch } from './settings-state.mjs';
import { moduleSource } from '../../benchgo/client/modules.mjs';
import css from './style.css';
import mediaCss from './media-settings.css';
import { SegmentedControl } from '../../shared/client/segmented-control.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';

export const inject = ['slots', 'sessions', 'conversation', 'uiSession', 'connection'];
let activeController;
export function apply(ctx) {
  const controller = createVoiceController(ctx);
  activeController = controller;
  ctx.effect(() => async () => { if (activeController === controller) activeController = undefined; await controller.dispose(); });
  ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({ name: 'conversation.input.activity', priority: -10, inject: () => ({ controller, openSettings: () => { const shell = ctx.slots.entries('sidebar.settings').find(entry => entry.children?.['settings.section']); const actions = shell?.store?.create().actions; if (!actions?.openSection) throw Error('请从侧栏设置 → 媒体 → 语音打开配置。'); actions.openSection('media'); } }) }, VoiceActivity));
  void controller.load().catch(() => {});
}
/** Base owns the shared settings entry; optional modules own their working forms. */
export function mountMediaSettings(ctx) {
  const style = document.createElement('style'); style.textContent = css + mediaCss; document.head.append(style);
  ctx.effect(() => () => style.remove());
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'media', order: 35, label: () => '媒体' }, MediaSettings));
}
function useVoice(controller) { return useSyncExternalStore(fn => controller.state.subscribe(fn), () => controller.state.getSnapshot()); }
function Hint({ label, children }) { return <Tooltip label={label} delayMs={450} portal>{children}</Tooltip>; }
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
function Microphone({ muted = false }) { return <span className={'voice-microphone-icon' + (muted ? ' voice-microphone-muted' : '')} aria-hidden="true"><IconMicrophoneOutlineMedium size={18} /></span>; }
function CallOrb({ state }) {
  const phase = state.muted && state.phase === 'listening' ? 'muted' : state.phase;
  const level = Math.max(0, Math.min(1, Number(state.phase === 'speaking' ? state.playbackLevel || 0 : state.muted ? 0 : state.level || 0)));
  return <span className={'voice-call-orb voice-orb-' + phase} aria-hidden="true" style={{ '--voice-level': level }}><span className="voice-orb-aura" /><span className="voice-orb-body"><span className="voice-orb-cloud" /><span className="voice-orb-shine" /></span></span>;
}
function VoiceActivity({ controller, sessionId, inputActions, locked, onActiveChange, openSettings }) {
  const state = useVoice(controller), [pending, setPending] = useState(false), [error, setError] = useState('');
  const generation = useRef(0), activityRef = useRef(null);
  const own = state.sessionId === sessionId, active = own && state.mode !== 'idle';
  const recording = active && state.mode === 'dictation', calling = active && state.mode === 'call';
  const reading = own && state.readEnabled && state.phase === 'speaking';
  // Keep the draft mounted; restore editable controls after call/session teardown.
  useEffect(() => {
    if (!calling) return;
    const activity = activityRef.current, card = activity?.closest('[data-composer-card]');
    if (!card) return;
    card.classList.add('voice-call-composer');
    const previous = [...card.children].filter(child => !child.contains(activity)).map(child => [child, child.inert]);
    for (const [child] of previous) child.inert = true;
    return () => { card.classList.remove('voice-call-composer'); for (const [child, inert] of previous) child.inert = inert; };
  }, [calling, sessionId]);
  useEffect(() => { onActiveChange?.(active); return () => onActiveChange?.(false); }, [active, onActiveChange]);
  useEffect(() => {
    generation.current++; setError(''); setPending(false);
    controller.selectSession?.(sessionId);
    return () => { generation.current++; if (controller.state.getSnapshot().sessionId === sessionId) void controller.hangup(); };
  }, [controller, sessionId]);
  const run = async operation => {
    const version = generation.current; setPending(true); setError('');
    try { await operation(); } catch (failure) { if (version === generation.current) setError(failure.message || '语音操作失败'); }
    finally { if (version === generation.current) setPending(false); }
  };
  const config = state.config;
  if (!config) return state.error ? <span className="voice-inline-error" role="status">语音配置加载失败，请在设置中重试</span> : null;
  const asrReady = !!(config.asr?.configured && config.asr?.model && ['transcriptions-sse', 'transcriptions', 'openai-websocket'].includes(config.asr?.protocol || 'transcriptions-sse')), ttsReady = !!(config.tts?.configured && config.tts?.model && ['speech', 'speech-stream'].includes(config.tts?.protocol || 'speech'));
  const unavailable = [!asrReady && 'ASR', !ttsReady && 'TTS'].filter(Boolean).join('、');
  const recovery = state.recoverySessionId === sessionId && state.recoveryText;
  const recoveryPanel = recovery && <div className="voice-recovery" role="region" aria-label="待恢复的语音文字"><p>{recovery}</p><div className="voice-recovery-actions">{calling && <button type="button" className="voice-text-button" disabled={pending || !state.canRetry} onClick={() => run(() => controller.retryPending())}>重试发送</button>}<button type="button" className="voice-text-button" disabled={pending} onClick={() => run(async () => { if (!navigator.clipboard?.writeText) throw Error('当前环境无法复制，请选择文字手动复制。'); await navigator.clipboard.writeText(recovery); })}>复制文字</button>{state.mode === 'idle' && <button type="button" className="voice-text-button" disabled={pending || locked} onClick={() => run(() => controller.recoverToDraft(inputActions))}>转入草稿</button>}<button type="button" className="voice-text-button" disabled={pending} onClick={() => run(() => controller.discardRecovery())}>丢弃</button></div></div>;
  const canStart = !locked && !pending && state.mode === 'idle';
  const message = error || (own || state.mode === 'idle' ? state.error : '');
  if (calling) return <div ref={activityRef} className={'voice-activity voice-expanded voice-calling voice-call-phase-' + state.phase}>
    <div className="voice-call-panel" role="group" aria-label="实时语音通话">
      <div className="voice-call-visual"><CallOrb state={state} /><span className="voice-call-caption" role="status">{state.muted && state.phase === 'listening' ? '麦克风已关闭' : phaseLabels[state.phase] || '语音处理中'}</span></div>
      <div className="voice-call-controls">
        <Hint label={state.muted ? '开启麦克风' : '关闭麦克风'}><button type="button" className="voice-icon-button voice-call-mic" aria-label={state.muted ? '开启麦克风' : '关闭麦克风'} aria-pressed={!!state.muted} disabled={pending} onClick={() => run(() => controller.setMuted(!state.muted))}><Microphone muted={state.muted} /></button></Hint>
        <span className={'voice-call-transcript' + (message ? ' voice-call-error' : '')} role={message ? 'alert' : undefined}>{message || state.transcript || (state.muted ? '麦克风已关闭，仍可收听回复' : '直接说话，随时可以打断')}</span>
        <Hint label="结束通话"><button type="button" className="voice-icon-button voice-call-stop" aria-label="结束语音通话" onClick={() => run(() => controller.hangup())}><IconStopFillRegular size={16} /></button></Hint>
      </div>
    </div>
    {recoveryPanel}
  </div>;
  return <div ref={activityRef} className={'voice-activity ' + (active ? 'voice-expanded ' : '') + (recording ? 'voice-dictating' : '')}>
    {recording ? <div className="voice-recording-strip"><span className="voice-recording-pulse" role="img" aria-label="麦克风实时音量" style={{ '--voice-level': state.level || 0 }}>{Array.from({ length: 31 }, (_, i) => <i key={i} style={{ '--voice-band': .22 + .78 * Math.abs(Math.sin(i * 1.7)) }} />)}</span><span className="voice-recording-caption" role="status">{state.transcript || '正在聆听'}</span><Hint label="停止转录"><button type="button" className="voice-icon-button voice-stop-recording" aria-label="停止语音转录" onClick={() => run(() => controller.stopDictation())}><IconStopFillRegular size={16} /></button></Hint></div> : config.dictation && !calling && <Hint label={asrReady ? '语音转文本' : '请先在设置 → 媒体 → 语音中配置 ASR 模型'}><button type="button" className="voice-icon-button" data-available={asrReady} aria-label="语音转文本" disabled={!canStart || !asrReady} onClick={() => run(() => controller.startDictation({ sessionId, inputActions }))}><IconMicrophoneOutlineMedium size={18} /></button></Hint>}
    {config.readAloud && <Hint label={!ttsReady ? 'TTS 不可用，请打开设置 → 媒体 → 语音' : state.readEnabled ? '自动朗读开启' : '自动朗读关闭'}><button type="button" className="voice-icon-button voice-read-button" data-available={ttsReady} aria-label={!ttsReady ? 'TTS 不可用，请打开设置 → 媒体 → 语音' : state.readEnabled ? '自动朗读开启' : '自动朗读关闭'} aria-pressed={!!state.readEnabled} disabled={!ttsReady && !state.readEnabled} onClick={() => run(() => controller.toggleRead(sessionId))}><Speaker active={!!state.readEnabled} /></button></Hint>}
    {config.call && !recording && <Hint label={asrReady && ttsReady ? "开始通话" : unavailable + " 不可用，请打开设置 → 媒体 → 语音"}><button type="button" className="voice-icon-button voice-call-button" data-available={asrReady && ttsReady} aria-label="开始语音通话" disabled={!canStart || !asrReady || !ttsReady} onClick={() => run(() => controller.startCall({ sessionId, inputActions }))}><CallIcon /></button></Hint>}
    {!recording && (active || reading) && <div className={'voice-status voice-phase-' + state.phase} role="status"><span className="voice-status-dot" /><span className="voice-status-text">{state.transcript || phaseLabels[state.phase] || '语音处理中'}</span></div>}
    {!active && pending && <span className="voice-inline-note" role="status">连接中…</span>}
    {unavailable && <button type="button" className="voice-text-button voice-settings-link" onClick={() => run(() => { if (!openSettings) throw Error('请打开设置 → 媒体 → 语音'); openSettings(); })}>{unavailable} 不可用 · 配置语音</button>}
    {recoveryPanel}
    {message && <span className="voice-inline-error" role="alert">{message}</span>}
  </div>;
}
export function draftFrom(config) {
  const endpoint = name => ({ providerId: config[name]?.providerId || '', baseURL: config[name]?.baseURL || '', model: config[name]?.model || '', apiKey: '', ...(name === 'tts' ? { voice: config.tts?.voice || '', speed: normalizeTtsSpeed(config.tts?.speed), protocol: config.tts?.protocol || 'speech', stream: config.tts?.stream !== false } : { protocol: config.asr?.protocol || 'transcriptions-sse', realtime: config.asr?.realtime || { url: '', query: {} } }) });
  return { dictation: !!config.dictation, readAloud: !!config.readAloud, call: !!config.call, asr: endpoint('asr'), tts: endpoint('tts') };
}
async function modelCatalog(action, args = {}, signal) {
  const response = await fetch(new URL('api/commander/tooling', document.baseURI), { method: 'POST', credentials: 'same-origin', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args }) });
  const data = await response.json(); if (!response.ok) throw Error(data.error || '无法读取模型服务'); return data;
}
function Toggle({ label, detail, checked, onChange }) { return <label className="voice-setting-toggle"><span><strong>{label}</strong><small>{detail}</small></span><input type="checkbox" role="switch" checked={!!checked} onChange={event => onChange(event.target.checked)} /></label>; }
function VoiceSelect({ label, value, options, onChange, placeholder = '请选择', disabled }) {
  const id = useId(), root = useRef(null), search = useRef(null), trigger = useRef(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [index, setIndex] = useState(0);
  const items = options.filter(option => (option.label + ' ' + (option.hint || '')).toLowerCase().includes(query.toLowerCase()));
  const selected = options.find(option => option.value === value);
  const choose = item => { if (!item || item.disabled) return; onChange(item.value); setOpen(false); trigger.current?.focus(); };
  useEffect(() => { if (open) search.current?.focus(); else setQuery(''); }, [open]);
  useEffect(() => { if (!open) return; const close = event => { if (!root.current?.contains(event.target)) setOpen(false); }; document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close); }, [open]);
  useEffect(() => { root.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }); }, [index, open]);
  const keyboard = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    if (event.key === 'Tab') setOpen(false);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))); setIndex(next);
    }
    if (event.key === 'Enter') { event.preventDefault(); choose(items[index]); }
  };
  return <div className="voice-select" ref={root}><span id={id + '-label'} className="voice-field-label">{label}</span><button ref={trigger} type="button" className="voice-select-trigger" aria-labelledby={id + '-label ' + id + '-value'} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => { setIndex(Math.max(0, items.findIndex(item => item.value === value))); setOpen(!open); }} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}><span id={id + '-value'}>{selected?.label || value || placeholder}</span><IconChevronUpOutlineRegular size={12} /></button>{open && <div className="voice-select-popover"><input ref={search} role="combobox" aria-label={'搜索' + label} aria-autocomplete="list" aria-expanded="true" aria-controls={id} aria-activedescendant={items[index] ? id + '-' + index : undefined} className="voice-select-search" placeholder={'搜索' + label} value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} onKeyDown={keyboard} /><div id={id} role="listbox" aria-labelledby={id + '-label'} className="voice-select-options">{items.map((item, position) => <button key={item.value} id={id + '-' + position} role="option" aria-selected={item.value === value} aria-disabled={!!item.disabled} data-active={position === index} type="button" tabIndex={-1} onPointerMove={() => setIndex(position)} onClick={() => choose(item)}><span>{item.label}</span>{item.hint && <small>{item.hint}</small>}</button>)}{!items.length && <p className="voice-provider-hint">没有匹配结果，可返回手动填写</p>}</div></div>}</div>;
}
function ProviderSettings({ name, draft, config, providers, update, clearKey, toggleClear, disabled }) {
  const [models, setModels] = useState([]), [loading, setLoading] = useState(false), [error, setError] = useState(''), [manualModel, setManualModel] = useState(false), [revision, setRevision] = useState(0);
  const providerId = draft.providerId, provider = providers.find(item => item.id === providerId);
  useEffect(() => {
    setModels([]); setError(''); setLoading(false); setManualModel(false);
    if (!providerId) return;
    const abort = new AbortController(); setLoading(true);
    modelCatalog('models', { providerId }, abort.signal).then(data => { setModels((data.models || []).filter(item => item.kinds?.includes(name))); }).catch(failure => { if (!abort.signal.aborted) setError(failure.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [providerId, name, revision]);
  const providerOptions = [{ value: '', label: '独立配置', hint: '手动填写服务与密钥' }, ...providers.map(item => ({ value: item.id, label: item.name || item.id, hint: item.configured ? '复用已有供应商' : '供应商尚未配置', disabled: !item.configured }))];
  if (providerId && !provider) providerOptions.push({ value: providerId, label: providerId, hint: '当前供应商暂不可用' });
  return <fieldset disabled={disabled} className="voice-provider-settings"><legend>{name === 'asr' ? 'ASR · 语音识别' : 'TTS · 语音合成'}</legend><p className="voice-provider-hint">{name === 'asr' ? '默认使用 OpenAI 兼容接口；WebSocket 持续发送音频，HTTP / SSE 分段上传' : 'OpenAI 兼容语音合成，PCM 24 kHz 单声道；需供应商支持对应接口与模型'}</p><VoiceSelect label="模型供应商" value={providerId} options={providerOptions} disabled={disabled} onChange={id => { if (id === providerId) return; update({ providerId: id, baseURL: providers.find(item => item.id === id)?.baseURL || '', model: '', apiKey: '', protocol: name === 'asr' ? 'transcriptions-sse' : 'speech', ...(name === 'asr' ? { realtime: { url: '', query: {} } } : { voice: '' }) }); }} />
    {name === 'asr' && <VoiceSelect label="识别协议" value={draft.protocol} options={[{value:'transcriptions-sse',label:'OpenAI 兼容转录 SSE',hint:'分段上传后增量返回文字，需模型支持'},{value:'transcriptions',label:'OpenAI 兼容转录 HTTP',hint:'完整语段上传后返回文字'},{value:'openai-websocket',label:'OpenAI 兼容实时转录 WSS',hint:'持续 PCM 输入，默认 /realtime?intent=transcription'}]} disabled={disabled} onChange={protocol=>update({protocol})} />}
    {name === 'asr' && draft.protocol === 'openai-websocket' && <label>WebSocket 地址（可选）<input type="url" autoComplete="off" placeholder="留空使用协议默认地址；可填写完整 wss:// 地址" value={draft.realtime?.url || ''} onChange={event => update({ realtime: { ...draft.realtime, url: event.target.value } })} /><small>网关路由参数可写入地址；API Key 仅通过服务端请求头发送。</small></label>}
    {name === 'tts' && <VoiceSelect label="合成协议" value={draft.protocol} options={[{value:'speech',label:'OpenAI 兼容语音合成',hint:'标准语音接口，返回速度取决于供应商'},{value:'speech-stream',label:'流式语音合成',hint:'请求边生成边返回音频，需供应商与模型支持'}]} disabled={disabled} onChange={protocol => update({protocol})} />}
    {name === 'tts' && <Toggle label="流式播放" detail="收到音频后立即播放；关闭后等待本段音频接收完整再播放。" checked={draft.stream !== false} onChange={stream => update({ stream })} />}
    {!(name === 'asr' ? ['transcriptions-sse', 'transcriptions', 'openai-websocket'] : ['speech', 'speech-stream']).includes(draft.protocol) && <p role="alert" className="voice-settings-error">当前协议 {draft.protocol} 已不支持，请显式选择 OpenAI 兼容协议。模型 ID 与凭据会保留；是否兼容以供应商实际响应为准。</p>}
    <label>API 地址<input type="url" inputMode="url" autoComplete="off" readOnly={!!providerId} placeholder="https://api.example.com/v1" value={provider?.baseURL || draft.baseURL} onChange={event => update({ baseURL: event.target.value })} /></label>
    {providerId && <p className="voice-provider-hint">使用该供应商已有的连接配置，密钥不会返回浏览器。</p>}
    {providerId && <div className="voice-model-actions"><span className="voice-field-label">模型列表</span><button type="button" className="voice-text-button" disabled={loading || disabled} onClick={() => setRevision(value => value + 1)}>{loading ? '获取中…' : '重新获取'}</button><button type="button" className="voice-text-button" onClick={() => setManualModel(value => !value)}>{manualModel ? '从列表选择' : '手动填写'}</button></div>}
    {providerId && !manualModel ? <><VoiceSelect label="模型" value={draft.model} options={models.map(model => ({ value: model.id, label: model.name || model.id, hint: model.inferred ? '按模型名称推断能力' : model.id }))} placeholder={loading ? '正在获取模型…' : '选择模型'} disabled={disabled || loading} onChange={model => update({ model })} />{!loading && !models.length && <p className="voice-provider-hint">未找到对应语音模型，可手动填写模型 ID。</p>}</> : <label>模型<input type="text" autoComplete="off" placeholder={name === 'asr' ? '填写转录模型 ID' : '填写语音合成模型 ID'} value={draft.model} onChange={event => update({ model: event.target.value })} /></label>}
    {error && <p role="status" className="voice-settings-error">{error}；可手动填写模型 ID。</p>}
    {name === 'tts' && <label>音色<input type="text" autoComplete="off" placeholder="填写模型支持的 voice；留空使用 alloy" value={draft.voice} onChange={event => update({ voice: event.target.value })} /></label>}
    {name === 'tts' && <label className="voice-speed-field"><span className="voice-field-label">语速 <output>{normalizeTtsSpeed(draft.speed).toFixed(2)}×</output></span><input type="range" min={TTS_SPEED_MIN} max={TTS_SPEED_MAX} step="0.05" value={normalizeTtsSpeed(draft.speed)} aria-label="语速" onChange={event => update({ speed: normalizeTtsSpeed(event.target.value) })} /></label>}
    {!providerId && <label>API Key<div className="voice-key-field"><input type="password" autoComplete="new-password" spellCheck={false} placeholder={clearKey ? '保存后清除密钥' : config?.apiKeyConfigured ? '已配置，留空保留现有密钥' : '填写 API Key'} value={draft.apiKey} onChange={event => update({ apiKey: event.target.value })} />{(config?.apiKeyConfigured || clearKey) && <button type="button" onClick={toggleClear}>{clearKey ? '撤销清除' : '清除密钥'}</button>}</div></label>}
  </fieldset>;
}
const voiceTabs = [{ id: 'dictation', label: '语音转文本', detail: '在输入框实时转录，确认后发送', kinds: ['asr'] }, { id: 'readAloud', label: '朗读回复', detail: '按片段播放回复，可随时停止', kinds: ['tts'] }, { id: 'call', label: '实时通话', detail: '连续聆听、自动发送，支持打断回复', kinds: ['asr', 'tts'] }];
const mediaTabs = [{ id: 'image', label: '图片' }, { id: 'voice', label: '语音' }];
function SettingsTabs({ tabs, selected, onChange, id, label }) {
  return <SegmentedControl options={tabs.map(item => ({ value: item.id, label: item.label, icon: ['image', 'voice'].includes(item.id) ? <UIIcon name={item.id === 'image' ? 'picture' : 'mic'} size={16} /> : null }))} value={selected} onChange={onChange} label={label} tabIdPrefix={id} panelId={id + '-' + selected + '-panel'} />;
}
async function assistantMediaSettings(action, args = {}, signal) {
  const response = await fetch(new URL('api/commander/assistant', document.baseURI), { method: 'POST', credentials: 'same-origin', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args }) });
  const data = await response.json(); if (!response.ok) throw Error(data.error || '媒体设置请求失败'); return data;
}
function MediaSettings({ controller = activeController }) {
  const modules = useSyncExternalStore(moduleSource.subscribe, moduleSource.getSnapshot);
  const [tab, setTab] = useState(modules.superagent ? 'image' : 'voice'), [snapshot, setSnapshot] = useState(null), [loadError, setLoadError] = useState(''), [providers, setProviders] = useState([]), [catalogError, setCatalogError] = useState(''), [revision, setRevision] = useState(0);
  const tabsId = useId();
  useEffect(() => {
    const abort = new AbortController();
    if (modules.superagent) assistantMediaSettings('state', {}, abort.signal).then(data => { if (!abort.signal.aborted) { setSnapshot(data); setLoadError(''); } }).catch(failure => { if (!abort.signal.aborted) setLoadError(failure.message); });
    else { setSnapshot(null); setLoadError(''); }
    modelCatalog('providers', {}, abort.signal).then(data => { setProviders(data.providers || []); setCatalogError(''); }).catch(failure => { if (!abort.signal.aborted) setCatalogError(failure.message); });
    return () => abort.abort();
  }, [revision, modules.superagent]);
  const saved = config => { setSnapshot(current => ({ ...current, config, media: {} })); document.dispatchEvent(new Event('benchgo:assistant-changed')); setRevision(value => value + 1); };
  return <section className="voice-settings media-settings" aria-busy={!snapshot && modules.superagent && !loadError}><header><h2>媒体</h2><p>让对话能绘图，也能听见与回应。</p></header><SettingsTabs tabs={mediaTabs} selected={tab} onChange={setTab} id={tabsId} label="媒体类型" />{mediaTabs.map(item => <div key={item.id} id={tabsId + '-' + item.id + '-panel'} role="tabpanel" aria-labelledby={tabsId + '-' + item.id} hidden={tab !== item.id}>{item.id === 'voice' ? modules.voice && controller ? <VoiceSettings controller={controller} providers={providers} catalogError={catalogError} /> : <p role="status" className="voice-provider-hint">Voice 未启用，语音设置暂不可用。</p> : modules.superagent ? <GeneratedMediaSettings kind={item.id} snapshot={snapshot} providers={providers} catalogError={catalogError} loadError={loadError} retry={() => setRevision(value => value + 1)} onSaved={saved} /> : <p role="status" className="voice-provider-hint">SuperAgent 未启用，图片设置暂不可用。</p>}</div>)}</section>;
}
function GeneratedMediaSettings({ kind, snapshot, providers, catalogError, loadError, retry, onSaved }) {
  const [draft, setDraft] = useState(null), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false), [models, setModels] = useState([]), [modelError, setModelError] = useState(''), [loading, setLoading] = useState(false), [manual, setManual] = useState(false), [modelRevision, setModelRevision] = useState(0);
  const original = useRef(null), title = '图片生成';
  useEffect(() => { if (snapshot?.config && !dirty) { original.current = snapshot.config[kind] || null; setDraft(generatedMediaDraft(original.current)); } }, [snapshot?.config, kind, dirty]);
  const providerId = draft?.providerId || '';
  useEffect(() => {
    setModels([]); setModelError(''); setLoading(false); setManual(false);
    if (!providerId) return;
    const abort = new AbortController(); setLoading(true);
    modelCatalog('models', { providerId }, abort.signal).then(data => { if (!abort.signal.aborted) setModels(data.models || []); }).catch(failure => { if (!abort.signal.aborted) setModelError(failure.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [providerId, modelRevision]);
  const update = patch => { setDraft(value => ({ ...value, ...patch })); setDirty(true); setSaved(false); };
  const save = async event => {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    try {
      const config = await assistantMediaSettings('config', { patch: generatedMediaPatch(kind, draft, original.current), revision: snapshot.config.revision });
      original.current = config[kind] || null; setDraft(generatedMediaDraft(original.current)); setDirty(false); setSaved(true); onSaved(config);
    } catch (failure) { setError(failure.message || '保存失败'); } finally { setBusy(false); }
  };
  if (!draft) return <div className="voice-settings-content"><p role="status">{loadError || '正在加载媒体设置…'}</p>{loadError && <button type="button" className="voice-text-button" onClick={retry}>重新加载</button>}</div>;
  const providerOptions = providers.map(item => ({ value: item.id, label: item.name || item.id, hint: item.configured && item.authMode !== 'subscription' ? '复用云供应商连接' : '缺少可用的 API 凭据', disabled: !item.configured || item.authMode === 'subscription' }));
  if (providerId && !providers.some(item => item.id === providerId)) providerOptions.push({ value: providerId, label: providerId, hint: '当前供应商暂不可用' });
  const availability = snapshot.media?.[kind];
  return <form className="voice-settings-content" onSubmit={save}><fieldset disabled={busy} className="voice-provider-settings"><legend>{title}</legend><Toggle label="在对话中生成图片" detail="配置后，直接向助手描述想要的画面。生成结果保存在资源 → 产物。" checked={draft.enabled} onChange={enabled => update({ enabled })} />{draft.enabled && <><VoiceSelect label="模型供应商" value={providerId} options={providerOptions} disabled={busy} onChange={id => { if (id !== providerId) update({ providerId: id, modelId: '' }); }} /><div className="voice-model-actions"><span className="voice-field-label">模型</span><button type="button" className="voice-text-button" disabled={busy || loading || !providerId} onClick={() => setModelRevision(value => value + 1)}>{loading ? '读取中…' : '刷新列表'}</button><button type="button" className="voice-text-button" disabled={busy} onClick={() => setManual(value => !value)}>{manual ? '从列表选择' : '手动填写'}</button></div>{manual || !models.length ? <label>模型 ID<input autoComplete="off" value={draft.modelId} placeholder="供应商提供的原始模型 ID" onChange={event => update({ modelId: event.target.value })} /></label> : <VoiceSelect label="模型 ID" value={draft.modelId} options={models.map(item => ({ value: item.id, label: item.name || item.id, hint: item.name && item.name !== item.id ? item.id : '' }))} disabled={busy || loading} onChange={modelId => update({ modelId })} />}<VoiceSelect label="协议" value={draft.protocol} options={[{ value: 'openai-compatible', label: 'OpenAI 兼容协议' }]} disabled={busy} onChange={protocol => update({ protocol })} /><p className="voice-provider-hint">使用云供应商已有的连接和凭据，密钥不会返回浏览器。模型列表仅列出供应商返回的标识。</p>{kind === 'image' && <p className={'media-availability' + (availability?.available ? ' is-available' : '')} role="status">{availability?.available ? '连接配置就绪 · 实际生成以供应商响应为准' : availability?.reason ? '当前配置不可用：' + availability.reason : '保存后检查当前配置的可用性'}</p>}{modelError && <p role="status" className="voice-provider-hint">模型列表读取失败：{modelError}。可手动填写原始模型 ID。</p>}</>}</fieldset>{catalogError && <p role="status" className="voice-provider-hint">供应商目录读取失败：{catalogError}。<button type="button" className="voice-text-button" onClick={retry}>重试</button></p>}<footer><button className="voice-save" type="submit" disabled={busy || !dirty}>{busy ? '保存中…' : '保存设置'}</button><span role="status">{saved ? '已保存' : dirty ? '有未保存的修改' : ''}</span></footer>{error && <p role="alert" className="voice-settings-error">{error} <button type="button" className="voice-text-button" disabled={busy} onClick={() => { setDirty(false); setError(''); retry(); }}>重新加载</button></p>}</form>;
}
function VoiceSettings({ controller, providers = [], catalogError = '' }) {
  const state = useVoice(controller), [draft, setDraft] = useState(null), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false), [clearKeys, setClearKeys] = useState({}), [tab, setTab] = useState('dictation');
  const original = useRef(null);
  const tabsId = useId();
  useEffect(() => { if (state.config && !dirty) { original.current = draftFrom(state.config); setDraft(original.current); } }, [state.config, dirty]);
  const update = (field, value) => { setDraft(current => ({ ...current, [field]: value })); setDirty(true); setSaved(false); };
  const endpoint = (name, patch) => { setDraft(current => ({ ...current, [name]: { ...current[name], ...patch } })); setDirty(true); setSaved(false); if (patch.apiKey || patch.providerId) setClearKeys(current => ({ ...current, [name]: false })); };
  const save = async event => {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    try { const patch = voiceSettingsPatch(draft, original.current, clearKeys); await controller.configure(patch); setDirty(false); setClearKeys({}); setSaved(true); } catch (failure) { setError(failure.message || '保存失败'); } finally { setBusy(false); }
  };
  if (!draft) return <section className="voice-settings-content"><p role="status">{state.error || '正在加载语音设置…'}</p>{state.error && <button type="button" className="voice-save" onClick={() => controller.load().catch(failure => setError(failure.message))}>重新加载</button>}{error && <p role="alert" className="voice-settings-error">{error}</p>}</section>;
  const current = voiceTabs.find(item => item.id === tab);
  return <form className="voice-settings-content" onSubmit={save}>
    <SegmentedControl options={voiceTabs.map(item => ({ value: item.id, label: item.label }))} value={tab} onChange={setTab} label="语音交互方式" tabIdPrefix={tabsId} panelId={tabsId + '-panel'} />
    <div className="voice-tab-panel" key={tab} id={tabsId + '-panel'} role="tabpanel" aria-labelledby={tabsId + '-' + tab}><fieldset disabled={busy} className="voice-mode-settings"><Toggle label={current.label} detail={current.detail} checked={draft[tab]} onChange={value => update(tab, value)} /></fieldset><div className="voice-privacy-note">{tab === 'dictation' ? '音频发送至所选 ASR 服务。转录写入草稿，不会自动发送。' : tab === 'readAloud' ? '回复文本发送至所选 TTS 服务。开启后仍可在输入框切换本设备的自动朗读。' : '音频发送至 ASR，转录发送给当前对话模型，回复文本发送至 TTS。通话与其他两种方式独立开启。'}</div>{tab === 'call' && draft.asr.protocol !== 'openai-websocket' && <p role="status" className="voice-provider-hint">当前为分段识别。追求低延迟，请选择服务实际支持的实时转录 WSS 协议及对应模型；不会自动改写现有选择。</p>}{current.kinds.map(name => <ProviderSettings key={name} name={name} draft={draft[name]} config={state.config?.[name]} providers={providers} update={patch => endpoint(name, patch)} clearKey={clearKeys[name]} toggleClear={() => { setClearKeys(value => ({ ...value, [name]: !value[name] })); endpoint(name, { apiKey: '' }); }} disabled={busy} />)}</div>
    {catalogError && <p role="status" className="voice-provider-hint">暂时无法读取已有供应商：{catalogError}。仍可独立配置。</p>}
    <footer><button className="voice-save" type="submit" disabled={busy || !dirty}>{busy ? '保存中…' : '保存设置'}</button><span role="status">{saved ? '已保存' : dirty ? '有未保存的修改' : ''}</span></footer>{(error || state.error) && <p role="alert" className="voice-settings-error">{error || state.error}</p>}
  </form>;
}
