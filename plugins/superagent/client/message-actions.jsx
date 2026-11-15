import { Button } from '../../shared/client/ui/button.jsx';
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Tooltip, Menu, writeClipboard, IconCopyOutlineMedium, IconCheckOutlineMedium, IconGaugeOutlineMedium, IconClockOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives';

const reactions = [['👍', '赞同'], ['❤️', '喜欢'], ['😂', '有趣'], ['🎉', '庆祝'], ['🤔', '思考'], ['👎', '不赞同']];
const usageLabels = { inputTokens: '输入', outputTokens: '输出', totalTokens: '合计', cacheReadTokens: '缓存读取', cacheWriteTokens: '缓存写入', reasoningTokens: '推理' };

export function MessageActions({ row, saved = null, agentReaction = null, assistantName = '', api, onRefresh, threadId = 'main' }) {
  return <CachedMessageActions messageKey={row.key} text={row.text || ''} time={row.time} role={row.role}
    provisional={!!row.provisional} usage={row.usage} saved={saved} agentReaction={agentReaction} assistantName={assistantName} api={api} onRefresh={onRefresh} threadId={threadId} />;
}

// Live token updates recreate projected rows. Only fields used by the controls
// cross this memo boundary, so settled history does no per-token formatting work.
const CachedMessageActions = memo(function CachedMessageActions({ messageKey, text, time, role, provisional, usage: recordedUsage, saved, agentReaction, assistantName, api, onRefresh, threadId }) {
  const [panel, setPanel] = useState(''), [copied, setCopied] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [override, setOverride] = useState(undefined);
  const [side, setSide] = useState('top');
  const root = useRef(null), trigger = useRef(null), popup = useRef(null), timer = useRef(null);
  const [touch, setTouch] = useState(false), [closing, setClosing] = useState(false);
  const message = useRef(null), exitTimer = useRef(null), keyboard = useRef(false), openTouch = useRef(null), selectionCleanup = useRef(null);
  const reaction = override === undefined ? saved : override;
  useEffect(() => { setOverride(undefined); }, [saved, threadId, messageKey]);
  useEffect(() => () => { clearTimeout(timer.current); clearTimeout(exitTimer.current); selectionCleanup.current?.(); }, []);
  useEffect(() => {
    const media = window.matchMedia('(hover: none), (pointer: coarse)');
    const update = () => { setTouch(media.matches); setPanel(''); setClosing(false); clearTimeout(exitTimer.current); };
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  openTouch.current = (instant = false) => {
    const anchor = message.current?.querySelector('.ba-chat-body');
    if (!anchor || message.current.dataset.streaming === 'true') return;
    clearTimeout(exitTimer.current); keyboard.current = instant; trigger.current = message.current;
    setSide(anchor.getBoundingClientRect().top < window.innerHeight / 2 ? 'bottom' : 'top');
    setClosing(false); setPanel('actions');
  };
  useEffect(() => {
    if (!touch) return;
    const article = root.current?.closest('.ba-chat-message');
    if (!article) return;
    message.current = article;
    const originalTab = article.getAttribute('tabindex');
    article.tabIndex = 0; article.dataset.touchActions = 'true';
    article.setAttribute('aria-keyshortcuts', 'Shift+F10');
    let press, start, suppressClick = false;
    const cancel = () => { clearTimeout(press); press = undefined; start = undefined; };
    const eligible = target => target instanceof Element && target.closest('.ba-chat-body')
      && !target.closest('a,button,input,textarea,select,[role="button"],[contenteditable="true"],pre,code')
      && article.dataset.streaming !== 'true' && article.dataset.textSelection !== 'true';
    const down = event => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      if (!event.isPrimary || !eligible(event.target)) { cancel(); return; }
      cancel(); suppressClick = false; start = { id: event.pointerId, x: event.clientX, y: event.clientY };
      press = setTimeout(() => { suppressClick = true; cancel(); openTouch.current(); }, 450);
    };
    const move = event => {
      if (start && (event.pointerId !== start.id || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8)) cancel();
    };
    const context = event => { if (eligible(event.target)) { event.preventDefault(); cancel(); suppressClick = true; openTouch.current(); } };
    const click = event => { if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopPropagation(); } };
    const key = event => {
      if (event.target === article && (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) {
        event.preventDefault(); openTouch.current(true);
      }
    };
    article.addEventListener('pointerdown', down); article.addEventListener('pointermove', move);
    article.addEventListener('pointerup', cancel); article.addEventListener('pointercancel', cancel);
    article.addEventListener('contextmenu', context); article.addEventListener('click', click, true); article.addEventListener('keydown', key);
    const feed = article.closest('.ba-chat-feed'); feed?.addEventListener('scroll', cancel, { passive: true });
    return () => {
      cancel(); message.current = null;
      article.removeEventListener('pointerdown', down); article.removeEventListener('pointermove', move);
      article.removeEventListener('pointerup', cancel); article.removeEventListener('pointercancel', cancel);
      article.removeEventListener('contextmenu', context); article.removeEventListener('click', click, true); article.removeEventListener('keydown', key);
      selectionCleanup.current?.(); feed?.removeEventListener('scroll', cancel);
      if (originalTab === null) article.removeAttribute('tabindex'); else article.setAttribute('tabindex', originalTab);
      article.removeAttribute('aria-keyshortcuts'); delete article.dataset.touchActions; delete article.dataset.textSelection;
    };
  }, [touch, messageKey]);
  useEffect(() => {
    if (!panel || closing) return;
    (popup.current?.querySelector('button') || popup.current)?.focus({ preventScroll: true });
  }, [panel, closing]);
  useEffect(() => {
    if (!touch || !panel || closing) return;
    const closeOnScroll = event => { if (!popup.current?.contains(event.target)) closePanel(); };
    document.addEventListener('scroll', closeOnScroll, true);
    return () => document.removeEventListener('scroll', closeOnScroll, true);
  }, [touch, panel, closing]);
  function closePanel() {
    if (!touch) { setPanel(''); return; }
    setClosing(true); clearTimeout(exitTimer.current);
    exitTimer.current = setTimeout(() => { setPanel(''); setClosing(false); }, keyboard.current ? 0 : 120);
  }
  function togglePanel(name, event) {
    if (!touch) {
      trigger.current = event.currentTarget;
      setSide(event.currentTarget.getBoundingClientRect().top < window.innerHeight / 2 ? 'bottom' : 'top');
    }
    setPanel(panel === name ? '' : name);
  }
  async function react(emoji) {
    setBusy(true); setError('');
    try {
      const next = reaction === emoji ? null : emoji;
      await api('messageReaction', { threadId, messageKey, emoji: next });
      setOverride(next); closePanel(); trigger.current?.focus({ preventScroll: true });
      await onRefresh?.();
    } catch (cause) { setError(cause.message || '回应保存失败，请重试'); }
    finally { setBusy(false); }
  }
  async function copy() {
    setError('');
    try {
      if (!await writeClipboard(text)) throw new Error('复制失败，请重试');
      setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1600);
    } catch (cause) { setError(cause.message || '复制失败，请重试'); }
  }
  function selectText() {
    const content = message.current?.querySelector('.ba-chat-content');
    if (!content) return;
    message.current.dataset.textSelection = 'true';
    selectionCleanup.current?.();
    const article = message.current;
    const leave = event => { if (!article.contains(event.target)) { delete article.dataset.textSelection; selectionCleanup.current?.(); } };
    document.addEventListener('pointerdown', leave);
    selectionCleanup.current = () => { document.removeEventListener('pointerdown', leave); selectionCleanup.current = null; };
    const range = document.createRange(); range.selectNodeContents(content);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    closePanel(); message.current.focus({ preventScroll: true });
  }
  const timestamp = useMemo(() => {
    const date = time != null ? new Date(time) : null;
    return date && Number.isFinite(date.getTime()) ? { iso: date.toISOString(), full: date.toLocaleString('zh-CN'),
      short: date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) } : null;
  }, [time]);
  const usage = useMemo(() => Object.entries(usageLabels).filter(([key]) => Number.isFinite(recordedUsage?.[key]) && recordedUsage[key] >= 0), [recordedUsage]);
  const toolbar = <div className="ba-message-toolbar" role="group" aria-label="消息操作">
      <Tooltip side="top" portal delayMs={250} label={copied ? '已复制' : '复制'}><Button variant="ghost" type="button" data-copied={copied || undefined} aria-label={copied ? '已复制' : '复制消息'} onClick={copy}>{copied ? <IconCheckOutlineMedium size={18} /> : <IconCopyOutlineMedium size={18} />}</Button></Tooltip>
      {!provisional && <Tooltip side="top" portal delayMs={250} label="表情回应"><Button variant="ghost" type="button" aria-label="表情回应" aria-haspopup="dialog" aria-expanded={panel === 'reactions'} onClick={event => togglePanel('reactions', event)}><svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.75"/><path d="M5.4 9.6c.6 1 1.5 1.5 2.6 1.5s2-.5 2.6-1.5"/><circle cx="5.8" cy="6.5" r=".7" fill="currentColor" stroke="none"/><circle cx="10.2" cy="6.5" r=".7" fill="currentColor" stroke="none"/></svg></Button></Tooltip>}
      {role !== 'user' && <Tooltip side="top" portal delayMs={250} label="本条回复用量"><Button variant="ghost" type="button" aria-label="本条回复用量" aria-haspopup="dialog" aria-expanded={panel === 'usage'} onClick={event => togglePanel('usage', event)}><IconGaugeOutlineMedium size={18} /></Button></Tooltip>}
      {timestamp && <Tooltip side="top" portal delayMs={250} label={timestamp.full}><time tabIndex={0} dateTime={timestamp.iso} aria-label={timestamp.full}><span className="ba-message-time-label">{timestamp.short}</span><IconClockOutlineMedium size={18} className="ba-message-time-icon" /></time></Tooltip>}
      {touch && <Button variant="ghost" type="button" aria-label="选择消息文字" onClick={selectText}><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M4 5V3h10v2M9 3v12M6 15h6"/></svg></Button>}
    </div>;
  return <div className="ba-message-actions" ref={root} data-open={panel ? 'true' : undefined} onKeyDown={event => { if (event.key === 'Escape' && panel) { event.preventDefault(); event.stopPropagation(); closePanel(); trigger.current?.focus({ preventScroll: true }); } }} onBlur={event => { if (!touch && !root.current?.contains(event.relatedTarget) && !popup.current?.contains(event.relatedTarget)) closePanel(); }}>
    {(reaction || agentReaction) && <div className="ba-reaction-row">
      {agentReaction && <span className="ba-reaction-chip" data-reactor="assistant" role="img" title={`${assistantName || 'BenchGo'} 的回应`} aria-label={`${assistantName || 'BenchGo'} 回应了 ${agentReaction}`}>{agentReaction}</span>}
      {reaction && <Button variant="ghost" type="button" className="ba-reaction-chip" aria-label={`取消回应 ${reaction}`} disabled={busy} onClick={() => react(reaction)}>{reaction}</Button>}
    </div>}
    {!touch && toolbar}
    {panel && <Menu open anchor={null} anchorRef={trigger} side={side} align={role === 'user' ? 'end' : 'start'} portal autoFocus={touch} returnFocus={touch ? () => message.current : undefined} exiting={closing ? 'dismiss' : undefined} listClassName={`ba-message-menu${touch ? ' ba-message-mobile-menu' : ''}`} onClose={closePanel}><div className={panel === 'actions' ? 'ba-mobile-action-surface' : 'ba-action-popover'} ref={popup} data-action-panel={panel} data-closing={closing || undefined} data-instant={keyboard.current || undefined} role="dialog" tabIndex={-1} aria-label={panel === 'actions' ? '消息操作' : panel === 'reactions' ? '选择表情' : '本条回复用量'}>
      {panel === 'actions' ? toolbar :
      panel === 'reactions' ? <><div className="ba-reaction-title">回应这条消息</div><div className="ba-reaction-options">{reactions.map(([emoji, label]) => <Tooltip key={emoji} side="top" portal delayMs={250} label={label}><Button variant="ghost" type="button" aria-label={`回应 ${emoji}`} aria-pressed={reaction === emoji} disabled={busy} onClick={() => react(emoji)}><span>{emoji}</span></Button></Tooltip>)}</div></> : <><strong>本次回复请求 · Token</strong>{usage.length ? <dl>{usage.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{recordedUsage[key].toLocaleString('zh-CN')}</dd></div>)}</dl> : <p>未记录用量</p>}</>}
    </div></Menu>}
    {error && <span className="ba-action-error" role="alert">{error}</span>}
    <span className="ba-chat-sr" role="status">{copied ? '已复制' : ''}</span>
  </div>;
});
