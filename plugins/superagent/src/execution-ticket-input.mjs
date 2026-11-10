import { assessCandidates } from './assessment.mjs';
import { createTicketRevisionService } from './ticket-revision-service.mjs';

/** The official Worker inbox supplies identity; the Router assessor supplies meaning. */
export function createExecutionTicketInputService({ ctx, database, readPolicy, notifyRouter, assess = assessCandidates, timeoutMs = 120000 }) {
  const revisions = createTicketRevisionService({ ctx, database, readPolicy });
  return async function receive({ trigger, assignment, run, agent, signal, attempt = 0 }) {
    const live = database.getAssignment(assignment.id), actualRun = database.runs(assignment.id).find(row => row.id === run.id);
    if (!live || live.state !== 'claimed' || live.owner !== assignment.owner || live.fence !== assignment.fence || live.leaseUntil <= Date.now()
      || !actualRun || actualRun.owner !== live.owner || actualRun.fence !== live.fence || actualRun.sessionId !== agent.id
      || JSON.stringify(database.getTrigger(trigger.id)) !== JSON.stringify(trigger) || trigger.actor.kind !== 'human' || trigger.actor.id !== 'desktop-owner'
      || trigger.source.channel !== 'desktop' || trigger.source.executionSessionId !== agent.id || trigger.source.sessionId !== agent.id
      || trigger.source.messageId !== trigger.source.executionMessageId || !trigger.source.executionMessageId) throw Object.assign(new Error('执行输入分诊缺少可信当前执行归属'), { code: 'FENCING_CONFLICT' });
    const binding = { triggerId: trigger.id, assignmentId: assignment.id, runId: run.id,
      sessionId: agent.id, owner: assignment.owner, fence: assignment.fence };
    let receipt = database.ticketInputs(assignment.ticketId).find(row => row.triggerId === trigger.id);
    if (!receipt) throw Object.assign(new Error('执行输入尚未进入同单账本'), { code: 'TICKET_INPUT_NOT_FOUND' });
    if (receipt.kind === 'revision') return receipt;
    if (receipt.kind === 'stop') { database.cancelTicket(assignment.ticketId); return database.applyTicketStopInput(assignment.ticketId, trigger.id); }
    let disposition = receipt.snapshot?.executionInput;
    if (!disposition || disposition.outcome === 'failed') {
      const ticket = database.getTicket(assignment.ticketId), policy = await readPolicy();
      const assessmentSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
      try {
        let abort;
        const [decision] = await Promise.race([Promise.resolve().then(() => assess({ llm: ctx.llm, model: policy.model, models: policy.models, routingConfig: policy.routingConfig,
          rules: policy.rules, projects: policy.projects, signal: assessmentSignal,
          candidates: [{ candidateId: trigger.id, trigger: { ...trigger, truncated: false },
            gate: { allowed: true, strength: 'explicit' }, tickets: [{ id: ticket.id, status: ticket.status,
              target: ticket.target, acceptance: ticket.acceptance, instructionRevision: ticket.instructionRevision }] }],
          executionInput: { ticketId: ticket.id, mandate: database.currentTicketMandate(ticket.id, ticket.mandate),
            snapshot: database.appliedTicketSnapshot(assignment.id), liveTarget: ticket.target, liveAcceptance: ticket.acceptance } })),
        new Promise((_, reject) => { abort = () => reject(assessmentSignal.reason); assessmentSignal.addEventListener('abort', abort, { once: true });
          if (assessmentSignal.aborted) abort(); })]).finally(() => assessmentSignal.removeEventListener('abort', abort));
        assessmentSignal.throwIfAborted();
        if (!decision || !['revise', 'attach', 'ask', 'stop'].includes(decision.outcome)) throw new Error('执行输入研判缺少有效处置');
        if (decision.outcome === 'stop') {
          if (decision.ticketId !== ticket.id) throw new Error('执行输入叫停必须明确归属当前工单');
          // Reuse the existing immediate stop chain; do not pass a cancellation
          // command through context while another tool boundary can open.
          database.saveExecutionInputDisposition(trigger.id, { ...binding, disposition: { outcome: 'stop', reason: decision.reason } });
          database.recordTicketInput({ ticketId: ticket.id, triggerId: trigger.id, kind: 'stop', idempotencyKey: `trigger:${trigger.id}` });
          database.cancelTicket(ticket.id);
          return database.applyTicketStopInput(ticket.id, trigger.id);
        }
        if (decision.outcome === 'revise') {
          // Scope expansion cannot be admitted by this Worker-facing path.
          if (decision.withinMandate !== true || decision.projectId !== undefined && decision.projectId !== ticket.mandate.project?.id) {
            disposition = { outcome: 'router', reason: decision.reason || '需要核实原授权范围' };
          } else {
            await revisions.changeExecutionInput({ ...binding, decision, policy });
            return database.ticketInputs(ticket.id).find(row => row.triggerId === trigger.id);
          }
        } else disposition = { outcome: decision.outcome === 'ask' ? 'router' : 'context', reason: decision.reason };
        receipt = database.saveExecutionInputDisposition(trigger.id, { ...binding, disposition });
      } catch (cause) {
        if (cause.code === 'INSTRUCTION_REVISION_CONFLICT' && attempt === 0) return receive({ trigger, assignment, run, agent, signal, attempt: 1 });
        if (!['FENCING_CONFLICT', 'MANDATE_REVOKED', 'TICKET_STOPPED'].includes(cause.code)) {
          database.saveExecutionInputDisposition(trigger.id, { ...binding, disposition: { outcome: 'failed',
            code: typeof cause.code === 'string' ? cause.code : 'EXECUTION_INPUT_ASSESSMENT_FAILED', reason: String(cause.message || cause).slice(0, 2000) } });
        }
        throw Object.assign(new Error(`执行输入分诊未完成：${String(cause.message || cause).slice(0, 2000)}`, { cause }), { code: typeof cause.code === 'string' ? cause.code : 'EXECUTION_INPUT_ASSESSMENT_FAILED' });
      }
    }
    if (disposition.outcome === 'router') {
      if (typeof notifyRouter !== 'function') throw Object.assign(new Error('执行输入缺少 Router 授权核实入口'), { code: 'EXECUTION_INPUT_ROUTER_UNAVAILABLE' });
      await notifyRouter({ ticket: database.getTicket(assignment.ticketId), trigger, reason: disposition.reason });
    }
    return receipt;
  };
}
