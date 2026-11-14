import { taskExecutionBlocked } from './task-lifecycle.mjs';
import { validateTaskMandate } from './assessment-policy.mjs';

const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
const fail = (code, message) => Object.assign(new Error(message), { code });

/** Generic credential handles are safe to discover, never authority to submit arbitrary HTTP. */
export function installWorkerVault(scope, agent, { ctx, database, assignment, run, readPolicy, leaseMs = 60000 }) {
  if (!ctx.get?.('benchgoVault')) return false;
  const renew = async exec => {
    exec.signal.throwIfAborted();
    if (exec.agent !== agent || String(agent.id) !== run.sessionId || String(agent.session?.id) !== run.sessionId || !exec.callId) throw fail('VAULT_WORKER_MISMATCH', '保险库仅供当前 Worker 运行使用');
    const policy = await readPolicy(), task = database.getTask(assignment.taskId), current = database.getAssignment(assignment.id);
    const active = database.runs(assignment.id).find(item => item.id === run.id);
    if (!task || taskExecutionBlocked(task) || !current || current.owner !== assignment.owner || current.fence !== assignment.fence || current.state !== 'claimed'
      || !active || active.owner !== assignment.owner || active.fence !== assignment.fence || active.sessionId !== run.sessionId || !['submitted', 'running'].includes(active.state)) throw fail('VAULT_WORKER_STALE', '任务或运行身份已变化，不能使用保险库');
    const result = database.renewAssignment(assignment.id, { owner: assignment.owner, fence: assignment.fence, leaseMs, validateMandate: mandate => validateTaskMandate(mandate, { policy }) });
    if (!result.allowed) throw fail('VAULT_MANDATE_REVOKED', '当前任务授权不允许使用保险库');
    exec.signal.throwIfAborted();
  };
  scope.tools.register({ name: 'assistant_vault_list', description: 'List credential references, addresses or names, and custom credential names only. Values are never available to the model. Missing credentials require Resources > Vault secure input. Saving credentials does not connect browser login or other execution capabilities; report unavailable execution support honestly.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, output,
    async execute(_args, exec) { await renew(exec); const service = ctx.get('benchgoVault'); if (!service) throw fail('VAULT_UNAVAILABLE', '基础层保险库未启用'); return service.list(); },
  });
  return true;
}
