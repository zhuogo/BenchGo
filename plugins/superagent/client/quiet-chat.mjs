import { isChatUserMessage, readAdmittedQuestionReply } from '../src/question-reply.mjs';
import { isTicketStateNotice } from '../src/ticket-state-report.mjs';

function ticketStateSummary(row) {
  const text = row.text.replace(/^\s*【[^】]+】\s*/u, '').replace(/^(?:\s*(?:#{1,6}\s*)?系统状态\s*[:：]?\s*)+/u, '').replace(/\s+/gu, ' ').trim();
  const title = (typeof row.title === 'string' && row.title.trim()) || row.text.match(/^\s*【([^】]+)】/u)?.[1];
  return { ...(title ? { title } : {}), text: text || (row.publication?.systemState?.state === 'delivery_wait'
    ? '结果已保存，等待原来源交付。' : '执行记录已保留，等待恢复条件。') };
}

/** Defence in depth: only the server publication projection can supply assistant rows. */
export function quietChatRows(history = {}, threadId = 'main', session = {}, chat) {
  const rows = (history.messages || []).filter(row => !row.streaming &&
    (row.role === 'user' || (row.role === 'assistant' && row.kind === 'final')))
    .map(row => ({ ...row, key: `message:${row.id}` }));
  const reportedStates = new Set(rows.filter(row => row.role === 'assistant' && typeof row.ticketStateEventKey === 'string'
    && row.ticketStateEventKey && typeof row.text === 'string' && row.text.trim()).map(row => row.ticketStateEventKey));
  // Use the host's synchronous submission echo, then its admitted user events.
  // Never project assistant/tool/context nodes from this unrestricted view.
  const seenSeq = new Set(rows.filter(row => row.role === 'user').map(row => row.seq).filter(Number.isFinite));
  const admittedRequests = new Set(rows.filter(row => row.role === 'user').map(row => row.requestId || row.rpcId || row.source?.requestId || row.source?.rpcId).filter(Boolean));
  const admittedMessages = new Set(rows.filter(row => row.role === 'user').map(row => row.id).filter(Boolean));
  const answeredCalls = new Set(rows.filter(row => row.kind === 'question-reply').map(row => row.callId).filter(Boolean));
  const historyEnd = Math.max(-1, ...rows.map(row => row.seq).filter(Number.isFinite));
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
    const content = (node.content || []).filter(block => ['text', 'image', 'file'].includes(block.type));
    rows.push({ key: `live-user:${node.seq}`, role: 'user', seq: node.seq, rpcId: requestId, time: node.time,
      text: content.filter(block => block.type === 'text').map(block => block.text).join('\n'), content, provisional: true });
  }
  for (const request of history.requests || []) {
    if (request.threadId !== threadId || !request.requestId) continue;
    if (admittedMessages.has(request.messageId)) admittedRequests.add(request.requestId);
    if (['queued', 'processing', 'prepared', 'failed', 'uncertain'].includes(request.status)
      && typeof request.text === 'string' && request.text.trim()
      && !admittedRequests.has(request.requestId) && !admittedMessages.has(request.messageId)) {
      if (!request.questionReply || !answeredCalls.has(request.questionReply.callId)) rows.push({
        key: request.questionReply ? `message:${request.messageId}` : `request:${request.requestId}`,
        id: request.messageId, rpcId: request.requestId, role: 'user',
        ...(request.questionReply ? { kind: 'question-reply', ...request.questionReply } : { text: request.text }),
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
    if (pending.placement !== 'transcript' || admittedRequests.has(pending.requestId)) continue;
    rows.push({ key: `pending:${pending.requestId}`, rpcId: pending.requestId, role: 'user', text: pending.text, time: pending.time,
      content: (pending.attachments || []).map(block => ({ type: block.type, name: block.value?.name })), provisional: true });
  }
  for (const row of history.notifications || []) {
    if (row.threadId !== threadId || typeof row.text !== 'string' || !row.text.trim()) continue;
    const ticketState = isTicketStateNotice(row);
    if (ticketState && reportedStates.has(row.ticketStateEventKey || row.eventKey || row.eventId || row.id)) continue;
    const system = row.origin === 'system' || row.publication?.origin === 'system';
    rows.push({ ...row, ...(system ? ticketStateSummary(row) : {}), role: system ? 'system' : 'assistant', kind: system ? 'system_state' : 'delivery', key: `notification:${row.eventId || row.id}`,
      time: row.createdAt || row.time, notification: true });
  }
  return [...new Map(rows.map(row => [row.key, row])).values()]
    .sort((a, b) => (new Date(a.time).getTime() || 0) - (new Date(b.time).getTime() || 0));
}
