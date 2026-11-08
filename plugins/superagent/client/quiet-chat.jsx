import { Button } from '../../shared/client/ui/button.jsx';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { quietChatRows } from './quiet-chat.mjs';
import { isChatUserMessage } from '../src/question-reply.mjs';
import css from './quiet-chat.css';
import { MessageActions } from './message-actions.jsx';
import { projectReplyStream } from './reply-stream.mjs';
import { createPortal } from 'react-dom';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import { useChatScroll } from './use-chat-scroll.jsx';
import { TicketAttention } from './ticket-attention.jsx';
import { ticketSnapshot } from './ticket-state.mjs';
import { InteractiveReply } from '../../interactive/client/reply.jsx';
import { sendInteractive } from '../../interactive/client/send.mjs';

const labels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };
const NO_STATUSES = new Map();

/** Mirrors the official answered-question bubble: muted question, the chosen answer below. */
export function QuestionReply({ row }) {
  return <div className="ba-chat-question-reply">{row.questions.map(question => {
    const answer = row.answers.find(item => item.id === question.id);
    const values = [...(answer?.selected || []), ...(answer?.custom ? [answer.custom] : [])];
    return <div className="ba-chat-question" key={question.id}>
      <p className="ba-chat-question-text">{question.header && question.header !== question.question ? `${question.header} · ${question.question}` : question.question}</p>
      <p className={values.length ? 'ba-chat-question-answer' : 'ba-chat-question-answer ba-chat-question-skipped'}>{values.length ? values.join('、') : '已跳过'}</p>
    </div>;
  })}</div>;
}

export function QuietChat({ home, session, chat }) {
  const { history = {}, threadId = 'main', api, onLoadEarlier } = home;
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [chosen, setChosen] = useState({});
  const refresh = useRef(home.onRefresh);
  refresh.current = home.onRefresh;
  const latestUserSeq = chat?.legacy?.nodes?.findLast(node => ['user', 'steering'].includes(node.kind) && isChatUserMessage(node))?.seq;
  const statusSource = home.sessionStatus;
  const statuses = useSyncExternalStore(listener => statusSource?.subscribe(listener) || (() => {}), () => statusSource?.getSnapshot() || NO_STATUSES);
  const awaitingChoice = statuses.get(home.sessionId)?.pendingInteraction?.kind === 'question';
  // Foreground answers settle the tool; continued answers admit an official user message. Refresh both paths.
  useEffect(() => {
    if (latestUserSeq === undefined) return;
    void Promise.resolve(refresh.current?.()).catch(() => { /* Existing history retry owns connection notices. */ });
  }, [latestUserSeq, session.running, awaitingChoice]);
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
      const verificationOnly = row.ticketStatus === 'uncertain' || ticketSnapshot({ status: row.ticketStatus,
        resultVersion: row.currentResultVersion, continuationWait: row.continuationWait,
        instructionRevision: row.currentInstructionRevision, results: row.currentResult ? [row.currentResult] : [] }).safetyWait;
      const attention = row.attention || row.currentAttention;
      const showAttention = attention && !verificationOnly && !rows.slice(index + 1).some(later => (later.attention || later.currentAttention)?.id === attention.id);
      return <article className="ba-chat-message" data-chat-key={row.key} data-role={row.role} key={row.key}>
      <div className="ba-chat-body">
      <div className="ba-chat-content" aria-label={row.role === 'system' ? '消息状态' : row.kind === 'question-reply' ? '你的选择' : row.role === 'user' ? '你' : home.assistantName || 'BenchGo'}>
      {row.kind === 'question-reply' ? <QuestionReply row={row} /> : row.role === 'user' ? <div className="ba-chat-user-text">{row.text}</div> : row.role === 'assistant' ? <InteractiveReply text={row.text || ''} labels={labels} streaming={!!row.streaming} disabled={session.running || !!row.provisional} onSubmit={async (text, request) => { await sendInteractive(home.ctx.sessions, home.sessionId, text, request); void Promise.resolve(home.onRefresh?.()).catch(() => {}); }} /> : <div className="ba-chat-status" role="alert">
        {row.title && <strong>{row.title}</strong>}<span>{row.text}</span>
        {row.requestId && home.onRefresh && <Button variant="link" size="sm" className="ba-chat-status-link" type="button" disabled={busy} onClick={() => run(home.onRefresh)}>重新核实</Button>}
      </div>}
      {row.role === 'user' && (row.content || []).filter(block => ['image', 'file'].includes(block.type)).map((block, index) => <span className="ba-chat-attachment" key={index}>{block.type === 'image' ? '已附图片' : `已附文件${block.name ? `：${block.name}` : ''}`}</span>)}
      </div>
      </div><div className="ba-chat-followup">
      {showAttention && <TicketAttention key={attention.id} api={api} attention={attention} showQuestion={!row.attention} ticket={{ id: row.ticketId, status: row.ticketStatus, instructionRevision: row.currentInstructionRevision ?? row.instructionRevision, resultVersion: row.currentResultVersion ?? row.resultVersion, mandate: { source: { channel: 'desktop' } } }} onAnswered={home.onRefresh} />}
      {row.notification && row.role !== 'system' && !row.attention && row.eventId && row.options?.length > 0 && <div className="ba-chat-options" aria-label="回复选项（不代表审批）">{row.options.map(option => <Button variant="ghost" type="button" className="ba-quiet" key={option} disabled={busy || session.running || !!chosen[row.eventId]} onClick={() => run(async () => { await api('notificationOption', { eventId: row.eventId, threadId, text: option }); setChosen(value => ({ ...value, [row.eventId]: option })); await home.onRefresh?.(); })}>{option}{chosen[row.eventId] === option ? ' · 已发送' : ''}</Button>)}</div>}
      </div>
      {!row.streaming && row.role !== 'system' && <MessageActions row={row} home={home} />}
    </article>; })}
    {!reply && awaitingChoice && <div className="ba-chat-work ba-chat-await" role="status">在下方选项卡中作答后继续</div>}
    {!reply && !awaitingChoice && (session.running || session.pendingSubmissions?.some(row => row.placement === 'transcript')) && <div className="ba-chat-work" role="status" aria-label="加载中"><span className="ba-loading-dots" aria-hidden="true"><i/><i/><i/></span></div>}
    {error && <p className="ba-error" role="alert">{error}</p>}
  </div>{scroll.host && createPortal(<div className="ba-chat-bottom" data-visible={scroll.visible ? 'true' : 'false'}>
    <Button variant="ghost" type="button" className="ba-chat-bottom-button" onClick={scroll.returnToBottom} aria-label={scroll.unread ? '有新回复，回到最新消息' : '回到底部'} title="回到底部" tabIndex={scroll.visible ? 0 : -1} aria-hidden={!scroll.visible}>
      {scroll.unread && <span>有新回复</span>}<UIIcon name="chevronDown" size={20} />
    </Button>
    <span className="ba-chat-sr" role="status">{scroll.visible && scroll.unread ? '有新回复' : ''}</span>
  </div>, scroll.host)}</section>;
}
