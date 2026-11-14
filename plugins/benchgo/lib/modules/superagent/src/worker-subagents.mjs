import { installWorkerProgressPrompt } from './worker-progress.mjs';

/** Official Harness owns delegation, context inheritance, tools and child lifecycle. */
export function installWorkerSubagents(scope, worker, { ctx, database, assignment }) {
  const children = new Set();
  scope.systemPrompt.section({ name: 'benchgo-worker-delegation', order: -110, interpolate: false,
    text: 'Use official Harness subagents when work can be split independently, investigated in parallel, or benefits from independent verification. Choose spawn or fork and coordinate through the official tools as appropriate. Integrate the results into this Task and finish or stop delegated work before reporting completion.' });
  const listen = ({ agent }) => {
    const header = agent.session?.header;
    if (header?.origin !== 'subagent') return;
    const parent = database.getSessionRole(header.parentSession);
    const root = database.getSessionRole(worker.id);
    const ownedParent = parent?.role === 'child-worker' && root && parent.runId === root.runId
      && parent.assignmentId === root.assignmentId && parent.taskId === root.taskId;
    if (header.parentSession !== worker.id && !children.has(header.parentSession) && !ownedParent) return;
    children.add(agent.id);
    installWorkerProgressPrompt(agent.ctx);
    if (parent) {
      database.bindSessionRole({ role: 'child-worker', sessionId: agent.id,
        taskId: parent.taskId, assignmentId: parent.assignmentId, runId: parent.runId,
        parentSessionId: header.parentSession, expected: {} });
      database.recordSessionRole(agent.id, { status: 'ready', actual: null });
    }
  };
  const dispose = ctx.on('agent/created', listen, { global: true });
  scope.effect?.(() => dispose);
  return { dispose, drain: () => ctx.subagents?.drainDescendants([worker]), childSessionIds: () => [...children] };
}
