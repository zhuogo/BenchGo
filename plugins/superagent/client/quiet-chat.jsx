import { Button } from '../../shared/client/ui/button.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
import { quietChatRows } from './quiet-chat.mjs';
import css from './quiet-chat.css';
import { MessageActions } from './message-actions.jsx';
import { projectReplyStream } from './reply-stream.mjs';
import { createPortal } from 'react-dom';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import { useChatScroll } from './use-chat-scroll.jsx';
import { TicketAttention } from './ticket-attention.jsx';
import { continuationRecovery, ticketSnapshot } from './ticket-state.mjs';

const labels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };

export function QuietChat({ home, session, chat }) {
  const { history = {}, threadId = 'main', api, onLoadEarlier } = home;
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [chosen, setChosen] = useState({});
  const refresh = useRef(home.onRefresh);
  refresh.current = home.onRefresh;
  const latestUserSeq = chat?.legacy?.nodes?.findLast(node => ['user', 'steering'].includes(node.kind) && node.source?.kind === 'user')?.seq;
  useEffect(() => {
    if (latestUserSeq === undefined) return;
    void Promise.resolve(refresh.current?.()).catch(() => { /* Existing history retry owns connection notices. */ });
  }, [latestUserSeq, session.running]);
  const rows = quietChatRows(history, threadId, session, chat);
  const reply = projectReplyStream({ history, chat, sessionId: home.sessionId, running: session.running });
  if (reply && !rows.some(row => row.key === reply.key)) rows.push(reply);
  const scroll = useChatScroll(rows, `${home.sessionId || ''}:${threadId}`);
  async function run(operation) {
    setBusy(true); setError('');
    try { await operation(); } catch (cause) { setError(cause.message || String(cause)); } finally { setBusy(false); }
  }
  return <section ref={scroll.root} className="ba-quiet-chat" aria-label="主助手对话"><style>{css}</style><div className="ba-quiet-chat-column">
    {history.hasMore && <Button variant="ghost" type="button" className="ba-quiet ba-chat-load" disabled={busy} onClick={() => run(onLoadEarlier)}>查看更早消息</Button>}
    {rows.map((row, index) => {
      const currentTicket = row.ticketId && !rows.slice(index + 1).some(later => later.ticketId === row.ticketId)
        ? { id: row.ticketId, status: row.ticketStatus, instructionRevision: row.currentInstructionRevision,
          resultVersion: row.currentResultVersion, continuationWait: row.continuationWait } : null;
      const recovery = currentTicket && continuationRecovery(currentTicket);
      const safetyWait = currentTicket?.status === 'waiting' && ticketSnapshot(currentTicket).safetyWait;
      return <article className="ba-chat-message" data-chat-key={row.key} data-role={row.role} key={row.key}>
      <div className="ba-chat-body">
      <div className="ba-chat-content" aria-label={row.role === 'system' ? '系统状态' : row.role === 'user' ? '你' : home.assistantName || 'BenchGo'}>
      {row.role === 'system' && <div className="ba-chat-system-label">系统状态</div>}
      {row.role === 'user' ? <div className="ba-chat-user-text">{row.text}</div> : <MarkdownText text={row.text || ''} labels={labels} />}
      {row.role === 'user' && (row.content || []).filter(block => ['image', 'file'].includes(block.type)).map((block, index) => <span className="ba-chat-attachment" key={index}>{block.type === 'image' ? '已附图片' : `已附文件${block.name ? `：${block.name}` : ''}`}</span>)}
      </div>
      {row.type === 'ticket.attention' && row.attention && <TicketAttention key={row.attention.id} api={api} attention={row.attention} showQuestion={false} ticket={{ id: row.ticketId, status: row.ticketStatus, instructionRevision: row.currentInstructionRevision ?? row.instructionRevision, resultVersion: row.currentResultVersion ?? row.resultVersion, mandate: { source: { channel: 'desktop' } } }} onAnswered={home.onRefresh} />}
      {safetyWait && <div role="status" aria-label="系统状态">系统状态 · 待核实外部效果</div>}
      {recovery && <div className="ba-chat-options" aria-label="系统续做操作"><Button variant="ghost" type="button" className="ba-quiet" disabled={busy || (recovery.goalBudget && !home.onOpenResources)} onClick={() => recovery.goalBudget ? home.onOpenResources?.('goals') : run(async () => { const response = await api('ticketResume', recovery.input); if (response?.queued === false) throw new Error(`系统状态：原工单暂未恢复（${response.code || 'WAITING'}）`); await home.onRefresh?.(); })}>{recovery.label}</Button></div>}
      {row.notification && !row.attention && row.eventId && row.options?.length > 0 && <div className="ba-chat-options" aria-label="回复选项（不代表审批）">{row.options.map(option => <Button variant="ghost" type="button" className="ba-quiet" key={option} disabled={busy || session.running || !!chosen[row.eventId]} onClick={() => run(async () => { await api('notificationOption', { eventId: row.eventId, threadId, text: option }); setChosen(value => ({ ...value, [row.eventId]: option })); await home.onRefresh?.(); })}>{option}{chosen[row.eventId] === option ? ' · 已发送' : ''}</Button>)}</div>}
      </div>
      {!row.streaming && row.role !== 'system' && <MessageActions row={row} home={home} />}
    </article>; })}
    {!reply && (session.running || session.pendingSubmissions?.some(row => row.placement === 'transcript')) && <div className="ba-chat-work" role="status" aria-label="加载中"><span className="ba-loading-dots" aria-hidden="true"><i/><i/><i/></span></div>}
    {error && <p className="ba-error" role="alert">{error}</p>}
  </div>{scroll.host && createPortal(<div className="ba-chat-bottom" data-visible={scroll.visible ? 'true' : 'false'}>
    <Button variant="ghost" type="button" className="ba-chat-bottom-button" onClick={scroll.returnToBottom} aria-label={scroll.unread ? '有新回复，回到最新消息' : '回到底部'} title="回到底部" tabIndex={scroll.visible ? 0 : -1} aria-hidden={!scroll.visible}>
      {scroll.unread && <span>有新回复</span>}<UIIcon name="chevronDown" size={20} />
    </Button>
    <span className="ba-chat-sr" role="status">{scroll.visible && scroll.unread ? '有新回复' : ''}</span>
  </div>, scroll.host)}</section>;
}
