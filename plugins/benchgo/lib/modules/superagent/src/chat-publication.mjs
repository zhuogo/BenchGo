import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import { fallbackRequestIds } from './model-fallback.mjs';

export const chatPublicationType = 'plugin:benchgo-plugin/chat-publication';
const fail = message => Object.assign(new Error(message), { code: 'CHAT_PUBLICATION_REJECTED' });
const userEvent = event => event.type === 'user/message' && event.data?.source?.kind === 'user';
const textBlocks = content => (content || []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => ({ type: 'text', text: block.text }));
const publicUsage = value => {
  const entries = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
    .filter(key => Number.isFinite(value?.[key]) && value[key] >= 0).map(key => [key, value[key]]);
  return entries.length ? Object.fromEntries(entries) : undefined;
};

/** Identity only: raw execution content is never returned as a reply draft. */
export function activeChatReply(events) {
  const continuations = fallbackRequestIds(events);
  let turn, requestId;
  for (const event of events) {
    if (event.type === 'turn/start') { turn = event.data?.turn; requestId = undefined; }
    else if (turn !== undefined && userEvent(event)) requestId = event.data.id;
    else if (turn !== undefined && event.type === 'user/message' && continuations.has(event.data?.id)) requestId = continuations.get(event.data.id);
    else if (event.type === 'turn/end' && event.data?.turn === turn) { turn = undefined; requestId = undefined; }
  }
  return turn !== undefined && requestId ? { turn, requestId } : null;
}

const record = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const parseJson = text => { try { const value = JSON.parse(text); return record(value) ? value : null; } catch { return null; } };
// Same acceptance rules as the official answered-question node: only a settled
// official answer whose ids match the asked questions becomes a visible bubble.
function questionsOf(argumentsText) {
  const value = parseJson(argumentsText), ids = new Set();
  if (!Array.isArray(value?.questions) || !value.questions.length) return null;
  const questions = [];
  for (const row of value.questions) {
    if (!record(row) || typeof row.id !== 'string' || typeof row.question !== 'string' || ids.has(row.id)) return null;
    ids.add(row.id);
    questions.push({ id: row.id, question: row.question, ...(typeof row.header === 'string' && row.header.trim() ? { header: row.header } : {}) });
  }
  return questions;
}
function answersOf(questions, message) {
  const content = message?.content || [];
  if (message?.isError === true || content.length !== 1 || content[0]?.type !== 'text') return null;
  const value = parseJson(content[0].text);
  if (!value || value.pending === true || !Array.isArray(value.answers) || value.answers.length !== questions.length) return null;
  const ids = new Set(questions.map(row => row.id)), answers = [];
  for (const row of value.answers) {
    if (!record(row) || typeof row.id !== 'string' || !ids.delete(row.id) || !Array.isArray(row.selected)
      || !row.selected.every(item => typeof item === 'string') || (row.custom !== undefined && typeof row.custom !== 'string')) return null;
    answers.push({ id: row.id, selected: row.selected, ...(row.custom?.trim() ? { custom: row.custom } : {}) });
  }
  return answers;
}
const answerText = (questions, answers) => questions.map(row => {
  const answer = answers.find(item => item.id === row.id), values = [...(answer?.selected || []), ...(answer?.custom ? [answer.custom] : [])];
  return `${row.header || row.question}：${values.length ? values.join('、') : '已跳过'}`;
}).join('\n');

/** A projection, never a replacement for the private execution transcript. */
export function projectChatMessages(events) {
  const continuations = fallbackRequestIds(events);
  const requests = new Map(events.filter(userEvent).map(event => [event.data.id, event.data]));
  const users = new Set(), published = new Set(), rows = [];
  const explicit = new Set();
  for (const event of events) {
    if (userEvent(event)) users.add(event.data.id);
    else if (event.type === chatPublicationType && event.ignorable === true && event.data?.kind === 'final'
      && users.has(event.data.requestId) && typeof event.data.text === 'string' && event.data.text.trim() && event.data.text.length <= 16000) explicit.add(event.data.requestId);
  }
  users.clear();
  let turn, request, lastAssistant;
  const asked = new Map();
  for (const event of events) {
    if (event.type === 'turn/start') { turn = event.data?.turn; request = undefined; lastAssistant = undefined; }
    if (userEvent(event)) {
      users.add(event.data.id);
      request = event.data;
      const content = (event.data.content || []).filter(block => ['text', 'image', 'file'].includes(block?.type));
      rows.push({ seq: event.seq, id: event.data.id, role: 'user', ...(typeof event.data.source.rpcId === 'string' ? { rpcId: event.data.source.rpcId } : {}), text: textBlocks(content).map(block => block.text).join('\n'), content, time: event.time });
    } else if (event.type === 'user/message' && continuations.has(event.data?.id)) {
      request = requests.get(continuations.get(event.data.id));
    } else if (event.type === chatPublicationType && event.ignorable === true) {
      const row = event.data;
      if (row?.kind !== 'final' || !users.has(row.requestId) || published.has(row.requestId) || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 16000) continue;
      published.add(row.requestId);
      const usage = request?.id === row.requestId ? publicUsage(lastAssistant?.data?.usage) : undefined;
      rows.push({ seq: event.seq, id: `reply:${row.requestId}`, role: 'assistant', kind: 'final', requestId: row.requestId, text: row.text, content: [{ type: 'text', text: row.text }], time: event.time, ...(usage ? { usage } : {}) });
    } else if (event.type === 'tool/call' && event.data?.name === 'ask_user_question' && !event.data.parentCallId) {
      const questions = questionsOf(event.data.arguments);
      if (questions) asked.set(String(event.data.callId), questions);
    } else if (event.type === 'tool/result' && asked.has(String(event.data?.message?.source?.callId))) {
      const callId = String(event.data.message.source.callId), questions = asked.get(callId);
      asked.delete(callId);
      const answers = answersOf(questions, event.data.message);
      if (answers) rows.push({ seq: event.seq, id: `question:${callId}`, role: 'user', kind: 'question-reply', questions, answers,
        text: answerText(questions, answers), content: [{ type: 'text', text: answerText(questions, answers) }], time: event.time });
    } else if (event.type === 'assistant/message' && turn !== undefined && event.data?.turn === turn) {
      lastAssistant = event;
    } else if (event.type === 'turn/end') {
      const message = lastAssistant?.data?.message;
      if (turn !== undefined && event.data?.turn === turn && event.data?.reason?.kind === 'completed'
        && request?.id && !explicit.has(request.id) && !published.has(request.id)
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
export function installChatPublication(scope, agent, { onPublish, appendRecord = appendPluginRecord } = {}) {
  scope.tools.register({
    name: 'assistant_reply',
    description: 'Publish your conversational reply to the user and end the current turn. Use for chatting, answering, clarifying or responding naturally after successful delegation. Choose your own wording to fit the conversation. A normal completed text answer is also delivered automatically. Delegated task results are delivered separately after review. Do not repeat an already published reply. This does not grant approval or perform external actions.',
    parameters: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 16000 } }, required: ['text'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute({ text }, execution) {
      execution.signal?.throwIfAborted();
      if (execution.agent !== agent || typeof text !== 'string' || !text.trim() || text.length > 16000) throw fail('正式回复身份或正文无效');
      const events = agent.session.snapshotEvents();
      const request = events.findLast(userEvent)?.data;
      if (!request?.id) throw fail('没有可回复的用户请求');
      const existing = events.find(event => event.type === chatPublicationType && event.data?.requestId === request.id);
      if (existing) {
        if (existing.data.text !== text) throw fail('本次请求已发布正式回复；不能重复或改写已发送内容');
        execution.concludeTurn();
        return { published: true, duplicate: true, requestId: request.id };
      }
      appendRecord(agent.session, chatPublicationType, { kind: 'final', requestId: request.id, text });
      execution.concludeTurn();
      onPublish?.({ requestId: request.id });
      return { published: true, requestId: request.id };
    },
  });
}
