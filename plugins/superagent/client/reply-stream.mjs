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
  if (active && !boundary) return active.turn === turn && users.has(active.requestId)
    ? { ...active, seq: users.get(active.requestId).seq } : null;
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
  if (user) return !active || active.requestId === user.id ? { turn, requestId: user.id, seq: node.seq } : null;
  const receipt = (history.requests || []).find(item => ((rpcId && item.requestId === rpcId) || (question && item.questionReply?.callId === question.callId))
    && item.sessionId === history.sessionId && typeof item.messageId === 'string'
    && ['processing', 'prepared'].includes(item.status));
  return receipt && (!active || active.requestId === receipt.messageId) ? { turn, requestId: receipt.messageId, seq: node.seq } : null;
}

const publicText = blocks => (blocks || []).filter(block => block.kind === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');

// Each official step settles independently. Derive the whole request from those
// nodes plus its current step, never from a second cache of streamed reply text.
function ordinaryReply(history, chat, users, published, running, make) {
  const rows = chat.legacy;
  const turn = chat.timeline?.turns.get(chat.timeline.turnOrder.at(-1));
  if (chat.timeline && !turn?.start) return null;
  if (turn?.end ? turn.end.data?.reason?.kind !== 'completed' : !running) return null;
  const active = activeIdentity(history, rows, turn?.turn ?? rows.partial?.turn, users, turn);
  if (!active || published.has(active.requestId)) return null;
  const nodes = (rows.nodes || []).filter(node => node.kind === 'assistant' && node.turn === active.turn
    && node.messageId && !node.interrupted && !node.parentCallId && Number.isFinite(node.seq)
    && node.seq > (active.seq ?? turn?.start?.seq ?? Infinity) && node.seq < (turn?.end?.seq ?? Infinity));
  const parts = nodes.map(node => publicText(node.blocks)).filter(text => text.trim());
  const partial = rows.partial;
  const step = turn?.steps?.at(-1);
  if (running && !turn?.end && partial?.turn === active.turn && !partial.parentCallId
    && (!step || partial.step === step.step && !step.end)
    // A delayed partial must not duplicate or revive an already settled step.
    && !nodes.some(node => Number.isSafeInteger(partial.step) && node.step >= partial.step)) {
    const text = publicText(partial.blocks);
    if (text.trim()) parts.push(text);
  }
  const text = parts.join('\n\n');
  return text.trim() ? make(active.requestId, text, !turn?.end, turn?.end?.time || users.get(active.requestId)?.time) : null;
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
    role: 'assistant', kind: 'final', text, content: [{ type: 'text', text }], streaming, time: time ?? users.get(requestId)?.time,
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
  if (!running) return ordinaryReply(history, chat, users, published, running, make);
  // Explicit publication takes precedence when the model chooses it. Streaming
  // ordinary public text must not depend on that optional model tool choice.
  for (const call of [...(rows.runningCalls || [])].reverse()) {
    if (call.name !== 'assistant_reply' || call.parentCallId) continue;
    const turn = chat.timeline?.turns.get(chat.timeline.turnOrder.at(-1));
    if (turn && (turn.turn !== call.turn || turn.end)) continue;
    const step = turn?.steps?.at(-1);
    if (step && (call.step !== step.step || step.end)) continue;
    const active = activeIdentity(history, rows, call.turn, users, turn), text = replyText(call);
    if (active && !published.has(active.requestId) && text) return make(active.requestId, text, true, call.time || users.get(active.requestId)?.time);
  }
  return ordinaryReply(history, chat, users, published, running, make);
}
