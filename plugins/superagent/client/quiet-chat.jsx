import typographyCss from '../../shared/client/chat-typography.css';
import { Button } from '../../shared/client/ui/button.jsx';
import { Disclosure } from '../../shared/client/ui/collapsible.jsx';
import React, { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { quietChatRows, historyReconcileSeq } from './quiet-chat.mjs';
import css from './quiet-chat.css';
import { MessageActions } from './message-actions.jsx';
import { projectReplyRows, conversationActivity } from './reply-stream.mjs';
import { ConversationActivity } from './conversation-activity.jsx';
import { createPortal } from 'react-dom';
import { UIIcon } from '../../base/client/iconsax.jsx';
import { useChatScroll } from './use-chat-scroll.jsx';
import { TaskAttention } from './task-attention.jsx';
import { taskSnapshot } from './task-state.mjs';
import { InlineApproval, useApprovalIndex } from './approval-review.jsx';
import { approvalReminderNavigation } from './approval-flow.mjs';
import { sendInteractive } from '../../base/interactive/client/send.mjs';
import { MessageGallery } from '../../base/client/conversation-images.jsx';
import { AssistantReply, ReplyDeliverables } from './reply-images.jsx';
import { ChatNotice } from './chat-notice.jsx';

const labels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };
const NO_STATUSES = new Map();
const sameFields = (a, b) => { const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(key => Object.is(a[key], b[key])); };
// Live rows rebuild their small content block list on every projection.
const sameBlocks = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((block, index) => sameFields(block, b[index]));
const sameRow = (a, b) => { const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(key => Object.is(a[key], b[key]) || (key === 'content' && sameBlocks(a[key], b[key]))); };

/** Projection rebuilds every row object; an unchanged row keeps its previous identity. */
function useStableRows(rows) {
  const previous = useRef(null), next = new Map();
  const stable = rows.map(row => {
    const prior = previous.current?.get(row.key), value = prior && sameRow(prior, row) ? prior : row;
    next.set(row.key, value);
    return value;
  });
  previous.current = next;
  return stable;
}

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

function MessageContent({ row, assistantName, loadImage }) {
  const attachments = row.role === 'user' ? row.content || [] : [];
  const files = attachments.filter(block => block.type === 'file');
  const images = attachments.filter(block => block.type === 'image' && (block.attachment || block.previewUrl))
    .map(block => block.attachment ? { attachment: block.attachment } : { preview: { url: block.previewUrl, name: block.name } });
  const questionReply = row.kind === 'question-reply';
  return <>
    {(questionReply || row.text || files.length > 0 || !images.length) && <div className="ba-chat-content" aria-label={questionReply ? '你的选择' : row.role === 'user' ? '你' : assistantName || 'BenchGo'}>
      {questionReply ? <QuestionReply row={row} /> : <div className="ba-chat-user-text">{row.text}</div>}
      {files.map((block, index) => <span className="ba-chat-attachment" key={index}>{`已附文件${block.name ? `：${block.name}` : ''}`}</span>)}
    </div>}
    {images.length > 0 && <MessageGallery images={images} loadImage={loadImage} align="end" />}
  </>;
}

// Token updates and history polls re-render the transcript container. Each row
// renders again only when its own data or controls change.
const ChatRow = memo(function ChatRow({ row, attention, saved, agentReaction, chosen, approvalIndex, busy, running, assistantName, threadId, api, onRefresh, onRun, onChosen, onSubmit, onOpenFile, loadImage, SessionProvider, renderSlot }) {
  if (row.kind === 'generated-media') return <article className="ba-chat-message" data-chat-key={row.key} data-role="assistant">
    <div className="ba-chat-body"><ReplyDeliverables images={row.images} files={row.files} /></div>
  </article>;
  if (row.role === 'system') return <ChatNotice noticeKey={row.key} message={<>{row.title && <strong>{row.title} </strong>}<span>{row.text}</span></>}>
    {row.requestId && onRefresh && <Button variant="link" size="sm" type="button" disabled={busy} onClick={() => onRun(onRefresh)}>重新核实</Button>}
  </ChatNotice>;
  return <article className="ba-chat-message" data-approval-event={row.approval?.eventKey} data-approval-request={row.approval ? row.requestId : undefined} tabIndex={row.approval ? -1 : undefined} data-chat-key={row.key} data-role={row.role} data-streaming={row.streaming ? 'true' : undefined}>
    <div className="ba-chat-body">
    {row.role === 'assistant' && row.kind !== 'channel-message' ? <AssistantReply text={row.text || ''} labels={labels} streaming={!!row.streaming} disabled={running || !!row.provisional} onSubmit={onSubmit} onOpenFile={onOpenFile} fileRequestId={row.requestId} assistantName={assistantName || 'BenchGo'} />
      : <MessageContent row={row} assistantName={assistantName} loadImage={loadImage} />}
    </div><div className="ba-chat-followup">
    {row.approval && <InlineApproval row={row} index={approvalIndex} api={api} SessionProvider={SessionProvider} renderSlot={renderSlot} />}
    {attention && <TaskAttention key={attention.id} api={api} attention={attention} showQuestion={!row.attention} task={{ id: row.taskId, status: row.taskStatus, executionControl: row.currentExecutionControl, instructionRevision: row.currentInstructionRevision ?? row.instructionRevision, resultVersion: row.currentResultVersion ?? row.resultVersion, mandate: { source: { channel: 'desktop' } } }} onAnswered={onRefresh} />}
    {row.notification && row.role !== 'system' && !row.attention && row.eventId && row.options?.length > 0 && <div className="ba-chat-options" aria-label="回复选项（不代表审批）">{row.options.map(option => <Button variant="ghost" type="button" className="ba-quiet" key={option} disabled={busy || running || !!chosen} onClick={() => onRun(async () => { await api('notificationOption', { eventId: row.eventId, threadId, text: option }); onChosen(value => ({ ...value, [row.eventId]: option })); await onRefresh?.(); })}>{option}{chosen === option ? ' · 已发送' : ''}</Button>)}</div>}
    </div>
    {row.kind !== 'channel-message' && <MessageActions row={row} saved={saved} agentReaction={agentReaction} assistantName={assistantName} api={api} onRefresh={onRefresh} threadId={threadId} />}
  </article>;
});

export function QuietChat({ home, session, chat, inbox, input, continuation, onOpenFile, loadImage, petError }) {
  const { history = {}, threadId = 'main', api, onLoadEarlier } = home;
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [chosen, setChosen] = useState({});
  const refresh = useRef(home.onRefresh);
  refresh.current = home.onRefresh;
  const submitInteractive = useCallback(async (text, request) => {
    await sendInteractive(home.ctx.sessions, home.sessionId, text, request);
    void Promise.resolve(refresh.current?.()).catch(() => {});
  }, [home.ctx?.sessions, home.sessionId]);
  const latestSeq = chat?.legacy?.nodes?.at(-1)?.seq, reconcileSeq = historyReconcileSeq(chat);
  const statusSource = home.sessionStatus;
  const statuses = useSyncExternalStore(listener => statusSource?.subscribe(listener) || (() => {}), () => statusSource?.getSnapshot() || NO_STATUSES);
  const pendingInteraction = statuses.get(home.sessionId)?.pendingInteraction;
  const awaitingChoice = pendingInteraction?.kind === 'question';
  const activity = conversationActivity(session, chat, pendingInteraction, history);
  // Durable official events and reconnects reconcile business receipts. Token deltas
  // render directly from the official projection and never issue history requests.
  const connected = session.openState !== 'error' && session.openState !== 'loading';
  const reconcile = delay => {
    const timer = setTimeout(() => {
      void Promise.resolve(refresh.current?.()).then(() => setError('')).catch(cause => setError(cause.message || '历史同步失败，请重试。'));
    }, delay);
    return () => clearTimeout(timer);
  };
  useEffect(() => connected ? reconcile(100) : undefined, [reconcileSeq, session.running, session.openState, awaitingChoice]);
  // Steps and tool results settle many times per turn and are already on screen
  // from the live projection; reconcile their receipts once the turn pauses.
  useEffect(() => connected && latestSeq !== reconcileSeq ? reconcile(1500) : undefined, [latestSeq]);
  const replies = projectReplyRows({ history, chat, sessionId: home.sessionId, running: session.running });
  const projected = quietChatRows(history, threadId, session, chat, inbox, replies);
  const rows = useStableRows(projected);
  const lastTurn = chat?.timeline?.turns.get(chat.timeline.turnOrder.at(-1));
  const lastEnd = lastTurn?.end;
  const lastReason = lastEnd?.data?.reason;
  const failureSeq = !home.channel && Number.isSafeInteger(continuation) && (!lastEnd || lastEnd.seq === continuation)
    ? continuation : null;
  const historyError = typeof history.error === 'string' ? history.error : history.error && (history.error.message || '回复失败');
  const superseded = !home.channel && (session.running || input?.phase === 'sending' || (lastTurn && !lastEnd));
  const staleHistory = lastEnd && history.lastEndSeq !== undefined
    && (history.lastEndSeq === null || history.lastEndSeq < lastEnd.seq);
  // The session can still carry an error from before a successful automatic retry.
  const liveFailure = lastReason?.kind === 'error' ? lastReason.error?.message || '回复失败'
    : lastReason?.kind === 'completed' ? '' : session.lastAgentError;
  const replyFailure = superseded ? '' : (!home.channel && liveFailure) || (!staleHistory && historyError);
  const failures = superseded || staleHistory ? [] : (history.failures || []);
  const showReplyFailure = !!replyFailure || (!superseded && failureSeq !== null);
  const approvalIndex = useApprovalIndex({ ctx: home.ctx, api, ownerThreadId: threadId,
    enabled: rows.some(row => !!row.approval) });
  const messageTarget = useSyncExternalStore(approvalReminderNavigation.subscribe, approvalReminderNavigation.getSnapshot);
  const locatingMessage = useRef(null), [locationRevision, setLocationRevision] = useState(0);
  const [locationError, setLocationError] = useState('');
  const scroll = useChatScroll(rows, `${home.sessionId || ''}:${threadId}`);
  useEffect(() => () => { clearTimeout(locatingMessage.current?.timer); locatingMessage.current = null; }, []);
  useEffect(() => {
    if (!messageTarget || messageTarget.threadId !== threadId) return;
    if (locatingMessage.current?.target !== messageTarget) {
      clearTimeout(locatingMessage.current?.timer);
      locatingMessage.current = { target: messageTarget, pages: 0, loading: null, visited: new Set() };
      setLocationError('');
    }
    const location = locatingMessage.current;
    const current = () => locatingMessage.current === location && approvalReminderNavigation.getSnapshot() === messageTarget;
    const fail = message => {
      if (!current()) return;
      clearTimeout(location.timer); setLocationError(message); approvalReminderNavigation.clear(messageTarget);
    };
    const article = [...(scroll.root.current?.querySelectorAll('[data-approval-event]') || [])]
      .find(node => node.dataset.approvalEvent === messageTarget.eventKey && node.dataset.approvalRequest === messageTarget.requestId);
    if (article) {
      clearTimeout(location.timer);
      const frame = requestAnimationFrame(() => {
        if (!current() || !article.isConnected) return;
        scroll.reveal(article);
        approvalReminderNavigation.clear(messageTarget);
      });
      return () => cancelAnimationFrame(frame);
    }
    const messages = history.messages || [];
    const watermark = JSON.stringify([history.nextBefore ?? null, messages.length, messages[0]?.id ?? messages[0]?.seq, messages.at(-1)?.id ?? messages.at(-1)?.seq]);
    if (location.loading) {
      // Completion of the fetch is not completion of React's history commit.
      // Do not read the same cursor again while the previous page is pending.
      if (!location.loading.settled || location.loading.watermark === watermark) return;
      clearTimeout(location.timer); location.loading = null;
    }
    const pageKey = history.nextBefore == null ? watermark : `cursor:${history.nextBefore}`;
    if (!history.hasMore || location.pages >= 20 || location.visited.has(pageKey) || !onLoadEarlier) {
      fail('暂未找到这次审批对应的对话提醒。请返回审核页重试。'); return;
    }
    location.pages++; location.visited.add(pageKey);
    const loading = { watermark, settled: false }; location.loading = loading;
    Promise.resolve().then(() => onLoadEarlier()).then(() => {
      if (!current() || location.loading !== loading) return;
      loading.settled = true;
      // A missing/unchanged page fails once, without repeating its request.
      location.timer = setTimeout(() => fail('历史记录未继续加载，请重试定位。'), 1500);
      setLocationRevision(value => value + 1);
    }).catch(cause => fail(cause.message || String(cause)));
  }, [messageTarget, threadId, home.sessionId, history, onLoadEarlier, locationRevision]);
  const run = useCallback(async operation => {
    setBusy(true); setError('');
    try { await operation(); } catch (cause) { setError(cause.message || String(cause)); } finally { setBusy(false); }
  }, []);
  return <section ref={scroll.root} className="ba-quiet-chat" aria-label="主助手对话"><style>{css}{typographyCss}</style><div className="ba-quiet-chat-column">
    {history.hasMore && <Button variant="ghost" type="button" className="ba-quiet ba-chat-load" disabled={busy} onClick={() => run(onLoadEarlier)}>查看更早消息</Button>}
    {rows.map((row, index) => {
      const attention = row.attention || row.currentAttention;
      // A stopped task, or one awaiting verification, must not offer a live answer.
      const answerable = attention && !(row.currentExecutionControl?.stopRequested || row.currentExecutionControl?.stopped || taskSnapshot({ status: row.taskStatus, executionControl: row.currentExecutionControl,
        resultVersion: row.currentResultVersion, continuationWait: row.currentContinuationWait ?? row.continuationWait,
        instructionRevision: row.currentInstructionRevision, results: row.currentResult ? [row.currentResult] : [] }).safetyWait)
        && !rows.slice(index + 1).some(later => (later.attention || later.currentAttention)?.id === attention.id);
      return <ChatRow key={row.key} row={row} attention={answerable ? attention : null} saved={history.reactions?.[row.key] || null} agentReaction={row.role === 'user' ? history.assistantReactions?.[row.key] || null : null}
        chosen={row.eventId ? chosen[row.eventId] : undefined} approvalIndex={row.approval ? approvalIndex : undefined}
        busy={(row.role === 'system' || !!row.notification) && busy} running={(row.role === 'assistant' || !!row.notification) && !!session.running} assistantName={home.assistantName} threadId={threadId} api={api} onRefresh={home.onRefresh}
        onRun={run} onChosen={setChosen} onSubmit={submitInteractive} onOpenFile={onOpenFile} loadImage={loadImage} SessionProvider={row.approval ? home.SessionProvider : undefined} renderSlot={row.approval ? home.renderSlot : undefined} />;
    })}
    {(showReplyFailure || failures.length > 0) && <ChatNotice noticeKey={showReplyFailure ? 'notice:reply-failed' : undefined}
      tone={showReplyFailure ? 'error' : undefined} message={showReplyFailure ? replyFailure || '回复失败' : undefined}>
      {failures.length > 0 && <div className="ba-chat-notice-details">
        <Disclosure className="ba-chat-model-failures" title="模型连接记录">
          <ul>{failures.map((failure, index) => <li key={index}>
            <span>{failure.model?.modelId || '候选模型'}</span><span>{failure.reason || failure.message || '暂不可用'}</span>
          </li>)}</ul>
        </Disclosure>
      </div>}
    </ChatNotice>}
    {home.loadError && <ChatNotice noticeKey="notice:load-failed" message={home.loadError}>
      <div className="ba-chat-notice-actions">
        <Button variant="ghost" type="button" onClick={home.onRetryLoad}>重试加载</Button>
        <Button variant="ghost" type="button" onClick={home.onDismissLoadError}>关闭错误</Button>
      </div>
    </ChatNotice>}
    {petError && <ChatNotice noticeKey="notice:pet-failed" message={`形象信息：${petError}`} />}
    {error && <ChatNotice noticeKey="notice:action-failed" message={error} />}
    {locationError && <ChatNotice noticeKey="notice:location-failed" message={locationError} />}
    {(rows.length > 0 || showReplyFailure || failures.length > 0 || home.loadError || petError || error || locationError || activity || awaitingChoice) && <div className="ba-chat-tail">
      {!replies.length && awaitingChoice && <div className="ba-chat-work ba-chat-await" role="status">在下方选项卡中作答后继续</div>}
      {activity && !awaitingChoice && <ConversationActivity activity={activity} />}
    </div>}
  </div>{scroll.host && createPortal(<div className="ba-chat-bottom" data-visible={scroll.visible ? 'true' : 'false'}>
    <Button variant="ghost" type="button" className="ba-chat-bottom-button" onClick={scroll.returnToBottom} aria-label={scroll.unread ? '有新回复，回到最新消息' : '回到底部'} title="回到底部" tabIndex={scroll.visible ? 0 : -1} aria-hidden={!scroll.visible}>
      {scroll.unread && <span>有新回复</span>}<UIIcon name="chevronDown" size={20} />
    </Button>
    <span className="ba-chat-sr" role="status">{scroll.visible && scroll.unread ? '有新回复' : ''}</span>
  </div>, scroll.host)}</section>;
}
