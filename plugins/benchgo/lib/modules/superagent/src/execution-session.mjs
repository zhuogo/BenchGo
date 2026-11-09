import { SUPERAGENT_ROLE_PROFILE } from './session-role-assembly.mjs';
const terminal = new Set(['completed', 'failed', 'cancelled', 'closed']);

/** Cold owned sessions stay owned even before their first assembly audit. */
export async function readOwnedSessionRole({ store, sessionId, readSession }) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const database = store.orchestration, saved = database?.getSessionRole?.(sessionId);
  if (saved) return saved;
  const state = await store.getState();
  const thread = state.mainSessionId === sessionId ? 'main' : state.threads?.find(row => row.sessionId === sessionId)?.id
    ?? Object.entries(state.sessionLineage || {}).find(([, ids]) => ids.includes(sessionId))?.[0];
  const pending = identity => ({ sessionId, ...identity, expected: { ...SUPERAGENT_ROLE_PROFILE }, actual: null,
    status: 'pending', reason: { code: 'ROLE_NOT_VERIFIED', message: '自有会话尚未核验实际角色装配' }, updatedAt: null });
  if (thread) return pending({ role: 'router', threadId: thread });
  if (!database) return null;
  const worker = findExecutionSessionOwner(database, sessionId);
  if (worker) return pending({ role: 'worker', ticketId: worker.ticket.id, assignmentId: worker.assignment.id, runId: worker.run.id });
  if (readSession) {
    const session = await readSession(sessionId);
    if (session?.header?.origin === 'subagent' && session.header.parentSession) {
      const parent = findExecutionSessionOwner(database, session.header.parentSession);
      if (parent) return { ...pending({ role: 'child-worker', ticketId: parent.ticket.id, assignmentId: parent.assignment.id,
        runId: parent.run.id, parentSessionId: session.header.parentSession }),
        expected: { ...SUPERAGENT_ROLE_PROFILE, permissionPreset: 'custom', approval: 'never', delegationApproval: 'parent-required' } };
    }
  }
  return null;
}

/** Resolve only persisted Ticket/Assignment/Run ownership, never UI input. */
export function findExecutionSessionOwner(database, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  for (let offset = 0; ; offset += 100) {
    const tickets = database.listTickets({ limit: 100, offset });
    for (const ticket of tickets) for (const assignment of database.assignments(ticket.id)) {
      const run = database.runs(assignment.id).find(item => item.sessionId === sessionId);
      if (run) return { ticket, assignment, run };
    }
    if (tickets.length < 100) break;
  }
  return null;
}

export function executionSessionProjection(database, ticketId) {
  const ticket = database.getTicket(ticketId);
  if (!ticket) return null;
  const runs = database.assignments(ticketId).flatMap(assignment => database.runs(assignment.id).map(run => ({ assignment, run })));
  const current = runs.findLast(({ assignment, run }) => run.fence === assignment.fence) || runs.at(-1);
  if (!current) return { available: false, reason: 'execution-session-unavailable' };
  return { available: true, ticketId, title: ticket.title || ticket.target, sessionId: current.run.sessionId,
    assignmentId: current.assignment.id, runId: current.run.id, status: ticket.status,
    placement: ticket.mandate?.project ? 'project' : 'ungrouped', closed: terminal.has(ticket.status) };
}

/** Official membership validates immutable header.cwd against workspace.path.
 * Isolated execution cwd remains the Run's own directory/worktree. */
export async function attachExecutionSession(ctx, agent, { ticket, run }) {
  const registry = ctx.get?.('workspaceRegistry') || ctx.workspaceRegistry;
  const project = ticket.mandate?.project;
  let workspace;
  if (project) {
    if (!registry?.resolveByPath) throw new Error('Official workspace registry is unavailable');
    workspace = await registry.resolveByPath(project.path) || await registry.create(project.path);
    await workspace.attachSession(run.sessionId);
  }
  return workspace;
}

/** Called only after delivery closes a Ticket and the Worker has stopped. */
export async function archiveClosedExecutionSessions(ctx, database, ticketId) {
  const ticket = database.getTicket(ticketId);
  if (!ticket || !terminal.has(ticket.status)) return false;
  const registry = ctx.get?.('workspaceRegistry') || ctx.workspaceRegistry;
  if (!registry?.archiveSession) throw new Error('Official workspace archival is unavailable');
  for (const assignment of database.assignments(ticketId)) for (const run of database.runs(assignment.id)) {
    if (run.sessionId) await registry.archiveSession(run.sessionId);
  }
  return true;
}
