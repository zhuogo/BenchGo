import { isChatUserMessage, readAdmittedQuestionReply } from '../src/question-reply.mjs';

const replyText = call => {
  const args = call.args;
  if (!args || args.invalid || args.keys().some(key => key !== 'text')) return null;
  const text = args.text('text');
  return typeof text === 'string' && text.trim() && text.length <= 16000 ? text : null;
};

// History can be one request behind the official live view. Only a host-admitted
// user node tied to a persisted message/receipt may bridge that refresh window.
function activeIdentity(history, rows, turn, users, boundary) {
  if (!Number.isSafeInteger(turn) || (!boundary && rows.turnEnds?.has(turn))) return null;
  const active = history.activeReply;
  if (active && !boundary) return active.turn === turn && users.has(active.requestId) ? active : null;
  if (active && active.turn !== turn) return null;
  const node = [...(rows.nodes || [])].reverse().find(item => ['user', 'steering'].includes(item.kind)
    && (!boundary || item.seq > boundary.start.seq && item.seq < (boundary.end?.seq ?? Infinity)));
  if (!isChatUserMessage(node) || !Number.isFinite(node.seq)) return null;
  const priorEnd = Math.max(-1, ...[...(rows.turnEnds || [])].filter(([ended]) => ended < turn).map(([, seq]) => seq));
  if (node.seq <= priorEnd) return null;
  const question = readAdmittedQuestionReply(node);
  if (node.source.kind === 'user-question-reply' && !question) return null;
  const rpcId = node.source.rpcId || node.source.requestId;
  const user = [...users.values()].find(item => (node.messageId && item.id === node.messageId) || item.seq === node.seq || (rpcId && item.rpcId === rpcId) || (question && item.callId === question.callId));
  if (user) return !active || active.requestId === user.id ? { turn, requestId: user.id } : null;
  const receipt = (history.requests || []).find(item => ((rpcId && item.requestId === rpcId) || (question && item.questionReply?.callId === question.callId))
    && item.sessionId === history.sessionId && typeof item.messageId === 'string'
    && ['processing', 'prepared'].includes(item.status));
  return receipt && (!active || active.requestId === receipt.messageId) ? { turn, requestId: receipt.messageId } : null;
}

// The host replaces partial with a durable assistant node before history refreshes.
// Read that same node and its real turn boundary instead of caching a second reply.
function settledReply(history, chat, users, published, running, make) {
  const turn = chat.timeline?.turns.get(chat.timeline.turnOrder.at(-1));
  if (!turn?.start || (turn.end ? turn.end.data?.reason?.kind !== 'completed' : !running)) return null;
  const rows = chat.legacy;
  const node = [...(rows.nodes || [])].reverse().find(item => item.kind === 'assistant' && item.turn === turn.turn);
  if (!node?.messageId || node.interrupted || node.parentCallId || node.seq <= turn.start.seq
    || node.seq >= (turn.end?.seq ?? Infinity) || node.blocks?.some(block => block.kind === 'tool-call')) return null;
  const active = activeIdentity(history, rows, turn.turn, users, turn);
  if (!active || published.has(active.requestId)) return null;
  const text = (node.blocks || []).filter(block => block.kind === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
  return text.trim() ? make(active.requestId, text, !turn.end, turn.end?.time || node.time) : null;
}

/** Router text is public conversation; reasoning and tool payloads stay private. */
export function projectReplyStream({ history = {}, chat, sessionId, running = false } = {}) {
  if (!sessionId || sessionId !== history.sessionId || !chat?.legacy) return null;
  const messages = history.messages || [];
  const rows = chat.legacy;
  const published = new Set(messages.filter(row => row.role === 'assistant' && row.kind === 'final').map(row => row.requestId));
  const users = new Map(messages.filter(row => row.role === 'user').map(row => [row.id, row]));
  const make = (requestId, text, streaming, time) => ({
    id: `reply:${requestId}`, key: `message:reply:${requestId}`, requestId,
    role: 'assistant', kind: 'final', text, content: [{ type: 'text', text }], streaming, time,
  });
  // Executed publication is authoritative, even when history is one refresh behind.
  for (const call of [...(rows.nodes || [])].reverse()) {
    if (call.kind !== 'tool-result' || call.name !== 'assistant_reply' || call.parentCallId || call.isError) continue;
    let result;
    try { result = JSON.parse((call.content || []).filter(block => block.type === 'text').map(block => block.text).join('')); }
    catch { continue; }
    if (result?.published !== true || !users.has(result.requestId) || published.has(result.requestId)) continue;
    const text = replyText(call);
    if (text) return make(result.requestId, text.trim(), false, call.time);
  }
  if (!running) return settledReply(history, chat, users, published, running, make);
  // Explicit publication takes precedence when the model chooses it. Streaming
  // ordinary public text must not depend on that optional model tool choice.
  for (const call of [...(rows.runningCalls || [])].reverse()) {
    if (call.name !== 'assistant_reply' || call.parentCallId) continue;
    const active = activeIdentity(history, rows, call.turn, users), text = replyText(call);
    if (active && !published.has(active.requestId) && text) return make(active.requestId, text, true, call.time || users.get(active.requestId)?.time);
  }
  const partial = rows.partial;
  if (!partial || partial.parentCallId) return settledReply(history, chat, users, published, running, make);
  const active = activeIdentity(history, rows, partial.turn, users);
  if (!active || published.has(active.requestId)) return null;
  const text = (partial.blocks || []).filter(block => block.kind === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
  return text.trim() ? make(active.requestId, text, true, users.get(active.requestId)?.time) : null;
}
