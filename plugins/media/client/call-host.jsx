import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { IconMicrophoneOutlineMedium, IconStopFillRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { Tooltip } from '../../shared/client/ui/tooltip.jsx';
import { CallOrb, CallStage, CallStageIcon, callTranscriptRows, mergeCallMessages } from './call-stage.jsx';
import { FloatingTranscript } from './floating-transcript.jsx';
import { useCallDrag } from './use-call-drag.jsx';
import { MIC_SHORTCUT_KEYS } from './mic-shortcut.mjs';

const emptyStatuses = new Map();
const absent = () => emptyStatuses;
const noSubscribe = () => () => {};
const labels = { starting: '正在连接', listening: '我在听', transcribing: '正在识别', thinking: '正在思考', speaking: '正在回应', waiting: '等待确认' };

export function VoiceCallHost({ controller, callView, sessionStatus, openSettings }) {
  const state = useSyncExternalStore(controller.state.subscribe, controller.state.getSnapshot);
  const view = useSyncExternalStore(callView.subscribe, callView.getSnapshot);
  const dock = useRef(null), [transcriptVisible, setTranscriptVisible] = useState(true);
  const statuses = useSyncExternalStore(sessionStatus?.subscribe ?? noSubscribe, sessionStatus?.getSnapshot ?? absent);
  const own = state.sessionId === view.sessionId, calling = own && state.mode === 'call';
  const waiting = calling && (!!statuses.get(view.sessionId)?.pendingInteraction || state.phase === 'waiting');
  const error = view.error || (own && !view.historyOnly ? state.error : '');
  const visible = !!view.sessionId && (calling || view.pending || !!error || view.historyOnly);
  const drag = useCallDrag({ dock, position: view.position, onMove: callView.move, enabled: visible && !view.expanded && !view.historyOnly });
  useEffect(() => { if (!visible || view.pending) setTranscriptVisible(true); }, [visible, view.pending]);
  const recent = useMemo(() => own ? callTranscriptRows(mergeCallMessages(state.conversationMessages), state, view.sessionId).slice(-3) : [], [own, state.conversationMessages, state.transcript, state.transcriptId, state.mode, view.sessionId]);
  const previousSize = useRef(null);
  useLayoutEffect(() => {
    if (!visible || view.pending) previousSize.current = null;
    const node = dock.current;
    if (!node) return;
    const height = node.getBoundingClientRect().height, previous = previousSize.current;
    previousSize.current = { sessionId: view.sessionId, height };
    // Drag positions use the stack's top; keep the control bar still as captions grow.
    if (view.position && previous?.sessionId === view.sessionId && Math.abs(previous.height - height) > 1) callView.move({ x: view.position.x, y: view.position.y + previous.height - height });
  }, [recent, transcriptVisible, view.position, view.expanded, view.pending, view.sessionId, visible, callView]);
  const starting = view.pending || calling && state.phase === 'starting';
  const caption = error ? calling ? '通话遇到问题' : '连接已中断' : starting ? '正在连接' : waiting ? '等待确认' : state.muted ? '麦克风已关闭' : labels[state.phase] || '返回通话';
  const dockKeyboard = event => {
    if (event.key !== 'Tab') return;
    const settings = document.querySelector('[data-shortcut-modal="settings"]');
    if (!settings) return;
    // Settings owns its modal traversal; return to it at the dock's edges.
    event.stopPropagation();
    const selector = 'button:not(:disabled),a[href],input:not(:disabled),[tabindex="0"]';
    const available = node => [...node.querySelectorAll(selector)].filter(item => item.getClientRects().length && !item.closest('[inert],[hidden]'));
    const controls = available(dock.current), targets = available(settings);
    if (event.shiftKey ? document.activeElement === controls[0] : document.activeElement === controls.at(-1)) {
      event.preventDefault(); (event.shiftKey ? targets.at(-1) : targets[0])?.focus();
    }
  };
  if (!visible) return null;
  return <>
    <CallStage state={state} controller={controller} sessionId={view.sessionId} open={view.expanded} interactionPending={waiting} historyOnly={view.historyOnly} origin={view.origin} pending={view.pending} error={error} returnFocusRef={dock} onMute={() => controller.toggleMute()} onHangup={() => callView.hangup()} onRetry={() => callView.retry()} onMinimize={() => waiting ? callView.returnToSession() : callView.minimize()} onOpenSettings={openSettings && (() => { openSettings(); callView.minimize(); })} />
    {!view.expanded && !view.historyOnly && createPortal(<aside ref={dock} style={drag.style} onKeyDown={dockKeyboard} className={'voice-activity voice-global-call' + (error ? ' has-error' : '') + (!calling && !starting ? ' is-disconnected' : '')} aria-label={'语音通话：' + view.title}>
      {calling && transcriptVisible && <FloatingTranscript rows={recent} />}
      <div className="voice-global-controls">
      <Tooltip label={'拖动调整位置，点击展开 · ' + view.title} portal><button type="button" {...drag.handle} className="voice-global-open" aria-label={'展开语音通话：' + view.title} aria-description="可拖动调整位置；方向键移动，Home 恢复默认位置" onClick={event => drag.open(event, () => callView.expand())}><CallOrb state={{ ...state, phase: starting ? 'starting' : state.phase }} /><span className="voice-global-copy"><strong>{view.title}</strong><span role="status">{caption}</span></span></button></Tooltip>
      {waiting && <Tooltip label="返回原会话处理确认" portal><button type="button" className="voice-icon-button" aria-label="处理确认" onClick={() => callView.returnToSession()}><CallStageIcon name="expand" /></button></Tooltip>}
      <Tooltip label={transcriptVisible ? '隐藏语音文字' : '显示语音文字'} portal><button type="button" className="voice-icon-button voice-global-transcript-toggle" aria-label={transcriptVisible ? '隐藏语音文字' : '显示语音文字'} aria-pressed={transcriptVisible} disabled={!calling || starting} onClick={() => setTranscriptVisible(value => !value)}><CallStageIcon name="curtain" /></button></Tooltip>
      <Tooltip label={state.muted ? '开启麦克风' : '关闭麦克风'} shortcutKeys={MIC_SHORTCUT_KEYS} portal><button type="button" className="voice-icon-button" aria-label={state.muted ? '开启麦克风' : '关闭麦克风'} aria-pressed={!!state.muted} disabled={!calling || starting} onClick={() => controller.toggleMute()}><span className={'voice-microphone-icon' + (state.muted ? ' voice-microphone-muted' : '')}><IconMicrophoneOutlineMedium size={18} /></span></button></Tooltip>
      <Tooltip label={calling || starting ? '结束通话' : '关闭提示'} portal><button type="button" className="voice-icon-button voice-global-end" aria-label={calling || starting ? '结束语音通话' : '关闭通话提示'} onClick={() => callView.hangup()}><IconStopFillRegular size={16} /></button></Tooltip>
      </div>
    </aside>, document.body)}
  </>;
}
