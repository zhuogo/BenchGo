import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import { fallbackRequestIds, readModelFallbacks } from './model-fallback.mjs';
import { questionBatch, questionAnswers, questionReplyText, readQuestionReply } from './question-reply.mjs';
import { ticketStateSource } from './ticket-state-report.mjs';
import { ticketReplySource } from './ticket-reply.mjs';

export const chatPublicationType = 'plugin:benchgo-plugin/chat-publication';
export const executionInputSource = 'benchgo-execution-input';
const fail = message => Object.assign(new Error(message), { code: 'CHAT_PUBLICATION_REJECTED' });
const userEvent = (event, events) => event.type === 'user/message' && (event.data?.source?.kind === 'user' || readQuestionReply(event.data, events));
const internalReply = request => request?.source?.kind === ticketReplySource;
const legacyReply = request => request?.source?.kind === ticketStateSource;
const executionReply = request => request?.source?.kind === executionInputSource;
const replyEvent = (event, events) => userEvent(event, events) || event.type === 'user/message' && [ticketStateSource, ticketReplySource, executionInputSource].includes(event.data?.source?.kind);
// Resolve internal and retired notices to their original identity so neither
// can accidentally become a reply to the preceding human message.
const replyContinuations = events => {
  const result = fallbackRequestIds(events);
  const states = new Set(events.filter(event => event.type === 'user/message' && (legacyReply(event.data) || internalReply(event.data) || executionReply(event.data))).map(event => event.data.id));
  for (const plan of readModelFallbacks(events).values()) {
    if (!plan.cancelled && states.has(plan.requestId)
      && events.some(event => event.type === 'user/message' && event.data?.id === plan.message.id
        && event.data.source?.fallbackId === plan.id)) result.set(plan.message.id, plan.requestId);
  }
  return result;
};
const textBlocks = content => (content || []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => ({ type: 'text', text: block.text }));
const publicUsage = value => {
  const entries = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
    .filter(key => Number.isFinite(value?.[key]) && value[key] >= 0).map(key => [key, value[key]]);
  return entries.length ? Object.fromEntries(entries) : undefined;
};

/** Identity only: raw execution content is never returned as a reply draft. */
export function activeChatReply(events, { includeInternal = false } = {}) {
  const continuations = replyContinuations(events);
  let turn, requestId;
  for (const event of events) {
    if (event.type === 'turn/start') { turn = event.data?.turn; requestId = undefined; }
    else if (turn !== undefined && replyEvent(event, events)) requestId = event.data.id;
    else if (turn !== undefined && event.type === 'user/message' && continuations.has(event.data?.id)) requestId = continuations.get(event.data.id);
    else if (event.type === 'turn/end' && event.data?.turn === turn) { turn = undefined; requestId = undefined; }
  }
  const request = events.find(event => event.type === 'user/message' && event.data?.id === requestId)?.data;
  return turn !== undefined && requestId && (includeInternal || !internalReply(request) && !legacyReply(request)) ? { turn, requestId } : null;
}

/** A projection, never a replacement for the private execution transcript. */
export function projectChatMessages(events) {
  const continuations = replyContinuations(events);
  const requests = new Map(events.filter(event => replyEvent(event, events)).map(event => [event.data.id, event.data]));
  const users = new Set(), published = new Set(), rows = [];
  const explicit = new Set();
  for (const event of events) {
    if (replyEvent(event, events)) users.add(event.data.id);
    else if (event.type === chatPublicationType && event.ignorable === true && event.data?.kind === 'final'
      && users.has(event.data.requestId) && !legacyReply(requests.get(event.data.requestId)) && !internalReply(requests.get(event.data.requestId))
      && typeof event.data.text === 'string' && event.data.text.trim() && event.data.text.length <= 16000) explicit.add(event.data.requestId);
  }
  users.clear();
  let turn, request, lastAssistant;
  const asked = new Map(), answered = new Set();
  for (const event of events) {
    if (event.type === 'turn/start') { turn = event.data?.turn; request = undefined; lastAssistant = undefined; }
    if (replyEvent(event, events)) {
      users.add(event.data.id);
      request = event.data;
      if (legacyReply(request) || internalReply(request) || executionReply(request)) continue;
      const question = readQuestionReply(event.data, events);
      if (question) {
        const row = { seq: event.seq, id: event.data.id, role: 'user', kind: 'question-reply', ...question,
          content: [{ type: 'text', text: question.text }], time: event.time };
        const earlier = rows.findIndex(item => item.kind === 'question-reply' && item.callId === question.callId);
        if (earlier >= 0) rows[earlier] = row;
        else rows.push(row);
        answered.add(question.callId);
      } else {
        const content = (event.data.content || []).filter(block => ['text', 'image', 'file'].includes(block?.type));
        rows.push({ seq: event.seq, id: event.data.id, role: 'user', ...(typeof event.data.source.rpcId === 'string' ? { rpcId: event.data.source.rpcId } : {}), text: textBlocks(content).map(block => block.text).join('\n'), content, time: event.time });
      }
    } else if (event.type === 'user/message' && continuations.has(event.data?.id)) {
      request = requests.get(continuations.get(event.data.id));
    } else if (event.type === chatPublicationType && event.ignorable === true) {
      const row = event.data;
      if (row?.kind !== 'final' || !users.has(row.requestId) || published.has(row.requestId) || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 16000) continue;
      if (internalReply(requests.get(row.requestId)) || legacyReply(requests.get(row.requestId))) continue;
      published.add(row.requestId);
      const usage = request?.id === row.requestId ? publicUsage(lastAssistant?.data?.usage) : undefined;
      rows.push({ seq: event.seq, id: `reply:${row.requestId}`, role: 'assistant', kind: 'final', requestId: row.requestId, text: row.text, content: [{ type: 'text', text: row.text }], time: event.time, ...(usage ? { usage } : {}) });
    } else if (event.type === 'tool/call' && event.data?.name === 'ask_user_question' && !event.data.parentCallId) {
      const questions = questionBatch(event.data.arguments);
      if (questions) asked.set(String(event.data.callId), questions);
    } else if (event.type === 'tool/result' && asked.has(String(event.data?.message?.toolCallId ?? event.data?.message?.source?.callId))) {
      const callId = String(event.data.message.toolCallId ?? event.data.message.source?.callId), questions = asked.get(callId);
      const answers = !event.data.error && questionAnswers(questions, event.data.message);
      if (answers && !answered.has(callId)) rows.push({ seq: event.seq, id: `question:${callId}`, role: 'user', kind: 'question-reply', callId, questions, answers,
        text: questionReplyText(questions, answers), content: [{ type: 'text', text: questionReplyText(questions, answers) }], time: event.time });
      if (answers) answered.add(callId);
    } else if (event.type === 'assistant/message' && turn !== undefined && event.data?.turn === turn) {
      lastAssistant = event;
    } else if (event.type === 'turn/end') {
      const message = lastAssistant?.data?.message;
      if (turn !== undefined && event.data?.turn === turn && event.data?.reason?.kind === 'completed'
        && request?.id && !internalReply(request) && !legacyReply(request) && !executionReply(request) && !explicit.has(request.id) && !published.has(request.id)
        && message?.source?.kind === 'model' && !message.content?.some(block => block.type === 'tool-call')) {
        const text = textBlocks(message.content).map(block => block.text).join('\n');
        if (text.trim()) {
          published.add(request.id);
          rows.push({ seq: event.seq, id: `reply:${request.id}`, role: 'assistant', kind: 'final', requestId: request.id,
            text, content: [{ type: 'text', text }], time: event.time, ...(publicUsage(lastAssistant.data.usage) ? { usage: publicUsage(lastAssistant.data.usage) } : {}) });
        }
      }
      turn = undefined; request = undefined; lastAssistant = undefined;
    }
  }
  return rows;
}

/** Only the owner Router can publish; Worker/tool output has no publication authority. */
export function installChatPublication(scope, agent, { onPublish, canPublish, appendRecord = appendPluginRecord } = {}) {
  const permitted = request => !legacyReply(request) && (!(internalReply(request) || executionReply(request)) || (canPublish ? canPublish(request) : false));
  scope.on?.('agent/turn-stopping', async ({ agent: subject, turn, signal }) => {
    if (subject !== agent) return;
    const events = agent.session.snapshotEvents(), active = activeChatReply(events, { includeInternal: true });
    const request = events.find(event => event.type === 'user/message' && event.data?.id === active?.requestId)?.data;
    if (executionReply(request)) {
      if (active.turn !== turn || events.some(event => event.type === chatPublicationType && event.data?.kind === 'final' && event.data.requestId === request.id)) return;
      const last = events.findLast(event => event.type === 'assistant/message' && event.data?.turn === turn)?.data?.message;
      if (last?.source?.kind !== 'model' || last.content?.some(block => block.type === 'tool-call')) return;
      const text = textBlocks(last.content).map(block => block.text).join('\n');
      if (!text.trim() || text.length > 16000 || !await permitted(request)) return;
      signal?.throwIfAborted();
      appendRecord(agent.session, chatPublicationType, { kind: 'final', requestId: request.id, text });
      onPublish?.({ requestId: request.id });
      return;
    }
    if (internalReply(request)) {
      if (active.turn !== turn || events.some(event => event.type === chatPublicationType && event.data?.kind === 'ticket-reply' && event.data.requestId === request.id)) return;
      const last = events.findLast(event => event.type === 'assistant/message' && event.data?.turn === turn)?.data?.message;
      if (last?.source?.kind !== 'model' || last.content?.some(block => block.type === 'tool-call')) return;
      const text = textBlocks(last.content).map(block => block.text).join('\n');
      if (!text.trim() || text.length > 16000 || !await permitted(request)) return;
      signal?.throwIfAborted();
      appendRecord(agent.session, chatPublicationType, { kind: 'ticket-reply', requestId: request.id,
        ticketReplyEventKey: request.source.eventKey, text });
      return;
    }
  });
  scope.tools.register({
    name: 'assistant_reply',
    description: 'Publish your natural conversational reply and end this turn. Choose the wording and detail yourself. In a host internal Ticket reply turn, save the draft for host delivery instead. Only an internal state notice may use suppress=true when no interruption is needed. This grants no approval or action authority.',
    parameters: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 16000 }, suppress: { type: 'boolean' } }, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute({ text, suppress = false }, execution) {
      execution.signal?.throwIfAborted();
      if (execution.agent !== agent) throw fail('正式回复身份无效');
      const events = agent.session.snapshotEvents();
      const active = activeChatReply(events, { includeInternal: true });
      const request = events.findLast(event => replyEvent(event, events) && (!active || event.data.id === active.requestId))?.data;
      if (!request?.id) throw fail('没有可回复的用户请求');
      if (legacyReply(request)) throw fail('旧工单状态发布路径已停用');
      const internal = internalReply(request), kind = internal ? 'ticket-reply' : 'final';
      if (suppress && (!internal || request.source.replyKind !== 'state' || text !== undefined)) throw fail('仅内部状态通知可选择静默');
      if (!suppress && (typeof text !== 'string' || !text.trim() || text.length > 16000)) throw fail('正式回复正文无效');
      const existing = events.find(event => event.type === chatPublicationType && event.data?.kind === kind && event.data.requestId === request.id);
      if (existing) {
        if (existing.data.text !== text || !!existing.data.suppressed !== suppress) throw fail('本次请求已发布正式回复；不能重复或改写已发送内容');
        execution.concludeTurn();
        return { published: true, duplicate: true, requestId: request.id };
      }
      const publish = allowed => {
        execution.signal?.throwIfAborted();
        if (!allowed) throw fail('工单状态或授权已变化，本次状态说明不再发布');
        appendRecord(agent.session, chatPublicationType, { kind, requestId: request.id, ...(suppress ? { suppressed: true } : { text }),
          ...(internal ? { ticketReplyEventKey: request.source.eventKey } : {}) });
        execution.concludeTurn();
        onPublish?.({ requestId: request.id });
        return { published: true, requestId: request.id };
      };
      const allowed = permitted(request);
      return allowed?.then ? allowed.then(publish) : publish(allowed);
    },
  });
}
