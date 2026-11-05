import { createHash } from 'node:crypto';
import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import { validateTicketMandate } from './assessment-policy.mjs';

const auditType = 'plugin:benchgo-plugin/vault';
const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
const fail = (code, message) => Object.assign(new Error(message), { code });

/** Scoped to a host-created Worker. No ticket/run identifiers are accepted from
 * the model, and approval is always requested through the official service.
 */
export function installWorkerVault(scope, agent, { ctx, database, assignment, run, readPolicy, authorizeAction, leaseMs = 60000 }) {
  if (!ctx.get?.('benchgoVault')) return false;
  const vault = () => {
    const service = ctx.get('benchgoVault');
    if (!service) throw fail('VAULT_UNAVAILABLE', '基础层保险库未启用');
    return service;
  };
  const identity = exec => {
    exec.signal.throwIfAborted();
    if (exec.agent !== agent || String(agent.id) !== run.sessionId || String(agent.session?.id) !== run.sessionId || typeof exec.callId !== 'string' || !exec.callId) throw fail('VAULT_WORKER_MISMATCH', '保险库仅供当前 Worker 运行使用');
    const current = database.getAssignment(assignment.id), ticket = database.getTicket(assignment.ticketId);
    const active = database.runs(assignment.id).find(item => item.id === run.id);
    if (!ticket || !['open', 'waiting'].includes(ticket.status) || !current || current.ticketId !== ticket.id || current.owner !== assignment.owner || current.fence !== assignment.fence || current.state !== 'claimed'
      || !active || active.owner !== assignment.owner || active.fence !== assignment.fence || active.sessionId !== run.sessionId || !['submitted', 'running'].includes(active.state)
      || (current.instructionRevision ?? 1) !== ticket.instructionRevision) throw fail('VAULT_WORKER_STALE', '工单或运行身份已变化，不能代填');
    return ticket;
  };
  const renew = (exec, policy, expected) => {
    const ticket = identity(exec), versionKey = ticket.mandate.source?.channel === 'desktop' ? 'desktopVersion' : 'version';
    if (expected && expected[versionKey] !== policy[versionKey]) throw fail('VAULT_POLICY_CHANGED', '审批期间规则发生变化，请重新核实');
    const result = database.renewAssignment(assignment.id, { owner: assignment.owner, fence: assignment.fence, leaseMs,
      validateMandate: mandate => validateTicketMandate(mandate, { policy }) });
    if (!result.allowed) throw fail('VAULT_MANDATE_REVOKED', '当前工单授权不允许代填');
    return ticket;
  };
  const audit = (exec, action, phase, result) => appendPluginRecord(agent.session, auditType, {
    ticketId: assignment.ticketId, assignmentId: assignment.id, runId: run.id, fence: assignment.fence,
    callId: exec.callId, handle: action.handle, revision: action.revision, target: action.target, method: action.method,
    requestHash: action.requestHash, phase, ...(result ? { result } : {}),
  });
  const register = (name, description, properties, required, execute) => scope.tools.register({ name, description, parameters: { type: 'object', properties, required, additionalProperties: false }, output, execute });
  register('assistant_vault_list', 'List opaque credential handles and exact HTTPS target bindings for this Ticket. Secrets never enter the conversation. Ask the owner to record credentials in Resources > Vault when unavailable.', {}, [], async (_args, exec) => {
    const policy = await readPolicy(); renew(exec, policy);
    return vault().list();
  });
  register('assistant_vault_execute', 'System-fill a saved credential into its owner-bound HTTPS request for this Ticket. Requires current mandate and official approval for the exact target/method/body. Only HTTP status is returned. Never automatically retry an uncertain external request. Browser DOM login is unsupported.', {
    handle: { type: 'string' }, revision: { type: 'integer', minimum: 1 }, body: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
  }, ['handle', 'revision'], async (input, exec) => {
    const policy = await readPolicy(), ticket = renew(exec, policy), service = vault();
    const entry = (await service.list()).entries.find(item => item.handle === input.handle && item.revision === input.revision);
    if (!entry) throw fail('VAULT_CONFLICT', '凭据已变更，请重新选择');
    const sourceBody = input.body ?? {};
    if (!sourceBody || typeof sourceBody !== 'object' || Array.isArray(sourceBody) || Object.keys(sourceBody).length > 100
      || Object.entries(sourceBody).some(([key, value]) => !/^[A-Za-z][A-Za-z0-9_-]{0,100}$/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key) || !['string', 'number', 'boolean'].includes(typeof value))
      || JSON.stringify(sourceBody).length > 32768) throw fail('VAULT_INVALID_BODY', '代填请求正文无效或过大');
    const body = Object.freeze(Object.fromEntries(Object.entries(sourceBody).sort(([left], [right]) => left.localeCompare(right))));
    const action = { handle: entry.handle, revision: entry.revision, target: entry.target, method: entry.method,
      requestHash: createHash('sha256').update(JSON.stringify([entry.handle, entry.revision, entry.target, entry.method, body])).digest('hex') };
    const prior = agent.session.snapshotEvents().filter(event => event.type === auditType && event.data?.runId === run.id);
    const latest = new Map(prior.map(event => [event.data.callId, event.data]));
    if (prior.some(event => event.data.callId === exec.callId && ['submitted', 'completed', 'uncertain'].includes(event.data.phase))
      || [...latest.values()].some(event => event.requestHash === action.requestHash && ['submitted', 'uncertain'].includes(event.phase))) throw fail('VAULT_REPLAY_BLOCKED', '此代填请求已提交，请核实执行记录，禁止自动重放');
    const execution = { ...exec, name: 'assistant_vault_execute', args: { ...action, body } };
    const decision = await authorizeAction({ policy, mandate: ticket.mandate, ticket, execution });
    if (decision?.allowed !== true) throw fail('VAULT_DENIED', '当前规则不允许此凭据代填');
    const approval = scope.get?.('approval') || ctx.get?.('approval');
    if (!approval?.request) throw fail('VAULT_APPROVAL_UNAVAILABLE', '凭据代填需要人工审批服务');
    const approved = await approval.request({ agent, toolName: 'assistant_vault_execute', callId: exec.callId, signal: exec.signal,
      reason: '凭据代填（密钥不展示）：\n' + JSON.stringify({ ticketId: ticket.id, target: entry.target, method: entry.method, credential: entry.label, body }) });
    if (!(approved === true || approved === 'allowed-once' || approved === 'allowed-always' || approved?.allow === true)) {
      audit(exec, action, 'denied'); throw fail('VAULT_APPROVAL_DENIED', '凭据代填未获批准');
    }
    return service.execute({ ...action, body, signal: exec.signal, dispatch: async send => {
      // Vault may have waited for a queue/credential store/OTP write. Recheck
      // live disk policy and owner/fence here, immediately at the HTTP boundary.
      const current = await readPolicy();
      const currentTicket = identity(exec);
      const allowed = await authorizeAction({ policy: current, mandate: currentTicket.mandate, ticket: currentTicket, execution });
      if (allowed?.allowed !== true) throw fail('VAULT_DENIED', '审批后规则不再允许此凭据代填');
      const finalPolicy = await readPolicy(); renew(exec, finalPolicy, policy);
      audit(exec, action, 'submitted');
      const pending = send();
      try { const result = await pending; audit(exec, action, 'completed', result); return result; }
      catch (error) { audit(exec, action, 'uncertain'); throw error; }
    } });
  });
  return true;
}
