import { ticketExecutionBlocked } from './ticket-lifecycle.mjs';
import { executionEffects, isReadOnlyWorkerTool } from './execution-effects.mjs';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const signature = (name, args) => {
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* Opaque tool input stays literal. */ } }
  return JSON.stringify([name, canonical(args)]);
};

const fail = (code, message) => Object.assign(new Error(message), { code });
/** Applied requirements are batch-frozen; stop and capability narrowing remain live. */
export function workerAppliedTicket(database, assignment, execution) {
  const current = database.getTicket(assignment.ticketId);
  if (!current) throw new Error('Worker 工单不存在');
  if (ticketExecutionBlocked(current)) throw fail('WORKER_TICKET_INACTIVE', '工单已暂停、停止或结束');
  const ticket = { ...current, ...database.appliedTicketSnapshot(assignment.id), status: current.status, executionControl: current.executionControl };
  for (const names of [ticket.toolScope, current.mandate?.toolScope, current.mandate?.scope?.toolNames]) {
    if (names == null) continue;
    if (!Array.isArray(names) || !names.every(name => typeof name === 'string') || !names.includes(execution.name)) throw fail('WORKER_TOOL_SCOPE', '当前工单工具范围不允许此动作');
  }
  return ticket;
}

/** Install on a single Harness worker scope; never use frozen prompt context as authority. */
export function installWorkerPermissionGate(scope, { database, assignment, readPolicy, authorizeAction, priorToolEvents = [], toolReceipts = new Map(), leaseMs = 60000 }) {
  const previousCalls = new Set(priorToolEvents.flatMap(event => event.type === 'assistant/message'
    ? (event.data?.message?.content || []).filter(block => block.type === 'tool-call').map(block => signature(block.name, block.arguments))
    : event.type === 'tool/ptc-dispatch-start' ? [signature(event.data.name, event.data.arguments)] : []));
  const previousEffects = executionEffects({ events: priorToolEvents }, toolReceipts);
  scope.systemPrompt?.section({ name: 'benchgo-external-action-boundary', order: -109, interpolate: false,
    text: 'Open terminal, scripts and browser tools remain available for normal work and preparation. Never submit payment/purchase, password changes, account deletion or additional external sending through these open tools, scripts or aliases. Submit these four categories only through a registered assistant_external_action adapter with exact frozen recipient/object/content and a fresh one-time approval. If no adapter is registered, prepare up to the final step and return a clear human handoff; never claim submission or approval. Public reading and normal authenticated replies/progress/questions/results to the original source use their existing owned paths. Tool-level checks cannot prove arbitrary commands or natural-language browser actions free of high-risk effects.' });
  scope.on('tools/pre-execute', (execution, next) => {
    execution.signal.throwIfAborted(); workerAppliedTicket(database, assignment, execution); return next();
  });
  return scope.on('tools/execute', async (execution, next) => {
    execution.signal.throwIfAborted();
    if (assignment.interruptedContinuation && previousEffects.effectsVerified === false && !isReadOnlyWorkerTool(execution.name)) {
      throw Object.assign(new Error('Previous external effects remain unverified; only read-only verification is permitted'), { code: 'EXECUTION_EFFECTS_UNKNOWN' });
    }
    if (assignment.interruptedContinuation && !isReadOnlyWorkerTool(execution.name)
      && previousCalls.has(signature(execution.name, execution.arguments))) {
      throw Object.assign(new Error('A previously dispatched action cannot be replayed during correction; inspect its saved outcome before proceeding'), { code: 'ACTION_REPLAY_BLOCKED' });
    }
    const policy = await readPolicy();
    const ticket = workerAppliedTicket(database, assignment, execution);
    const permission = await authorizeAction({ policy, mandate: ticket.mandate, ticket, execution });
    execution.signal.throwIfAborted();
    const current = await readPolicy();
    const latest = workerAppliedTicket(database, assignment, execution);
    if (latest.authorizationVersion !== ticket.authorizationVersion) throw fail('WORKER_AUTHORIZATION_CHANGED', '提交前授权版本已变化');
    execution.signal.throwIfAborted();
    const versionKey = ticket.mandate?.source?.channel === 'desktop' ? 'desktopVersion' : 'version';
    const renewal = database.renewAssignment(assignment.id, {
      owner: assignment.owner, fence: assignment.fence, leaseMs,
      validateMandate: () => permission?.allowed === true && current[versionKey] === policy[versionKey],
    });
    if (!renewal.allowed) throw new Error('当前权限已变更或不允许此动作，Worker 已停止执行');
    // No await between the final lease/policy check and entering official dispatch.
    return next();
  });
}

/** Stop a repeated shared prerequisite failure at the official step boundary.
 * Argument errors remain correctable; successful work or new instructions resets the streak.
 */
export function installWorkerFailureConvergence(scope, agent, { database, assignment, revision = () => database.getTicket(assignment.ticketId)?.instructionRevision, onStop = () => {} }) {
  const structural = new Set(['ENOSPC', 'EDQUOT', 'EROFS', 'WORKER_AUTHORIZATION_CHANGED', 'WORKER_TICKET_INACTIVE',
    'ROLE_SERVICES_UNAVAILABLE', 'ROLE_PRESET_UNAVAILABLE', 'SESSION_ROLE_STORE_UNAVAILABLE',
    'MANAGEMENT_OWNER_REQUIRED', 'MANAGEMENT_APPROVAL_UNAVAILABLE', 'MANAGEMENT_APPROVAL_DENIED', 'SETTINGS_UNAVAILABLE', 'CLEANUP_UNAVAILABLE']);
  let prior, stopped;
  const admittedUsers = new Set(), failures = new Map();
  scope.on('tools/execute', async (execution, next) => {
    try { return await next(); }
    catch (error) { if (execution.agent === agent && error?.code) failures.set(execution.callId, error.code); throw error; }
  });
  scope.on('tools/result', (execution, result) => {
    if (execution.agent !== agent) return;
    const message = result.error?.message || (result.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    const code = result.error?.info?.code ?? result.error?.code ?? failures.get(execution.callId) ?? /^([A-Z_]+): /.exec(message)?.[1];
    if (!result.isError || !structural.has(code)) { prior = undefined; return; }
    const currentRevision = revision();
    if (prior?.code === code && prior.message === message && prior.revision === currentRevision) stopped = prior;
    else prior = { code, message, revision: currentRevision, toolName: execution.name, callId: execution.callId };
  });
  scope.on('agent/pre-step', (payload, next) => {
    for (const message of payload.messages || []) if (message.source?.kind === 'user' && !admittedUsers.has(message.id)) {
      admittedUsers.add(message.id); stopped = undefined; prior = undefined;
    }
    if (stopped && stopped.revision === revision()) { onStop(stopped); return { kind: 'reject' }; }
    stopped = undefined;
    return next();
  });
  return { failure: () => stopped && Object.assign(new Error(stopped.message), { code: stopped.code, toolName: stopped.toolName, callId: stopped.callId }) };
}
