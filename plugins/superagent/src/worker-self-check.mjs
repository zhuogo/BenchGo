import { ticketExecutionBlocked } from './ticket-lifecycle.mjs';

export const workerSelfCheckRequirement = '完成任务后直接报告实际结果、必要的验证与仍未解决的问题。检查应与任务相称，纯文本任务不要求创建文件。只依据真实执行与工具回执描述成功、失败和外部效果，不把计划或尝试说成完成。assistant_task_result 仅用于可选的证据记录，不是完成任务的前置条件。Never include secrets or internal reasoning.';

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
export function installWorkerSelfCheck(scope, agent, { database, assignment, run }) {
  scope.tools?.register?.({ name: 'assistant_task_result', description: 'Optionally record actual checks and outcome alongside your final report. Natural final responses do not require this tool.',
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
        || !['submitted', 'running'].includes(active?.state) || !ticket || ticketExecutionBlocked(ticket)) throw fail('Worker result identity is stale');
      const snapshot = database.appliedTicketSnapshot?.(assignment.id);
      const value = validateWorkerSelfCheck(input);
      database.recordWorkerSelfCheck({ assignmentId: assignment.id, runId: run.id, owner: assignment.owner, fence: assignment.fence,
        value: { ...value, instructionRevision: snapshot?.instructionRevision ?? ticket.instructionRevision, callId: execution.callId } });
      return { recorded: true };
    },
  });
  return { read() {
    const entry = database.getWorkerExecutionState(run.id)?.selfCheck;
    if (!entry) return {};
    return { ...structuredClone(entry), selfCheckRevision: entry.instructionRevision };
  } };
}
