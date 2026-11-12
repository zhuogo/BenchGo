import { isChatUserMessage, readAdmittedQuestionReply } from '../src/question-reply.mjs';

/** Display only facts in the official projection; never inspect private tool arguments. */
export function conversationActivity(session = {}, chat, pendingInteraction) {
  if (session.openState === 'error') return { kind: 'error', label: '会话连接失败' };
  if (session.openState === 'loading') return { kind: 'connecting', label: '正在连接', subtle: true };
  if (pendingInteraction) return { kind: 'waiting', label: pendingInteraction.kind === 'question' ? '等待你的回答' : '等待你的确认' };
  if (!session.running) return session.pendingSubmissions?.length ? { kind: 'waiting', label: '等待会话接收' } : null;
  const rows = chat?.legacy;
  const call = rows?.runningCalls?.findLast(item => !item.parentCallId);
  if (call) {
    const kind = ['assistant_session_search', 'assistant_memory_search'].includes(call.name) ? 'search'
      : ['read_assessment_source', 'assistant_ledger_read', 'assistant_capabilities', 'assistant_models', 'assistant_device_status'].includes(call.name) ? 'read' : 'tool';
    return { kind: kind === 'search' ? 'search' : 'work', label: kind === 'search' ? '搜索中' : '工作中' };
  }
  const retry = rows?.nodes?.at(-1);
  if (retry?.kind === 'model-retry' && retry.retryState === 'scheduled') return { kind: 'waiting', label: '模型请求失败，等待重试' };
  const blocks = rows?.partial?.blocks || [];
  if (blocks.some(block => block.kind === 'text')) return { kind: 'reply', label: '正在回复', subtle: true };
  return { kind: 'waiting', label: '正在处理', subtle: true };
}

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
function ordinaryReply(history, chat, users, published, running, make, publication) {
  const rows = chat.legacy;
  const turn = chat.timeline?.turns.get(chat.timeline.turnOrder.at(-1));
  if (chat.timeline && !turn?.start) return [];
  if (turn?.end ? turn.end.data?.reason?.kind !== 'completed' && !publication : !running && !publication) return [];
  const active = activeIdentity(history, rows, turn?.turn ?? rows.partial?.turn, users, turn);
  if (!active || published.has(active.requestId)) return [];
  const nodes = (rows.nodes || []).filter(node => node.kind === 'assistant' && node.turn === active.turn
    && node.messageId && !node.interrupted && !node.parentCallId && Number.isFinite(node.seq)
    && node.seq > (active.seq ?? turn?.start?.seq ?? Infinity) && node.seq < (turn?.end?.seq ?? Infinity)
    && (!publication || Number.isSafeInteger(publication.step) && node.step < publication.step));
  const parts = nodes.map(node => make(active.requestId, publicText(node.blocks), !turn?.end && !publication, node.time,
    `:${active.turn}:${node.step ?? node.messageId}`)).filter(row => row.text.trim());
  const partial = rows.partial;
  const step = turn?.steps?.at(-1);
  if (!publication && running && !turn?.end && partial?.turn === active.turn && !partial.parentCallId
    && (!step || partial.step === step.step && !step.end)
    // A delayed partial must not duplicate or revive an already settled step.
    && !nodes.some(node => Number.isSafeInteger(partial.step) && node.step >= partial.step)) {
    const text = publicText(partial.blocks);
    if (text.trim()) parts.push(make(active.requestId, text, true, users.get(active.requestId)?.time, `:${active.turn}:${partial.step ?? 0}`));
  }
  return parts;
}

/** Router text is public conversation; reasoning and tool payloads stay private. */
export function projectReplyRows({ history = {}, chat, sessionId, running = false } = {}) {
  if (!sessionId || sessionId !== history.sessionId || !chat?.legacy) return [];
  const messages = history.messages || [];
  const rows = chat.legacy;
  const published = new Set(messages.filter(row => row.role === 'assistant' && row.kind === 'final' && !row.segment).map(row => row.requestId));
  const users = new Map(messages.filter(row => row.role === 'user').map(row => [row.id, row]));
  const make = (requestId, text, streaming, time, segment = '') => ({
    id: `reply:${requestId}${segment}`, key: `message:reply:${requestId}${segment}`, requestId, ...(segment ? { segment: true } : {}),
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
    if (text) return [...ordinaryReply(history, chat, users, new Set(), running, make, call), make(result.requestId, text.trim(), false, call.time)]
      .filter(row => !messages.some(message => message.id === row.id));
  }
  if (!running) return ordinaryReply(history, chat, users, published, running, make).filter(row => !messages.some(message => message.id === row.id));
  // Explicit publication takes precedence when the model chooses it. Streaming
  // ordinary public text must not depend on that optional model tool choice.
  for (const call of [...(rows.runningCalls || [])].reverse()) {
    if (call.name !== 'assistant_reply' || call.parentCallId) continue;
    const turn = chat.timeline?.turns.get(chat.timeline.turnOrder.at(-1));
    if (turn && (turn.turn !== call.turn || turn.end)) continue;
    const step = turn?.steps?.at(-1);
    if (step && (call.step !== step.step || step.end)) continue;
    const active = activeIdentity(history, rows, call.turn, users, turn), text = replyText(call);
    if (active && !published.has(active.requestId) && text) return [...ordinaryReply(history, chat, users, published, running, make, call), make(active.requestId, text, true, call.time || users.get(active.requestId)?.time)]
      .filter(row => !messages.some(message => message.id === row.id));
  }
  return ordinaryReply(history, chat, users, published, running, make).filter(row => !messages.some(message => message.id === row.id));
}

/** Single-message consumers can still inspect the current reply. */
export function projectReplyStream(options) { return projectReplyRows(options).at(-1) || null; }
