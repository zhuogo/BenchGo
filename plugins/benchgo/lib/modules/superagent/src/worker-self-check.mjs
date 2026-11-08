import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const workerSelfCheckRequirement = '完成任务后，先按本工单要求做一次快速轻量自校验，优先运行适用的机械测试、构建和输出检查，修正明显错误和漏项，通过后才可报告执行完成；不能解决的如实报告受阻或失败。Before your final response, call assistant_task_result with your actual self-check evidence and outcome. Your complete final response is saved as the original Ticket result; the Router receives its completion signal and chooses how to tell the user. Preserve concrete results, artifact paths, checks and limitations, without a mandatory report template. Never include secrets or internal reasoning.';

const nonempty = value => typeof value === 'string' && !!value.trim();
const fail = message => Object.assign(new Error(message), { code: 'WORKER_SELF_CHECK' });

export function validateWorkerSelfCheck(input) {
  const check = input?.selfCheck;
  if (!nonempty(check?.summary) || !['completed', 'failed'].includes(input.outcome || 'completed')
    || ['checks', 'limitations'].some(key => check[key] !== undefined && (!Array.isArray(check[key]) || check[key].some(value => !nonempty(value))))) throw fail('A valid Worker self-check summary is required');
  if (input.outcome === 'failed' && ['attempted', 'cause', 'resumeConditions'].some(key => !nonempty(input.failure?.[key]))) throw fail('Structural failure requires attempted, cause and resumeConditions');
  return structuredClone({ selfCheck: check, outcome: input.outcome || 'completed', ...(input.outcome === 'failed' ? { failure: input.failure } : {}) });
}

/** An owned ledger record from the original Worker; no separate Agent or scorer. */
export function installWorkerSelfCheck(scope, agent, { database, assignment, run, isWaiting = () => false, renew = async () => {} }) {
  let supplemented = false;
  const completionContext = signal => {
    if (signal.aborted || isWaiting()) return null;
    const current = database.getAssignment(assignment.id), ticket = database.getTicket(assignment.ticketId);
    const active = database.runs(assignment.id).find(item => item.id === run.id);
    if (String(agent.id) !== run.sessionId || (agent.session?.id !== undefined && String(agent.session.id) !== run.sessionId)
      || ticket?.id !== assignment.ticketId || current?.id !== assignment.id || current?.ticketId !== assignment.ticketId
      || current?.owner !== assignment.owner || current?.fence !== assignment.fence || current?.state !== 'claimed'
      || !(current.leaseUntil > Date.now()) || active?.sessionId !== run.sessionId
      || active?.owner !== assignment.owner || active?.fence !== assignment.fence
      || !['submitted', 'running'].includes(active?.state) || !['open', 'waiting'].includes(ticket?.status)) return null;
    const revision = database.appliedTicketSnapshot?.(assignment.id)?.instructionRevision ?? ticket.instructionRevision;
    if (revision !== ticket.instructionRevision) return null;
    return { revision, entry: database.getWorkerExecutionState(run.id)?.selfCheck };
  };
  const validFor = ({ revision, entry }) => {
    if (!entry || entry.instructionRevision !== revision) return false;
    try { validateWorkerSelfCheck(entry); return true; } catch { return false; }
  };
  const truncatedTurn = turn => (agent.session?.snapshotEvents?.() || []).some(event =>
    event.type === 'assistant/message' && event.data?.turn === turn && event.data.stream?.some(record =>
      record.type === 'chunk' && record.chunk?.type === 'finish' && record.chunk.reason?.kind === 'max-tokens'));
  scope.on?.('agent/turn-stopping', async ({ agent: subject, signal, turn }) => {
    if (subject !== agent || supplemented) return;
    if (truncatedTurn(turn)) return;
    const before = completionContext(signal);
    if (!before || validFor(before)) return;
    await renew();
    const current = completionContext(signal);
    if (!current || validFor(current) || supplemented || truncatedTurn(turn)) return;
    supplemented = true;
    agent.steer(createUserMessage({ source: { kind: 'benchgo-worker-self-check', ticketId: assignment.ticketId, runId: run.id },
      content: [{ type: 'text', text: 'Continue this same Ticket from the existing transcript; do not restart or repeat completed actions. Perform the actual quick self-check for the current requirements, call assistant_task_result with its evidence and outcome, then provide the complete final response. If user information or a decision is missing, use the existing question flow and remain waiting; do not turn temporary errors or missing information into failure. Only a confirmed structural inability to complete may use outcome failed, with attempted steps, cause, and resumeConditions.' }] }));
  });
  scope.tools?.register?.({ name: 'assistant_task_result', description: 'Record your actual quick self-check and completed or structural-failure outcome before the final response. This records evidence; it does not send a result or close the Ticket.',
    parameters: { type: 'object', additionalProperties: false, required: ['selfCheck'], properties: {
      selfCheck: { type: 'object', additionalProperties: false, required: ['summary'], properties: {
        summary: { type: 'string', minLength: 1 }, checks: { type: 'array', items: { type: 'string' } }, limitations: { type: 'array', items: { type: 'string' } },
      } }, outcome: { type: 'string', enum: ['completed', 'failed'] },
      failure: { type: 'object', additionalProperties: false, required: ['attempted', 'cause', 'resumeConditions'], properties: {
        attempted: { type: 'string' }, cause: { type: 'string' }, resumeConditions: { type: 'string' },
      } },
    } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (input, execution) => {
      execution.signal.throwIfAborted();
      const current = database.getAssignment(assignment.id), ticket = database.getTicket(assignment.ticketId);
      const active = database.runs(assignment.id).find(item => item.id === run.id);
      if (execution.agent !== agent || String(agent.id) !== run.sessionId || current?.owner !== assignment.owner || current?.fence !== assignment.fence
        || current?.state !== 'claimed' || active?.fence !== assignment.fence || active?.owner !== assignment.owner
        || !['submitted', 'running'].includes(active?.state) || !['open', 'waiting'].includes(ticket?.status)) throw fail('Worker result identity is stale');
      const snapshot = database.appliedTicketSnapshot?.(assignment.id);
      const value = validateWorkerSelfCheck(input);
      database.recordWorkerSelfCheck({ assignmentId: assignment.id, runId: run.id, owner: assignment.owner, fence: assignment.fence,
        value: { ...value, instructionRevision: snapshot?.instructionRevision ?? ticket.instructionRevision, callId: execution.callId } });
      return { recorded: true };
    },
  });
  return { read() {
    const entry = database.getWorkerExecutionState(run.id)?.selfCheck;
    if (!entry) throw fail('Worker stopped without recording its quick self-check');
    return { ...validateWorkerSelfCheck(entry), selfCheckRevision: entry.instructionRevision };
  } };
}
