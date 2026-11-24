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
function canRetryReply(session, input, inbox, pendingInteraction, composerBlocked) {
  return session?.openState === 'open' && !session.running && !session.removed && session.subagent === null
    && input?.phase === 'plain' && !session.pendingSubmissions?.length && !input.queue?.length
    && !inbox?.['next-turn']?.length && !inbox?.['next-step']?.some(item => item.source?.kind === 'user')
    && !pendingInteraction && !composerBlocked;
}

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

export function QuietChat({ home, session, chat, inbox, input, continuation, promptAllowed, composerBlocked, onOpenFile, loadImage, petError }) {
  const { history = {}, threadId = 'main', api, onLoadEarlier } = home;
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [chosen, setChosen] = useState({});
  const [retryAttempt, setRetryAttempt] = useState(null), latestRetry = useRef(null);
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
  const retrying = retryAttempt?.phase === 'pending';
  const retryAccepted = retryAttempt?.phase === 'accepted' && retryAttempt.seq === continuation;
  const retryError = retryAttempt?.phase === 'failed' && retryAttempt.seq === failureSeq ? retryAttempt.error : '';
  const historyError = typeof history.error === 'string' ? history.error : history.error && (history.error.message || '回复失败');
  const superseded = !home.channel && (session.running || input?.phase === 'sending' || retryAccepted || (lastTurn && !lastEnd));
  const staleHistory = lastEnd && history.lastEndSeq !== undefined
    && (history.lastEndSeq === null || history.lastEndSeq < lastEnd.seq);
  // The session can still carry an error from before a successful automatic retry.
  const liveFailure = lastReason?.kind === 'error' ? lastReason.error?.message || '回复失败'
    : lastReason?.kind === 'completed' ? '' : session.lastAgentError;
  const replyFailure = superseded ? '' : (!home.channel && liveFailure) || (!staleHistory && historyError);
  const failures = superseded || staleHistory ? [] : (history.failures || []);
  const showReplyFailure = !!replyFailure || (!superseded && failureSeq !== null);
  const showRetry = promptAllowed && failureSeq !== null && !superseded;
  const canRetry = showRetry && canRetryReply(session, input, inbox, pendingInteraction, composerBlocked);
  async function retryReply(seq) {
    if (!canRetry || latestRetry.current?.phase === 'pending'
      || (latestRetry.current?.seq === seq && latestRetry.current.phase === 'accepted')) return;
    const { ctx, sessionId } = home;
    const binding = ctx.sessions.binding(sessionId);
    const target = binding?.session;
    if (!target || target.projections.faceOf('conversationContinuation').getSnapshot() !== seq
      || ctx.remoteAccess?.source('session', sessionId, 'session/prompt').getSnapshot() === false) return;
    const currentInput = ctx.conversation.input.for(binding.ctx).state.getSnapshot();
    const currentInbox = target.projections.faceOf('inbox').getSnapshot();
    const currentInteraction = statusSource?.getSnapshot().get(sessionId)?.pendingInteraction;
    const currentBlock = ctx.conversation.blocks.storeFor(sessionId).getSnapshot();
    if (!canRetryReply(target.getSnapshot(), currentInput, currentInbox, currentInteraction, currentBlock)) return;
    const updateAttempt = (phase, error) => {
      latestRetry.current = { seq, phase, error };
      setRetryAttempt(latestRetry.current);
    };
    updateAttempt('pending');
    try {
      const result = await target.prompt([], 'queue');
      if (!result.ok) throw result.error;
      updateAttempt('accepted');
    } catch (cause) {
      updateAttempt('failed', cause?.message || String(cause));
    }
  }
  const approvalIndex = useApprovalIndex({ ctx: home.ctx, api, ownerThreadId: threadId,
    enabled: rows.some(row => !!row.approval) });
  const approvalTarget = useSyncExternalStore(approvalReminderNavigation.subscribe, approvalReminderNavigation.getSnapshot);
  const locatingApproval = useRef(null), [locationRevision, setLocationRevision] = useState(0);
  const scroll = useChatScroll(rows, `${home.sessionId || ''}:${threadId}`);
  useEffect(() => () => clearTimeout(locatingApproval.current?.timer), []);
  useEffect(() => {
    if (!approvalTarget || approvalTarget.threadId !== threadId) return;
    if (locatingApproval.current?.target !== approvalTarget) {
      clearTimeout(locatingApproval.current?.timer);
      locatingApproval.current = { target: approvalTarget, pages: 0, loading: null, visited: new Set() };
    }
    const location = locatingApproval.current;
    const fail = message => {
      if (locatingApproval.current !== location || approvalReminderNavigation.getSnapshot() !== approvalTarget) return;
      clearTimeout(location.timer); setError(message); approvalReminderNavigation.clear(approvalTarget);
    };
    const article = [...(scroll.root.current?.querySelectorAll('[data-approval-event]') || [])]
      .find(node => node.dataset.approvalEvent === approvalTarget.eventKey && node.dataset.approvalRequest === approvalTarget.requestId);
    if (article) {
      clearTimeout(location.timer);
      article.scrollIntoView({ block: 'center', behavior: 'auto' }); article.focus({ preventScroll: true });
      approvalReminderNavigation.clear(approvalTarget); return;
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
      if (locatingApproval.current !== location || location.loading !== loading || approvalReminderNavigation.getSnapshot() !== approvalTarget) return;
      loading.settled = true;
      // A missing/unchanged page fails once, without repeating its request.
      location.timer = setTimeout(() => fail('历史记录未继续加载，请返回审核页重试。'), 1500);
      setLocationRevision(value => value + 1);
    }).catch(cause => fail(cause.message || String(cause)));
  }, [approvalTarget, threadId, history, onLoadEarlier, locationRevision]);
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
    {(showReplyFailure || failures.length > 0) && <ChatNotice noticeKey={showReplyFailure ? 'notice:reply-failed' : undefined} message={showReplyFailure
      ? home.channel ? '本次回复未完成，对话记录已保留。请重试或检查模型连接。' : '本次回复未完成，对话记录已保留。'
      : undefined}>
      {showRetry && <div className="ba-chat-notice-actions">
        <Button variant="ghost" type="button" disabled={!canRetry || retrying} aria-busy={retrying || undefined} onClick={() => retryReply(failureSeq)}>
          <UIIcon name="refresh" size={16} />
          {retrying ? '正在重试…' : '重试回复'}
        </Button>
      </div>}
      {retryError && <p role="alert">重试提交失败：{retryError}</p>}
      <div className="ba-chat-notice-details">
        {replyFailure && <Disclosure className="ba-chat-diagnostics" title="诊断详情">
          <pre tabIndex={0} aria-label="诊断正文">{replyFailure}</pre>
        </Disclosure>}
        {failures.length > 0 && <Disclosure className="ba-chat-model-failures" title="模型连接记录">
          <ul>{failures.map((failure, index) => <li key={index}>
            <span>{failure.model?.modelId || '候选模型'}</span><span>{failure.reason || failure.message || '暂不可用'}</span>
          </li>)}</ul>
        </Disclosure>}
      </div>
    </ChatNotice>}
    {home.loadError && <ChatNotice noticeKey="notice:load-failed" message={home.loadError}>
      <div className="ba-chat-notice-actions">
        <Button variant="ghost" type="button" onClick={home.onRetryLoad}>重试加载</Button>
        <Button variant="ghost" type="button" onClick={home.onDismissLoadError}>关闭错误</Button>
      </div>
    </ChatNotice>}
    {petError && <ChatNotice noticeKey="notice:pet-failed" message={`形象信息：${petError}`} />}
    {error && <ChatNotice noticeKey="notice:action-failed" message={error} />}
    {(rows.length > 0 || showReplyFailure || failures.length > 0 || home.loadError || petError || error || activity || awaitingChoice) && <div className="ba-chat-tail">
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
