import { isChatUserMessage, readAdmittedQuestionReply } from '../src/question-reply.mjs';

const eventKey = row => row.ticketStateEventKey || row.eventKey || row.eventId || row.id;
// Display-only channel mirrors have explicit provenance; arbitrary context is private.
const channelMessage = row => row?.kind === 'channel-message' && row.source?.kind === 'benchgo-channel'
  && typeof row.mirrorKey === 'string' && !!row.mirrorKey && ['inbound', 'delivery'].includes(row.direction)
  && row.role === (row.direction === 'inbound' ? 'user' : 'assistant')
  && typeof row.source.channelSource?.channel === 'string' && !!row.source.channelSource.channel
  && typeof row.source.channelSource?.sourceType === 'string' && !!row.source.channelSource.sourceType
  && typeof row.text === 'string';
const publicText = row => typeof row.text === 'string' && !!row.text.trim();
const internalRequest = row => row.ticketReply || row.ticketState || row.executionInput
  || row.message?.source && !isChatUserMessage(row.message);
const messageTime = row => {
  const time = row.time == null ? NaN : new Date(row.time).getTime();
  return Number.isFinite(time) ? time : 0;
};
const compareRows = (a, b) => {
  // Pending input follows settled conversation and retains the official inbox
  // order. Its browser echo may disappear or use a different clock.
  if (a.submissionState || b.submissionState) return Number(!!a.submissionState) - Number(!!b.submissionState);
  return messageTime(a) - messageTime(b);
};
function conversationalNotification(row) {
  if (row.type === 'ticket.attention') return !!(row.attention || row.currentAttention)?.question?.question;
  if ([row.origin, row.publication?.origin].some(origin => ['system', 'worker'].includes(origin))) return false;
  if (row.type === 'schedule.lifecycle') return false;
  if (row.type === 'ticket.result') return (row.origin === 'router' || row.publication?.origin === 'router')
    && (!row.publication || ['deliver', 'ask'].includes(row.publication.action));
  if (row.type === 'ticket.accepted') return row.origin === 'router'
    && typeof row.ticketId === 'string' && !!row.ticketId
    && typeof row.requestId === 'string' && !!row.requestId && row.text.length <= 6000;
  return false;
}

/**
 * Sequence of the newest node that can change durable history: an admitted
 * input, a publication, a channel mirror or a turn-level notice. Settled steps
 * and ordinary tool results arrive many times per turn and are already rendered
 * from the live projection.
 */
export function historyReconcileSeq(chat) {
  const nodes = chat?.legacy?.nodes || [];
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    if (node.kind !== 'assistant' && (node.kind !== 'tool-result' || node.name === 'assistant_reply')) return node.seq;
  }
  return undefined;
}

/** Defence in depth: only the server publication projection can supply assistant rows. */
export function quietChatRows(history = {}, threadId = 'main', session = {}, chat, inbox) {
  const rows = (history.messages || []).filter(row => !row.streaming &&
    (channelMessage(row) || (row.kind !== 'channel-message' && ((row.role === 'user' && (!row.source || isChatUserMessage(row))) || (row.role === 'assistant' && row.kind === 'final'
      && ![row.origin, row.publication?.origin].some(origin => ['system', 'worker'].includes(origin)))))))
    .map(row => ({ ...row, key: `message:${row.id}` }));
  const historyEnd = Math.max(-1, ...rows.map(row => row.seq).filter(Number.isFinite));
  const mirrors = new Set(rows.filter(channelMessage).map(row => row.mirrorKey));
  const oldestLoaded = history.hasMore ? Math.min(Infinity, ...rows.map(row => row.seq).filter(Number.isFinite)) : -Infinity;
  for (const node of chat?.legacy?.nodes || []) {
    if (node.kind !== 'context' || node.form !== 'notice' || node.producer?.label !== 'benchgo-channel' || node.producer?.role !== 'inject'
      || node.source?.kind !== 'benchgo-channel' || node.seq < oldestLoaded) continue;
    const { mirrorKey, direction } = node.source;
    const text = (node.content || []).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
    const row = { id: `channel:${mirrorKey}`, kind: 'channel-message', role: direction === 'inbound' ? 'user' : 'assistant',
      mirrorKey, direction, source: node.source, text, content: [{ type: 'text', text }], seq: node.seq, time: node.time };
    if (!channelMessage(row) || mirrors.has(mirrorKey)) continue;
    mirrors.add(mirrorKey);
    rows.push({ ...row, key: `message:${row.id}` });
  }
  const publishedEvents = new Set(rows.filter(row => row.role === 'assistant' && publicText(row))
    .map(eventKey).filter(Boolean));
  // Use the host's synchronous submission echo, then its admitted user events.
  // Other assistant/tool/context nodes remain private in this unrestricted view.
  const seenSeq = new Set(rows.filter(row => row.role === 'user').map(row => row.seq).filter(Number.isFinite));
  const admittedRequests = new Set(rows.filter(row => row.role === 'user').map(row => row.requestId || row.rpcId || row.source?.requestId || row.source?.rpcId).filter(Boolean));
  const admittedMessages = new Set(rows.filter(row => row.role === 'user').map(row => row.id).filter(Boolean));
  const answeredCalls = new Set(rows.filter(row => row.kind === 'question-reply').map(row => row.callId).filter(Boolean));
  for (const node of chat?.legacy?.nodes || []) {
    if (!['user', 'steering'].includes(node.kind) || !isChatUserMessage(node)) continue;
    if (node.source.kind === 'user-question-reply') {
      const question = readAdmittedQuestionReply(node);
      if (!question || answeredCalls.has(question.callId) || seenSeq.has(node.seq) || node.seq <= historyEnd) continue;
      const receipt = (history.requests || []).find(row => row.questionReply?.callId === question.callId);
      const id = receipt?.messageId || `question:${question.callId}`;
      rows.push({ key: `message:${id}`, id, seq: node.seq, role: 'user', kind: 'question-reply', ...question,
        content: [{ type: 'text', text: question.text }], time: node.time, provisional: true });
      answeredCalls.add(question.callId);
      if (receipt) admittedRequests.add(receipt.requestId);
      continue;
    }
    const requestId = node.source.requestId || node.source.rpcId;
    const alreadyKnown = requestId && admittedRequests.has(requestId);
    if (requestId) admittedRequests.add(requestId);
    if (alreadyKnown || seenSeq.has(node.seq) || node.seq <= historyEnd) continue;
    seenSeq.add(node.seq);
    if (node.messageId) admittedMessages.add(node.messageId);
    const content = (node.content || []).filter(block => ['text', 'image', 'file'].includes(block.type));
    rows.push({ key: `live-user:${node.seq}`, role: 'user', seq: node.seq, rpcId: requestId, time: node.time,
      text: content.filter(block => block.type === 'text').map(block => block.text).join('\n'), content, provisional: true });
  }
  for (const [target, placement] of [['next-step', 'steering'], ['next-turn', 'queued']]) {
    for (const message of inbox?.[target] || []) {
      if (message.source?.kind !== 'user' || admittedMessages.has(message.id)) continue;
      const requestId = message.source.rpcId || message.source.requestId;
      if (requestId && admittedRequests.has(requestId)) continue;
      const content = (message.content || []).filter(block => ['text', 'image', 'file'].includes(block.type));
      const echo = session.pendingSubmissions?.find(row => row.requestId === requestId);
      rows.push({ key: requestId ? `pending:${requestId}` : `inbox:${message.id}`, id: message.id,
        rpcId: requestId, role: 'user', text: content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
        content, time: echo?.time, submissionState: placement, provisional: true });
      admittedMessages.add(message.id);
      if (requestId) admittedRequests.add(requestId);
    }
  }
  for (const request of history.requests || []) {
    if (request.threadId !== threadId || !request.requestId || internalRequest(request)) continue;
    if (admittedMessages.has(request.messageId)) admittedRequests.add(request.requestId);
    if (['queued', 'processing', 'prepared', 'failed', 'uncertain'].includes(request.status)
      && typeof request.text === 'string' && request.text.trim()
      && !admittedRequests.has(request.requestId) && !admittedMessages.has(request.messageId)) {
      if (!request.questionReply || !answeredCalls.has(request.questionReply.callId)) rows.push({
        key: request.questionReply ? `message:${request.messageId}` : `request:${request.requestId}`,
        id: request.messageId, rpcId: request.requestId, role: 'user',
        ...(request.questionReply ? { kind: 'question-reply', ...request.questionReply } : { text: request.text }),
        ...(request.status === 'queued' ? { submissionState: 'queued' } : {}),
        time: request.createdAt, provisional: true });
      if (request.questionReply) answeredCalls.add(request.questionReply.callId);
      admittedRequests.add(request.requestId);
      if (request.messageId) admittedMessages.add(request.messageId);
    }
    if (['failed', 'uncertain'].includes(request.status)) {
      rows.push({ key: `request-state:${request.requestId}`, requestId: request.requestId, origin: 'system', role: 'system', kind: 'system_state',
        title: request.status === 'failed' ? '消息处理失败' : '消息处理结果待核实',
        text: request.error || (request.status === 'failed' ? '消息处理失败' : '消息处理结果待核实'), time: request.updatedAt || request.createdAt });
    }
  }
  for (const pending of session.pendingSubmissions || []) {
    if (!['transcript', 'steering', 'queued'].includes(pending.placement) || admittedRequests.has(pending.requestId)) continue;
    rows.push({ key: `pending:${pending.requestId}`, rpcId: pending.requestId, role: 'user', text: pending.text, time: pending.time,
      ...(pending.placement !== 'transcript' ? { submissionState: pending.placement } : {}),
      content: (pending.attachments || []).map(block => ({ type: block.type, name: block.value?.name })), provisional: true });
  }
  for (const row of history.notifications || []) {
    if (row.threadId !== threadId || !publicText(row) || !conversationalNotification(row)) continue;
    const key = eventKey(row);
    if (key && publishedEvents.has(key)) continue;
    if (key) publishedEvents.add(key);
    rows.push({ ...row, role: 'assistant', kind: 'delivery', key: `notification:${row.eventId || row.id}`,
      time: row.createdAt || row.time, notification: true });
  }
  return [...new Map(rows.map(row => [row.key, row])).values()]
    .sort(compareRows);
}
