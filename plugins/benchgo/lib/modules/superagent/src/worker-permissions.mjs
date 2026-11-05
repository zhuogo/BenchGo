import { executionEffects, isReadOnlyWorkerTool } from './execution-effects.mjs';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const signature = (name, args) => {
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* Opaque tool input stays literal. */ } }
  return JSON.stringify([name, canonical(args)]);
};

/** Install on a single Harness worker scope; never use frozen prompt context as authority. */
export function installWorkerPermissionGate(scope, { database, assignment, readPolicy, authorizeAction, withCheckpoint, priorToolEvents = [], leaseMs = 60000 }) {
  const previousCalls = new Set(priorToolEvents.flatMap(event => event.type === 'assistant/message'
    ? (event.data?.message?.content || []).filter(block => block.type === 'tool-call').map(block => signature(block.name, block.arguments)) : []));
  const previousEffects = executionEffects({ events: priorToolEvents });
  return scope.on('tools/execute', async (execution, next) => {
    execution.signal.throwIfAborted();
    // Automatic evidence repair must not replay a previously completed side effect.
    // These are the official read-only tool identities, not model-selected aliases.
    if (assignment.reviewRepair && !isReadOnlyWorkerTool(execution.name)) {
      throw new Error('Internal evidence repair permits read-only lookup tools only');
    }
    if (previousEffects.effectsVerified === false && !isReadOnlyWorkerTool(execution.name)) {
      throw Object.assign(new Error('Previous external effects remain unverified; only read-only verification is permitted'), { code: 'EXECUTION_EFFECTS_UNKNOWN' });
    }
    if ((assignment.reviewContinuation || assignment.pauseContinuation?.kind === 'execution-budget') && !isReadOnlyWorkerTool(execution.name)
      && previousCalls.has(signature(execution.name, execution.arguments))) {
      throw Object.assign(new Error('A previously dispatched action cannot be replayed during correction; inspect its saved outcome before proceeding'), { code: 'ACTION_REPLAY_BLOCKED' });
    }
    const policy = await readPolicy();
    const ticket = database.getTicket(assignment.ticketId);
    if (!ticket) throw new Error('Worker 工单不存在');
    const permission = await authorizeAction({ policy, mandate: ticket.mandate, ticket, execution });
    execution.signal.throwIfAborted();
    const dispatch = async () => {
    const current = await readPolicy();
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
