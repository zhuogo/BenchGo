import { ownsDesktopTicket } from './desktop-ticket-owner.mjs';
import { questionBatch, questionAnswers, readBoundQuestionReply } from './question-reply.mjs';

const rejected = text => Object.assign(new Error(text), { code: 'QUESTION_BINDING_REJECTED' });

/** Bind only concrete owned Attention IDs; ordinary cards remain ordinary conversation. */
export function installRouterQuestions(scope, agent, { database, threadId = 'main', getOwnerScope } = {}) {
  const sourceMatches = ticket => ticket?.mandate.source?.channel === 'desktop'
    && (ticket.mandate.source.threadId || 'main') === threadId;
  function apply(callId, answers, requestId) {
    if (!database) return [];
    const binding = database.routerQuestionBinding?.(agent.id, callId);
    if (!binding) return [];
    if (binding.sessionId !== agent.id || binding.threadId !== threadId) throw rejected('问题答复来源不匹配');
    return binding.entries.map(entry => {
      const ticket = database.getTicket(entry.ticketId), answer = answers.find(row => row.id === entry.questionId);
      if (!sourceMatches(ticket) || ticket.mandate.source.sessionId !== entry.ownerSessionId
        || ticket.instructionRevision !== entry.instructionRevision || !answer) throw rejected('问题答复已过期或归属不匹配');
      // A skip carries no facts or permission and cannot resume an awaiting Worker.
      if (!answer.selected.length && !answer.custom?.trim()) return { ticketId: ticket.id, attentionId: entry.attentionId, skipped: true };
      return database.answerDesktopAttention({ ticketId: ticket.id, attentionId: entry.attentionId,
        instructionRevision: entry.instructionRevision, requestId: `${requestId}:${entry.questionId}`,
        answer: { selected: answer.selected, ...(answer.custom !== undefined ? { custom: answer.custom } : {}) } });
    });
  }
  scope.on('tools/pre-execute', async (execution, next) => {
    if (!database?.saveRouterQuestionBinding || execution.agent !== agent || execution.name !== 'ask_user_question' || execution.parent) return next();
    const decision = await next();
    if (decision?.kind !== 'allow') return decision;
    const questions = questionBatch(execution.arguments);
    if (!questions) return decision;
    execution.signal.throwIfAborted();
    const owner = await getOwnerScope?.() || { threadId, sessionIds: [agent.id] };
    const tickets = [];
    if (!owner.sessionIds?.length) throw rejected('问题缺少当前会话归属');
    for (let offset = 0; ; offset += 1000) {
      const page = database.listTickets({ ownerSessionIds: owner.sessionIds, ownerThreadId: threadId, limit: 1000, offset });
      tickets.push(...page);
      if (page.length < 1000) break;
    }
    const entries = [];
    for (const question of questions) {
      const matches = tickets.filter(ticket => sourceMatches(ticket) && ownsDesktopTicket(ticket, owner)).flatMap(ticket =>
        database.attentions(ticket.id).filter(attention => attention.id === question.id && attention.state === 'waiting'
          && !attention.answerTriggerId).map(attention => ({ ticket, attention })));
      if (!matches.length) continue;
      if (matches.length !== 1) throw rejected('问题编号不能绑定多个工单');
      const { ticket, attention } = matches[0], original = execution.arguments.questions.find(row => row.id === question.id);
      const revision = attention.instructionRevision ?? database.getAssignment(attention.assignmentId)?.instructionRevision ?? 1;
      if (revision !== ticket.instructionRevision || question.question !== attention.question.question
        || JSON.stringify((original.options || []).map(row => row.label)) !== JSON.stringify((attention.question.options || []).map(row => row.label))
        || !!original.multi_select !== !!attention.question.multiSelect) throw rejected('问题内容与原工单问题不一致');
      entries.push({ questionId: question.id, ticketId: ticket.id, attentionId: attention.id,
        instructionRevision: revision, ownerSessionId: ticket.mandate.source.sessionId });
    }
    database.saveRouterQuestionBinding({ callId: String(execution.callId), sessionId: agent.id, threadId, questions, entries });
    return decision;
  });
  // This runs after the official body settles. It never replaces the tool value,
  // answer UI, or official pending/next-turn behavior.
  scope.on('tools/post-execute', async (execution, result, next) => {
    const decision = await next();
    if (execution.agent !== agent || execution.name !== 'ask_user_question' || execution.parent || result.isError
      || decision?.kind !== 'accept' || decision.content !== undefined || decision.value !== undefined) return decision;
    const questions = questionBatch(execution.arguments);
    const answers = questions && questionAnswers(questions, { content: result.content });
    if (answers) apply(String(execution.callId), answers, `question:${execution.callId}`);
    return decision;
  });
  return {
    read(message) {
      if (message?.source?.kind !== 'user-question-reply') return null;
      const binding = database?.routerQuestionBinding?.(agent.id, message.source.callId);
      return binding?.threadId === threadId ? readBoundQuestionReply(message, binding.questions) : null;
    },
    accept(message) {
      const reply = this.read(message);
      return reply ? apply(reply.callId, reply.answers, message.id) : [];
    },
  };
}
