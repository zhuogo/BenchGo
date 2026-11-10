import { resolve } from 'node:path';
import { validateTicketMandate } from './assessment-policy.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const executionTerminal = new Set(['completed', 'failed', 'cancelled']);

/** User-facing restoration only: never expose this as an Agent rollback tool. */
export function createCheckpointService({ database, checkpoints, readPolicy, agents, validateMandate = validateTicketMandate }) {
  function owned(ticketId, ownerSessionId) {
    const ticket = database.getTicket(ticketId);
    if (!ticket) throw fail('TICKET_NOT_FOUND', '工单不存在');
    if (ownerSessionId !== undefined && (ticket.mandate.source?.channel !== 'desktop' || ticket.mandate.source.sessionId !== ownerSessionId)) throw fail('CHECKPOINT_ACCESS', '检查点不属于当前会话');
    return ticket;
  }
  function execution(ticket, runId) {
    const assignments = database.assignments(ticket.id);
    for (const assignment of assignments) {
      const run = database.runs(assignment.id).find(row => row.id === runId);
      if (run) return { assignment, run, assignments };
    }
    throw fail('CHECKPOINT_ACCESS', '执行记录不属于此工单');
  }
  async function rows(ticket, runId) {
    const records = await checkpoints.list({ ticketId: ticket.id, ...(runId ? { runId } : {}) });
    for (const row of records) {
      const { assignment, run } = execution(ticket, row.runId);
      if (row.assignmentId !== assignment.id || resolve(row.directory) !== resolve(run.environment?.path || run.directory)) throw fail('CHECKPOINT_ACCESS', '备份与原始执行身份不一致');
    }
    return records;
  }
  async function stopped(ticketId, runId, ownerSessionId) {
    const ticket = owned(ticketId, ownerSessionId), { assignment, run, assignments } = execution(ticket, runId);
    if (!(ticket.status === 'completed' || ticket.executionControl?.stopped) || assignments.some(row => !executionTerminal.has(row.state)) || !executionTerminal.has(run.state)) throw fail('CHECKPOINT_EXECUTION_ACTIVE', '请先终止工单；运行中或待核实执行不能回滚');
    if (assignment.executionStopped?.fence !== run.fence || assignment.executionStopped?.owner !== run.owner) throw fail('CHECKPOINT_EXECUTION_ACTIVE', '尚未确认原始执行器已经释放');
    if (agents?.get?.(run.sessionId)) throw fail('CHECKPOINT_EXECUTION_ACTIVE', '原始执行会话仍被宿主持有');
    const policy = await readPolicy();
    if (!validateMandate(ticket.mandate, { policy })) throw fail('CHECKPOINT_POLICY_CHANGED', '当前权限已变更，不能沿用旧工单进行恢复');
    return { ticket, run, policyVersion: ticket.mandate.source?.channel === 'desktop' ? policy.desktopVersion : policy.version };
  }
  return {
    async list({ ticketId, ownerSessionId } = {}) { return rows(owned(ticketId, ownerSessionId)); },
    async preview({ ticketId, runId, ownerSessionId } = {}) {
      const ticket = owned(ticketId, ownerSessionId); execution(ticket, runId); await rows(ticket, runId);
      return checkpoints.preview(runId);
    },
    async restore({ ticketId, runId, token, ownerSessionId } = {}) {
      const first = await stopped(ticketId, runId, ownerSessionId);
      await rows(first.ticket, runId);
      // Recheck after disk inspection and directly before entering restoration.
      const second = await stopped(ticketId, runId, ownerSessionId);
      if (first.policyVersion !== second.policyVersion) throw fail('CHECKPOINT_POLICY_CHANGED', '恢复准备期间权限已变更');
      const result = await checkpoints.restore(runId, { token, beforeWrite: async () => {
        const current = await stopped(ticketId, runId, ownerSessionId);
        if (current.policyVersion !== first.policyVersion) throw fail('CHECKPOINT_POLICY_CHANGED', '恢复期间权限已变更；保留恢复前备份');
      } });
      const ticket = database.markTicketRestored(ticketId, { expectedInstructionRevision: first.ticket.instructionRevision });
      return { ...result, ticket };
    },
  };
}
