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
  const reaction = override === undefined ? saved : override;
  useEffect(() => { setOverride(undefined); }, [saved, threadId, messageKey]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!panel) return;
    (popup.current?.querySelector('button') || popup.current)?.focus({ preventScroll: true });
  }, [panel]);
  function togglePanel(name, event) {
    trigger.current = event.currentTarget;
    setSide(event.currentTarget.getBoundingClientRect().top < window.innerHeight / 2 ? 'bottom' : 'top');
    setPanel(panel === name ? '' : name);
  }
  async function react(emoji) {
    setBusy(true); setError('');
    try {
      const next = reaction === emoji ? null : emoji;
      await api('messageReaction', { threadId, messageKey, emoji: next });
      setOverride(next); setPanel(''); trigger.current?.focus();
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
  const timestamp = useMemo(() => {
    const date = time != null ? new Date(time) : null;
    return date && Number.isFinite(date.getTime()) ? { iso: date.toISOString(), full: date.toLocaleString('zh-CN'),
      short: date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) } : null;
  }, [time]);
  const usage = useMemo(() => Object.entries(usageLabels).filter(([key]) => Number.isFinite(recordedUsage?.[key]) && recordedUsage[key] >= 0), [recordedUsage]);
  return <div className="ba-message-actions" ref={root} data-open={panel ? 'true' : undefined} onKeyDown={event => { if (event.key === 'Escape' && panel) { event.preventDefault(); event.stopPropagation(); setPanel(''); trigger.current?.focus({ preventScroll: true }); } }} onBlur={event => { if (!root.current?.contains(event.relatedTarget) && !popup.current?.contains(event.relatedTarget)) setPanel(''); }}>
    {(reaction || agentReaction) && <div className="ba-reaction-row">
      {agentReaction && <span className="ba-reaction-chip" data-reactor="assistant" role="img" title={`${assistantName || 'BenchGo'} 的回应`} aria-label={`${assistantName || 'BenchGo'} 回应了 ${agentReaction}`}>{agentReaction}</span>}
      {reaction && <Button variant="ghost" type="button" className="ba-reaction-chip" aria-label={`取消回应 ${reaction}`} disabled={busy} onClick={() => react(reaction)}>{reaction}</Button>}
    </div>}
    <div className="ba-message-toolbar" role="group" aria-label="消息操作">
      <Tooltip side="top" portal delayMs={250} label={copied ? '已复制' : '复制'}><Button variant="ghost" type="button" data-copied={copied || undefined} aria-label={copied ? '已复制' : '复制消息'} onClick={copy}>{copied ? <IconCheckOutlineMedium size={18} /> : <IconCopyOutlineMedium size={18} />}</Button></Tooltip>
      {!provisional && <Tooltip side="top" portal delayMs={250} label="表情回应"><Button variant="ghost" type="button" aria-label="表情回应" aria-haspopup="dialog" aria-expanded={panel === 'reactions'} onClick={event => togglePanel('reactions', event)}><svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.75"/><path d="M5.4 9.6c.6 1 1.5 1.5 2.6 1.5s2-.5 2.6-1.5"/><circle cx="5.8" cy="6.5" r=".7" fill="currentColor" stroke="none"/><circle cx="10.2" cy="6.5" r=".7" fill="currentColor" stroke="none"/></svg></Button></Tooltip>}
      {role !== 'user' && <Tooltip side="top" portal delayMs={250} label="本条回复用量"><Button variant="ghost" type="button" aria-label="本条回复用量" aria-haspopup="dialog" aria-expanded={panel === 'usage'} onClick={event => togglePanel('usage', event)}><IconGaugeOutlineMedium size={18} /></Button></Tooltip>}
      {timestamp && <Tooltip side="top" portal delayMs={250} label={timestamp.full}><time tabIndex={0} dateTime={timestamp.iso} aria-label={timestamp.full}><span className="ba-message-time-label">{timestamp.short}</span><IconClockOutlineMedium size={18} className="ba-message-time-icon" /></time></Tooltip>}
    </div>
    {panel && <Menu open anchor={null} anchorRef={trigger} side={side} align={role === 'user' ? 'end' : 'start'} portal listClassName="ba-message-menu" onClose={() => setPanel('')}><div className="ba-action-popover" ref={popup} data-action-panel={panel} role="dialog" tabIndex={-1} aria-label={panel === 'reactions' ? '选择表情' : '本条回复用量'}>
      {panel === 'reactions' ? <><div className="ba-reaction-title">回应这条消息</div><div className="ba-reaction-options">{reactions.map(([emoji, label]) => <Tooltip key={emoji} side="top" portal delayMs={250} label={label}><Button variant="ghost" type="button" aria-label={`回应 ${emoji}`} aria-pressed={reaction === emoji} disabled={busy} onClick={() => react(emoji)}><span>{emoji}</span></Button></Tooltip>)}</div></> : <><strong>本次回复请求 · Token</strong>{usage.length ? <dl>{usage.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{recordedUsage[key].toLocaleString('zh-CN')}</dd></div>)}</dl> : <p>未记录用量</p>}</>}
    </div></Menu>}
    {error && <span className="ba-action-error" role="alert">{error}</span>}
    <span className="ba-chat-sr" role="status">{copied ? '已复制' : ''}</span>
  </div>;
});
