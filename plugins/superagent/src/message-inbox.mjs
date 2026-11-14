import { createHash, randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { readModelFallbacks } from './model-fallback.mjs';
import { readQuestionReply, readBoundQuestionReply } from './question-reply.mjs';
import { taskReplySource, taskReplyInstruction, taskReplyIdentity } from './task-reply.mjs';
import { watchdogIncidentIdentity, watchdogNoticeCurrent, watchdogNotificationIdentity } from './watchdog-router-signal.mjs';
import { approvalSignalBinding } from './approval-chat-binding.mjs';

const active = new Set(['queued', 'processing', 'prepared']);
const fingerprint = (threadId, text, context) => createHash('sha256').update(JSON.stringify(context === undefined ? [threadId, text] : [threadId, text, context])).digest('hex');
const taskReplyMessageSource = (signal, threadId) => {
  const approval = approvalSignalBinding(signal, threadId);
  return { kind: taskReplySource, replyKind: signal.kind, eventKey: signal.eventKey, taskId: signal.taskId,
    ...(signal.kind === 'result' ? { replyMode: 'conversation' } : {}),
    ...(approval ? { approval } : {}) };
};

function replySnapshot(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['eventId', 'taskId', 'instructionRevision', 'resultVersion', 'question'].includes(key))
    || typeof value.eventId !== 'string' || !value.eventId || value.eventId.length > 200
    || typeof value.taskId !== 'string' || !value.taskId || value.taskId.length > 200
    || !Number.isSafeInteger(value.instructionRevision) || value.instructionRevision < 1
    || (value.resultVersion !== null && value.resultVersion !== undefined && (!Number.isSafeInteger(value.resultVersion) || value.resultVersion < 1))
    || typeof value.question !== 'string' || value.question.length > 200_000) throw new Error('无效回复关联');
  return { eventId: value.eventId, taskId: value.taskId, instructionRevision: value.instructionRevision,
    resultVersion: value.resultVersion ?? null, question: value.question };
}

/** Receipt state is reconciled against the host transcript, never an LLM guess. */
export function messageReceiptFromEvents(request, events) {
  const plans = [...readModelFallbacks(events).values()].filter(plan => plan.requestId === request.messageId);
  if (plans.length) {
    const latest = plans.at(-1);
    if (latest.cancelled) return { status: 'cancelled' };
    if (latest.end) {
      return receiptEnding(latest.end);
    }
    return { status: 'uncertain', error: '正在核实原请求的备用模型续行；未重放用户消息。' };
  }
  const index = events.findIndex(event => event.type === 'user/message' && event.data?.id === request.messageId);
  if (index < 0) return { status: 'uncertain', error: '消息提交状态待核实；未自动重放，请检查会话记录。' };
  const end = events.slice(index + 1).find(event => event.type === 'turn/end');
  if (!end) return { status: 'uncertain', error: '原消息已记录，但 Router 回合尚未完成；等待会话恢复。' };
  return receiptEnding(end.data?.reason);
}

function receiptEnding(reason) {
  if (reason?.kind === 'error') return { status: 'failed', error: String(reason.error?.message || 'Router 处理失败') };
  if (reason?.kind === 'aborted' && reason.reason?.kind === 'user') return { status: 'cancelled' };
  if (reason?.kind === 'interrupted' || reason?.kind === 'aborted') return { status: 'uncertain', error: 'Router 回合中断，未重放原请求。' };
  return { status: 'processed' };
}

/** Reuses state.requests: one durable inbox, one host writer per conversation. */
export function createMessageInbox({ getState, updateState, ensureSession, getAgent, readSession, beforeDispatch, onDispatch, onSettled, onChange = () => {}, now = Date.now, isStopped = () => false }) {
  const drains = new Map();
  const receipt = row => ({ threadId: row.threadId, sessionId: row.sessionId ?? null, requestId: row.requestId, messageId: row.messageId, status: row.status === 'sent' ? 'processed' : row.status, ...(row.error ? { error: row.error } : {}) });
  const patch = async (requestId, change) => updateState(state => ({ requests: (state.requests || []).map(row => row.requestId === requestId ? { ...row, ...change,
    ...(change.status === 'processed' ? { message: undefined } : {}), updatedAt: new Date(now()).toISOString() } : row) }));
  async function reconcile(threadId, agent) {
    const rows = (await getState()).requests || [];
    for (const row of rows.filter(item => item.threadId === threadId && ['prepared', 'processing', 'uncertain', 'sent'].includes(item.status))) {
      if (agent?.status === 'running') return;
      try {
        if (!row.sessionId) throw new Error('缺少原始会话标识');
        const { events } = await readSession(row.sessionId);
        const ending = messageReceiptFromEvents(row, events);
        await patch(row.requestId, ending);
        // Downstream bookkeeping never changes whether the Router finished.
        await onSettled?.({ ...row, ...ending });
      } catch (error) { await patch(row.requestId, { status: 'uncertain', error: `无法核实原消息交付：${error.message}` }); }
    }
  }
  function drain(threadId) {
    if (isStopped()) return Promise.resolve();
    if (drains.has(threadId)) return drains.get(threadId);
    const operation = (async () => {
      let agent;
      try {
        const rows = (await getState()).requests || [];
        if (!rows.some(row => row.threadId === threadId && (active.has(row.status) || ['uncertain', 'sent'].includes(row.status)))) return;
        agent = getAgent?.(threadId);
        if (isStopped() || agent?.status === 'running') return;
        await reconcile(threadId, agent);
        const queued = ((await getState()).requests || []).filter(item => item.threadId === threadId && item.status === 'queued');
        const row = queued.find(item => !item.taskReply && !item.executionInput) || queued[0];
        if (!row || isStopped()) return;
        agent ||= await ensureSession({ threadId });
        if (isStopped() || agent.status === 'running') return;
        await patch(row.requestId, { status: 'processing', sessionId: agent.id });
        if (isStopped()) {
          await patch(row.requestId, { status: 'queued' });
          return;
        }
        // Cancellation/clear may have committed while the writer was prepared.
        if (!((await getState()).requests || []).some(item => item.requestId === row.requestId && item.status === 'processing')) return;
        try {
          if (await beforeDispatch?.({ ...row, sessionId: agent.id }, agent) === false) {
            await patch(row.requestId, { status: 'processed', suppressed: true });
            return;
          }
          if (isStopped()) { await patch(row.requestId, { status: 'queued' }); return; }
          if (!((await getState()).requests || []).some(item => item.requestId === row.requestId && item.status === 'processing')) return;
          onDispatch?.(row, agent);
          agent.followup(row.message);
        } catch (error) {
          await patch(row.requestId, { status: 'uncertain', error: `消息分诊提交失败，未自动重放：${error.message}` });
          onChange({ type: 'inbox', threadId, status: 'uncertain' });
        }
      } catch (error) {
        // An unavailable model/session must not strand accepted messages forever.
        await updateState(state => ({ requests: (state.requests || []).map(row => row.threadId === threadId && row.status === 'queued'
          ? { ...row, status: 'failed', error: `无法启动消息分诊：${error.message}`, updatedAt: new Date(now()).toISOString() } : row) }));
        onChange({ type: 'inbox', threadId, status: 'failed' });
      }
    })();
    drains.set(threadId, operation);
    operation.finally(async () => {
      if (drains.get(threadId) === operation) drains.delete(threadId);
      if (!isStopped() && getAgent?.(threadId)?.status === 'idle'
        && ((await getState()).requests || []).some(row => row.threadId === threadId && row.status === 'queued')) void drain(threadId);
    }).catch(() => {});
    return operation;
  }
  return {
    async enqueueTaskReply({ threadId, signal, retry = false, retryMessageId, suppressReason }) {
      const requestId = `task-reply:${signal.eventKey}`, digest = fingerprint(threadId, signal);
      await updateState(state => {
        if (signal.kind === 'watchdog') {
          const sameId = (state.requests || []).find(row => row.taskReply?.kind === 'watchdog'
            && (row.taskReply.observation.id === signal.observation.id || row.watchdogReceipts?.some(receipt => receipt.id === signal.observation.id)));
          const alias = sameId?.watchdogReceipts?.find(receipt => receipt.id === signal.observation.id);
          if (sameId && (alias ? alias.fingerprint !== digest : taskReplyIdentity(sameId.taskReply) !== taskReplyIdentity(signal))) throw new Error('Watchdog 信号标识冲突');
        }
        const previous = (state.requests || []).find(row => row.requestId === requestId);
        if (previous) {
          if (signal.kind === 'watchdog' && previous.taskReply?.kind === 'watchdog' && !retry) {
            if (previous.threadId !== threadId || watchdogNotificationIdentity(previous.taskReply) !== watchdogNotificationIdentity(signal))
              throw new Error('Watchdog 观察事件标识冲突');
            if (previous.taskReply.observation.id !== signal.observation.id && !previous.watchdogReceipts?.some(receipt => receipt.id === signal.observation.id)) {
              if ((previous.watchdogReceipts?.length || 0) >= 64) throw new Error('Watchdog 观察事件重复标识过多');
              return { requests: state.requests.map(row => row.requestId === requestId
                ? { ...row, watchdogReceipts: [...(row.watchdogReceipts || []), { id: signal.observation.id, fingerprint: digest }] } : row) };
            }
            return {};
          }
          if (previous.threadId !== threadId || taskReplyIdentity(previous.taskReply) !== taskReplyIdentity(signal)) throw new Error('任务回复标识冲突');
          if (retry && retryMessageId !== undefined && previous.messageId !== retryMessageId) return {};
          if (retry && ['failed', 'processed'].includes(previous.status) && !previous.suppressed) {
            const message = createUserMessage({ source: taskReplyMessageSource(signal, threadId), content: [{ type: 'text', text: taskReplyInstruction(signal) }] });
            return { requests: state.requests.map(row => row.requestId === requestId ? { ...row, messageId: message.id, message,
              sessionId: null, taskReply: signal, fingerprint: digest, status: 'queued', error: undefined,
              attempt: (row.attempt || 1) + 1, retryAt: undefined, replyNotified: undefined, replyRetryAt: undefined, replyError: undefined,
              updatedAt: new Date(now()).toISOString() } : row) };
          }
          if (previous.status !== 'queued') return {};
          return { requests: state.requests.map(row => row.requestId === requestId ? { ...row, fingerprint: digest, taskReply: signal,
            message: { ...row.message, source: taskReplyMessageSource(signal, threadId), content: [{ type: 'text', text: taskReplyInstruction(signal) }] } } : row) };
        }
        const message = createUserMessage({ source: taskReplyMessageSource(signal, threadId),
          content: [{ type: 'text', text: taskReplyInstruction(signal) }] });
        const superseded = signal.kind === 'watchdog' && !watchdogNoticeCurrent(signal, state.requests || []);
        return { requests: [...(state.requests || []).map(row => !suppressReason && signal.kind === 'watchdog' && row.status === 'queued'
          && watchdogIncidentIdentity(row.taskReply) === watchdogIncidentIdentity(signal)
          && !watchdogNoticeCurrent(row.taskReply, [{ taskReply: signal }])
          ? { ...row, status: 'processed', suppressed: true, suppressionReason: 'watchdog-incident-superseded', message: undefined } : row),
        { requestId, threadId, messageId: message.id, message,
          taskReply: signal, fingerprint: digest, attempt: 1,
          status: suppressReason || superseded ? 'processed' : 'queued',
          ...(suppressReason || superseded ? { suppressed: true, suppressionReason: suppressReason || 'watchdog-incident-superseded' } : {}),
          createdAt: new Date(now()).toISOString() }] };
      });
      void drain(threadId);
      return structuredClone((await getState()).requests.find(row => row.requestId === requestId));
    },
    // Called at the official inbox claim seam. The Host already owns dispatch:
    // retain the exact message ID for receipts, never enqueue or followup again.
    async admit({ threadId = 'main', sessionId, message, events, questionReply: trustedReply }) {
      const questionReply = trustedReply ? readBoundQuestionReply(message, trustedReply.questions) : readQuestionReply(message, events || []);
      if (!sessionId || typeof message?.id !== 'string' || !message.id || !questionReply) throw new Error('无效官方问题答复');
      const requestId = `question-reply:${message.id}`, digest = fingerprint(threadId, message.content, questionReply);
      let duplicate = false;
      await updateState(state => {
        const previous = (state.requests || []).find(row => row.requestId === requestId || row.messageId === message.id);
        if (previous) {
          if (previous.threadId !== threadId || previous.sessionId !== sessionId || previous.fingerprint !== digest) throw new Error('问题答复标识冲突');
          duplicate = true;
          return {};
        }
        return { requests: [...(state.requests || []), { requestId, threadId, sessionId, messageId: message.id, message,
          fingerprint: digest, questionReply, status: 'processing', createdAt: new Date(now()).toISOString() }] };
      });
      const row = (await getState()).requests.find(item => item.requestId === requestId);
      onChange({ type: 'inbox', threadId, requestId, status: row.status });
      return { ...receipt(row), ...(duplicate ? { duplicate: true } : {}) };
    },
    async enqueue({ threadId = 'main', text, requestId = randomUUID(), replyContext, hostExecutionInput }) {
      const context = replySnapshot(replyContext);
      const digest = fingerprint(threadId, text, hostExecutionInput ? { executionInput: hostExecutionInput } : context);
      let duplicate = false;
      await updateState(state => {
        const previous = (state.requests || []).find(row => row.requestId === requestId);
        if (previous) {
          if (previous.threadId !== threadId || (previous.fingerprint && previous.fingerprint !== digest)) throw new Error('请求标识已用于不同话题或内容');
          duplicate = true;
          return {};
        }
        const message = createUserMessage({ content: [{ type: 'text', text }], source: hostExecutionInput
          ? { kind: 'benchgo-execution-input', ...hostExecutionInput }
          : { kind: 'user', requestId, rpcId: requestId,
          ...(context ? { replyContext: context } : {}) } });
        const row = { requestId, threadId, sessionId: getAgent?.(threadId)?.id ?? null, messageId: message.id, message,
          ...(hostExecutionInput ? { executionInput: hostExecutionInput } : {}), fingerprint: digest, status: 'queued', createdAt: new Date(now()).toISOString() };
        return { requests: [...(state.requests || []), row] };
      });
      await drain(threadId);
      const row = (await getState()).requests.find(item => item.requestId === requestId);
      onChange({ type: 'inbox', threadId, requestId, status: row.status });
      return { ...receipt(row), ...(duplicate ? { duplicate: true } : {}) };
    },
    drain,
    async settle(threadId) { await drains.get(threadId); await drain(threadId); },
    async recover() {
      const threads = [...new Set(((await getState()).requests || []).filter(row => active.has(row.status) || ['uncertain', 'sent'].includes(row.status)).map(row => row.threadId))];
      await Promise.all(threads.map(drain));
    },
    async cancel(threadId) {
      await updateState(state => ({ requests: (state.requests || []).map(row => row.threadId === threadId && active.has(row.status)
        ? { ...row, status: 'cancelled', updatedAt: new Date(now()).toISOString() } : row) }));
    },
    async hasPending(threadId) { return ((await getState()).requests || []).some(row => row.threadId === threadId && active.has(row.status)); },
    async state(threadId) {
      return ((await getState()).requests || []).filter(row => row.threadId === threadId && !row.taskReply && !row.executionInput).map(row => ({ ...receipt(row), createdAt: row.createdAt, updatedAt: row.updatedAt,
        ...(row.questionReply ? { questionReply: row.questionReply, text: row.questionReply.text }
          : row.message ? { text: row.message.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? '' } : {}) }));
    },
    async dispose() { await Promise.allSettled([...drains.values()]); },
  };
}
