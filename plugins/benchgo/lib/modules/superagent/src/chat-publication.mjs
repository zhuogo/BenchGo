import { appendPluginRecord } from '@deepseek-ai/dsh-session';

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
  let turn, requestId;
  for (const event of events) {
    if (event.type === 'turn/start') { turn = event.data?.turn; requestId = undefined; }
    else if (turn !== undefined && userEvent(event)) requestId = event.data.id;
    else if (event.type === 'turn/end' && event.data?.turn === turn) { turn = undefined; requestId = undefined; }
  }
  return turn !== undefined && requestId ? { turn, requestId } : null;
}

/** A projection, never a replacement for the private execution transcript. */
export function projectChatMessages(events) {
  const users = new Set(), published = new Set(), rows = [];
  const explicit = new Set();
  for (const event of events) {
    if (userEvent(event)) users.add(event.data.id);
    else if (event.type === chatPublicationType && event.ignorable === true && event.data?.kind === 'final'
      && users.has(event.data.requestId) && typeof event.data.text === 'string' && event.data.text.trim() && event.data.text.length <= 16000) explicit.add(event.data.requestId);
  }
  users.clear();
  let turn, request, lastAssistant;
  for (const event of events) {
    if (event.type === 'turn/start') { turn = event.data?.turn; request = undefined; lastAssistant = undefined; }
    if (userEvent(event)) {
      users.add(event.data.id);
      request = event.data;
      const content = (event.data.content || []).filter(block => ['text', 'image', 'file'].includes(block?.type));
      rows.push({ seq: event.seq, id: event.data.id, role: 'user', ...(typeof event.data.source.rpcId === 'string' ? { rpcId: event.data.source.rpcId } : {}), text: textBlocks(content).map(block => block.text).join('\n'), content, time: event.time });
    } else if (event.type === chatPublicationType && event.ignorable === true) {
      const row = event.data;
      if (row?.kind !== 'final' || !users.has(row.requestId) || published.has(row.requestId) || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 16000) continue;
      published.add(row.requestId);
      const usage = request?.id === row.requestId ? publicUsage(lastAssistant?.data?.usage) : undefined;
      rows.push({ seq: event.seq, id: `reply:${row.requestId}`, role: 'assistant', kind: 'final', requestId: row.requestId, text: row.text, content: [{ type: 'text', text: row.text }], time: event.time, ...(usage ? { usage } : {}) });
    } else if (event.type === 'assistant/message' && turn !== undefined && event.data?.turn === turn) {
      lastAssistant = event;
    } else if (event.type === 'turn/end') {
      const message = lastAssistant?.data?.message;
      if (turn !== undefined && event.data?.turn === turn && event.data?.reason?.kind === 'completed'
        && request?.id && !explicit.has(request.id) && !published.has(request.id)
        && message?.source?.kind === 'model' && !message.content?.some(block => block.type === 'tool-call')) {
        const text = textBlocks(message.content).map(block => block.text).join('\n').trim();
        if (text) {
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
        if (existing.data.text !== text.trim()) throw fail('本次请求已发布正式回复；不能重复或改写已发送内容');
        execution.concludeTurn();
        return { published: true, duplicate: true, requestId: request.id };
      }
      appendRecord(agent.session, chatPublicationType, { kind: 'final', requestId: request.id, text: text.trim() });
      execution.concludeTurn();
      onPublish?.({ requestId: request.id });
      return { published: true, requestId: request.id };
    },
  });
}
