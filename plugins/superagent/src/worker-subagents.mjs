import { installGoalBudgetUsage, installGoalUsageMeter } from './goal-budget-usage.mjs';

/** Official Harness owns delegation, context inheritance, tools and child lifecycle. */
export function installWorkerSubagents(scope, worker, { ctx, database, assignment }) {
  const children = new Set();
  scope.systemPrompt.section({ name: 'benchgo-worker-delegation', order: -110, interpolate: false,
    text: 'Use official Harness subagents when work can be split independently, investigated in parallel, or benefits from independent verification. Choose spawn or fork and coordinate through the official tools as appropriate. Integrate the results into this Ticket and finish or stop delegated work before reporting completion.' });
  const listen = ({ agent }) => {
    const header = agent.session?.header;
    if (header?.origin !== 'subagent') return;
    const parent = database.getSessionRole?.(header.parentSession);
    const root = database.getSessionRole?.(worker.id);
    const ownedParent = parent?.role === 'child-worker' && root && parent.runId === root.runId
      && parent.assignmentId === root.assignmentId && parent.ticketId === root.ticketId;
    if (header.parentSession !== worker.id && !children.has(header.parentSession) && !ownedParent) return;
    children.add(agent.id);
    if (parent) {
      database.bindSessionRole({ role: 'child-worker', sessionId: agent.id,
        ticketId: parent.ticketId, assignmentId: parent.assignmentId, runId: parent.runId,
        parentSessionId: header.parentSession, expected: {} });
      database.recordSessionRole(agent.id, { status: 'ready', actual: null });
    }
    // Accounting observes official events; it neither selects nor gates child capabilities.
    installGoalBudgetUsage(agent.ctx, agent, { database, ticketId: assignment.ticketId });
    const usage = installGoalUsageMeter(agent.ctx, { database, ticketId: assignment.ticketId, sessionId: agent.id });
    agent.ctx.effect?.(() => () => usage.dispose());
  };
  const dispose = ctx.on('agent/created', listen, { global: true });
  scope.effect?.(() => dispose);
  return { dispose, drain: () => ctx.subagents?.drainDescendants([worker]), childSessionIds: () => [...children] };
}
