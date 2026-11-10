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
  const snapshot = database.appliedTicketSnapshot?.(assignment.id);
  const ticket = snapshot ? { ...current, ...snapshot, status: current.status, executionControl: current.executionControl } : current;
  for (const names of [ticket.toolScope, current.mandate?.toolScope, current.mandate?.scope?.toolNames]) {
    if (names == null) continue;
    if (!Array.isArray(names) || !names.every(name => typeof name === 'string') || !names.includes(execution.name)) throw fail('WORKER_TOOL_SCOPE', '当前工单工具范围不允许此动作');
  }
  return ticket;
}

/** Install on a single Harness worker scope; never use frozen prompt context as authority. */
export function installWorkerPermissionGate(scope, { database, assignment, readPolicy, authorizeAction, withCheckpoint, priorToolEvents = [], leaseMs = 60000 }) {
  const previousCalls = new Set(priorToolEvents.flatMap(event => event.type === 'assistant/message'
    ? (event.data?.message?.content || []).filter(block => block.type === 'tool-call').map(block => signature(block.name, block.arguments))
    : event.type === 'tool/ptc-dispatch-start' ? [signature(event.data.name, event.data.arguments)] : []));
  const previousEffects = executionEffects({ events: priorToolEvents });
  scope.systemPrompt?.section({ name: 'benchgo-external-action-boundary', order: -109, interpolate: false,
    text: 'Open terminal, scripts and browser tools remain available for normal work and preparation. Never submit payment/purchase, password changes, account deletion or additional external sending through these open tools, scripts or aliases. Submit these four categories only through a registered assistant_external_action adapter with exact frozen recipient/object/content and a fresh one-time approval. If no adapter is registered, prepare up to the final step and return a clear human handoff; never claim submission or approval. Public reading and normal authenticated replies/progress/questions/results to the original source use their existing owned paths. Tool-level checks cannot prove arbitrary commands or natural-language browser actions free of high-risk effects.' });
  scope.on('tools/pre-execute', (execution, next) => {
    execution.signal.throwIfAborted(); workerAppliedTicket(database, assignment, execution); return next();
  });
  return scope.on('tools/execute', async (execution, next) => {
    execution.signal.throwIfAborted();
    if (previousEffects.effectsVerified === false && !isReadOnlyWorkerTool(execution.name)) {
      throw Object.assign(new Error('Previous external effects remain unverified; only read-only verification is permitted'), { code: 'EXECUTION_EFFECTS_UNKNOWN' });
    }
    if ((assignment.pauseContinuation?.kind === 'execution-budget' || assignment.interruptedContinuation) && !isReadOnlyWorkerTool(execution.name)
      && previousCalls.has(signature(execution.name, execution.arguments))) {
      throw Object.assign(new Error('A previously dispatched action cannot be replayed during correction; inspect its saved outcome before proceeding'), { code: 'ACTION_REPLAY_BLOCKED' });
    }
    const policy = await readPolicy();
    const ticket = workerAppliedTicket(database, assignment, execution);
    const permission = await authorizeAction({ policy, mandate: ticket.mandate, ticket, execution });
    execution.signal.throwIfAborted();
    const dispatch = async () => {
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
    };
    // Snapshot work may await disk IO: the final policy/fence validation must
    // happen after it, immediately before entering the official dispatcher.
    return permission?.allowed === true && withCheckpoint ? withCheckpoint(execution, dispatch) : dispatch();
  });
}
