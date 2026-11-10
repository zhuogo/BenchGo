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
    placement: ticket.mandate?.project ? 'project' : 'ungrouped' };
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

