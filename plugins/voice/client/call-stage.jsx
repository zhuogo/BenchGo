import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconMicrophoneOutlineMedium, IconStopFillRegular, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
import { Loading } from '../../shared/client/ui/loading.jsx';

const labels = { idle: '通话已结束', starting: '正在连接', listening: '我在听', transcribing: '正在听清你的话', thinking: '正在想一想', speaking: '正在回应', waiting: '等待你的确认' };
const markdownLabels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };
export function CallOrb({ state }) {
  const phase = state.muted && state.phase === 'listening' ? 'muted' : state.phase;
  const level = Math.max(0, Math.min(1, Number(state.phase === 'speaking' ? state.playbackLevel || 0 : state.muted ? 0 : state.level || 0)));
  return <span className={'voice-call-orb voice-orb-' + phase} aria-hidden="true" style={{ '--voice-level': level }}><span className="voice-orb-aura" /><span className="voice-orb-body"><span className="voice-orb-cloud" /><span className="voice-orb-shine" /></span></span>;
}
export function CallStageIcon({ name }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{name === 'records' ? <><path d="M8 18H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-5l-4 3v-3Z" /><path d="M7.5 9h9m-9 4h5" /></> : name === 'curtain' ? <><path d="M4 5h16M5 5v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5M9 9h6m-6 4h4M12 18v3" /></> : name === 'minimize' ? <path d="m6 9 6 6 6-6" /> : name === 'close' ? <path d="m6 6 12 12M18 6 6 18" /> : <><path d="M14 4h6v6m0-6-7 7M10 20H4v-6m0 6 7-7" /></>}</svg>;
}

// Durable snapshots replace current partials without duplicating a spoken turn.
export function mergeCallMessages(...groups) {
  const result = new Map();
  for (const group of groups) for (const row of group || []) {
    if (!row.text?.trim() || !['user', 'assistant'].includes(row.role)) continue;
    const key = row.sourceId ? JSON.stringify([row.role, row.sourceId]) : row.requestId ? JSON.stringify([row.callId || '', row.requestId, row.role, row.role === 'user' ? '' : row.messageId || row.requestId]) : row.id;
    const previous = result.get(key);
    if (!previous || previous.partial || !row.partial) result.set(key, { ...previous, ...row, id: key });
  }
  return [...result.values()].sort((left, right) => {
    if (Number.isFinite(left.time) && Number.isFinite(right.time) && left.time !== right.time) return left.time - right.time;
    if (Number.isFinite(left.seq) && Number.isFinite(right.seq)) return left.seq - right.seq;
    return 0;
  });
}

/** A live ASR row keeps its key when the same utterance is admitted to the call. */
export function callTranscriptRows(messages, state, sessionId) {
  const rows = messages.map(row => ({ ...row, renderId: row.role === 'user' && row.transcriptIds?.length ? 'transcript:' + row.transcriptIds[0] : row.id }));
  if (state.sessionId !== sessionId || state.mode !== 'call' || !state.transcriptId || !state.transcript?.trim()) return rows;
  if (rows.some(row => row.role === 'user' && row.transcriptIds?.includes(state.transcriptId))) return rows;
  return [...rows, { id: 'transcript:' + state.transcriptId, renderId: 'transcript:' + state.transcriptId, role: 'user', text: state.transcript, partial: true, transcribing: true }];
}

export function CallStage({ state, controller, sessionId, open, historyOnly = false, inlineTarget, interactionPending = false, origin, pending, error, recovery, returnFocusRef, onMute, onHangup, onRetry, onMinimize, onExpand }) {
  const [recordsOpen, setRecordsOpen] = useState(historyOnly), [history, setHistory] = useState([]), [loading, setLoading] = useState(false), [historyError, setHistoryError] = useState(''), [page, setPage] = useState(null), [revision, setRevision] = useState(0);
  const root = useRef(null), list = useRef(null), follow = useRef(true), paging = useRef(false), historyAbort = useRef(null), previousFocus = useRef(null);
  const curtainButton = useRef(null), recordsId = useId();
  const closeRecords = () => { setRecordsOpen(false); curtainButton.current?.focus(); };
  const current = state.sessionId === sessionId ? state.conversationMessages || [] : [];
  const messages = callTranscriptRows(mergeCallMessages(history, current), state, sessionId), showRecords = historyOnly || recordsOpen || !!inlineTarget;
  const active = state.mode === 'call', starting = state.phase === 'starting' || pending && !active;
  const phase = starting ? 'starting' : interactionPending ? 'waiting' : active ? state.phase : 'idle';
  const caption = error ? '语音遇到问题' : state.muted && phase === 'listening' ? '麦克风已关闭' : labels[phase] || '语音处理中';
  useLayoutEffect(() => {
    const orbit = root.current?.querySelector('.voice-stage-orbit');
    if (!open || inlineTarget || !orbit || !origin) return;
    const rect = orbit.getBoundingClientRect();
    root.current.style.setProperty('--voice-travel-x', origin.x - rect.left - rect.width / 2 + 'px');
    root.current.style.setProperty('--voice-travel-y', origin.y - rect.top - rect.height / 2 + 'px');
  }, [open, origin, inlineTarget]);
  useEffect(() => { setHistory([]); setPage(null); setHistoryError(''); follow.current = true; }, [sessionId, state.conversationMode]);
  useEffect(() => {
    if (!open || !showRecords || !controller.readConversationHistory) return;
    const abort = new AbortController(); historyAbort.current?.abort(); historyAbort.current = abort;
    setLoading(true); setHistoryError('');
    controller.readConversationHistory(sessionId, { signal: abort.signal }).then(result => {
      if (abort.signal.aborted) return;
      setHistory(previous => mergeCallMessages(previous, result.items));
      setPage(previous => previous?.loadedOlder ? previous : { hasMore: result.hasMore, before: result.nextBefore ?? result.before });
    }).catch(failure => { if (!abort.signal.aborted) setHistoryError(failure.message || '语音记录加载失败'); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { abort.abort(); historyAbort.current?.abort(); };
  }, [open, showRecords, sessionId, controller, state.conversationMode, state.conversationRevision, revision]);
  useLayoutEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement;
    root.current?.querySelector('button')?.focus();
    if (inlineTarget) return;
    const previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      const previous = previousFocus.current;
      if (previous?.isConnected && previous !== document.body) previous.focus();
      else returnFocusRef?.current?.querySelector('button:not(:disabled)')?.focus();
    };
  }, [open, returnFocusRef, inlineTarget]);
  useEffect(() => {
    if (showRecords && follow.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [showRecords, current, history, state.transcript, state.transcriptId]);
  useEffect(() => () => historyAbort.current?.abort(), []);
  const older = async () => {
    if (paging.current || !page?.hasMore) return;
    paging.current = true; setLoading(true); setHistoryError(''); follow.current = false;
    const abort = new AbortController(); historyAbort.current?.abort(); historyAbort.current = abort;
    const scroll = list.current, previousHeight = scroll?.scrollHeight || 0, previousTop = scroll?.scrollTop || 0;
    try {
      const result = await controller.readConversationHistory(sessionId, { before: page.before, signal: abort.signal });
      if (abort.signal.aborted) return;
      setHistory(previous => mergeCallMessages(result.items, previous));
      setPage({ hasMore: result.hasMore, before: result.nextBefore ?? result.before, loadedOlder: true });
      requestAnimationFrame(() => { if (scroll?.isConnected) scroll.scrollTop = previousTop + scroll.scrollHeight - previousHeight; });
    } catch (failure) { if (!abort.signal.aborted) setHistoryError(failure.message || '语音记录加载失败'); }
    finally { paging.current = false; if (!abort.signal.aborted) setLoading(false); }
  };
  const keyboard = event => {
    if (inlineTarget) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!historyOnly && recordsOpen) closeRecords(); else onMinimize(); }
    if (event.key !== 'Tab') return;
    const buttons = [...root.current.querySelectorAll('button:not(:disabled),a[href],[tabindex="0"]')].filter(node => node.getClientRects().length && !node.closest('[inert],[aria-hidden="true"]'));
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  if (!open) return null;
  return createPortal(<section ref={root} className={'voice-call-stage' + (inlineTarget ? ' voice-stage-inline' : '') + (historyOnly ? ' voice-stage-history-only' : '') + (showRecords ? ' voice-stage-with-records' : '')} role={inlineTarget ? 'region' : 'dialog'} aria-modal={inlineTarget ? undefined : 'true'} aria-label={historyOnly ? '语音记录' : inlineTarget ? '语音对话' : '实时语音通话'} onKeyDown={keyboard} style={origin ? { '--voice-origin-x': origin.x + 'px', '--voice-origin-y': origin.y + 'px' } : undefined}>
    <header className="voice-stage-header"><div className="voice-stage-title"><span className={'voice-stage-live' + (active && !starting && !error && !historyOnly ? ' is-live' : '')} /><span>{historyOnly ? '语音记录' : inlineTarget ? '语音对话' : '实时语音'}</span></div><button type="button" className="voice-stage-nav" aria-label={inlineTarget ? '展开语音通话' : historyOnly ? '关闭语音记录' : interactionPending ? '处理确认' : '收起通话'} onClick={inlineTarget ? onExpand : onMinimize}><CallStageIcon name={inlineTarget ? 'expand' : historyOnly ? 'close' : 'minimize'} /><span>{inlineTarget ? '展开' : historyOnly ? '关闭' : interactionPending ? '处理确认' : '收起'}</span></button></header>
    <div className="voice-stage-body">
      {!historyOnly && <main className="voice-stage-main"><div className="voice-stage-orbit"><div className="voice-stage-orb-arrival"><CallOrb state={{ ...state, phase }} /></div></div><div className="voice-stage-caption" role="status"><h2>{caption}</h2>{(error || phase === 'waiting') && <p>{error || '请返回对话完成确认'}</p>}</div>{!showRecords && <div className={'voice-stage-subtitle' + (error ? ' is-error' : '')}>{!error && <p>{state.phase === 'speaking' ? state.replyText || state.transcript : state.transcript || ''}</p>}</div>}{recovery && <div className="voice-stage-recovery">{recovery}</div>}</main>}
      {showRecords && <aside id={recordsId} className="voice-stage-records" aria-label="完整语音记录"><div ref={list} className="voice-stage-message-list" role="log" aria-label="语音对话内容" aria-live="off" onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 56; }}>
        {page?.hasMore && <button type="button" className="voice-stage-load" disabled={loading} onClick={older}>{loading ? '正在加载…' : '查看更早记录'}</button>}
        {!messages.length && (loading ? <Loading className="voice-stage-loading" label="正在读取语音记录…" /> : <div className="voice-stage-empty" role="status"><CallStageIcon name="records" /><p>{historyError ? '暂时无法读取记录' : '对话从这里开始'}</p><span>{historyError || '通话内容会保存在这里。'}</span>{historyError && <button type="button" className="voice-text-button" onClick={() => setRevision(value => value + 1)}>重新加载</button>}</div>)}
        {messages.map(row => <article key={row.renderId} className={'voice-stage-message is-' + row.role + (row.transcribing ? ' is-transcribing' : '')} data-voice-row={row.renderId}><span>{row.role === 'user' ? '你' : '回复'}{row.partial && <i aria-label={row.transcribing ? '正在转录' : '正在更新'} />}</span><div className="voice-stage-markdown"><MarkdownText text={row.text} streaming={!!row.partial} labels={markdownLabels} omitHtml /></div></article>)}
        {historyError && !!messages.length && <div className="voice-stage-record-error" role="status"><p>{historyError}</p><button type="button" className="voice-text-button" onClick={() => setRevision(value => value + 1)}>重新加载</button></div>}
      </div></aside>}
      {!historyOnly && <footer className="voice-stage-controls">{!inlineTarget && <div><button ref={curtainButton} type="button" className="voice-stage-control voice-curtain-toggle" aria-label={recordsOpen ? '收起幕布' : '展开幕布'} aria-expanded={recordsOpen} aria-controls={showRecords ? recordsId : undefined} onClick={() => setRecordsOpen(value => !value)}><CallStageIcon name="curtain" /></button><span>幕布</span></div>}{active || starting ? <><div><button type="button" className={'voice-stage-control voice-stage-mic' + (state.muted ? ' is-muted' : '')} aria-label={state.muted ? '开启麦克风' : '关闭麦克风'} aria-pressed={!!state.muted} disabled={pending || starting || !active} onClick={onMute}><span className={'voice-microphone-icon' + (state.muted ? ' voice-microphone-muted' : '')}><IconMicrophoneOutlineMedium size={22} /></span></button><span>{state.muted ? '开启麦克风' : '麦克风'}</span></div><div><button type="button" className="voice-stage-control voice-stage-hangup" aria-label="结束语音通话" onClick={onHangup}><IconStopFillRegular size={20} /></button><span>结束通话</span></div></> : <div><button type="button" className="voice-stage-retry" disabled={pending} onClick={onRetry}>重新连接</button></div>}</footer>}
    </div>
  </section>, inlineTarget || document.body);
}
