import { SUPERAGENT_ROLE_PROFILE } from './session-role-assembly.mjs';

/** Product entry ownership includes previous Router sessions, never Worker runs. */
export function privateRouterSessionIds(state) {
  const threads = state.threads || [];
  const channels = new Set(threads.filter(thread => thread.sourceKey || thread.source?.channel && thread.source.channel !== 'desktop').map(thread => thread.id));
  return [...new Set([state.mainSessionId,
    ...threads.filter(thread => !channels.has(thread.id)).map(thread => thread.sessionId),
    ...Object.entries(state.sessionLineage || {}).filter(([threadId]) => !channels.has(threadId)).flatMap(([, ids]) => ids),
  ].filter(id => typeof id === 'string' && id))];
}

/** Router surfaces stay private; execution ownership never hides official sessions.
 * Only official subagents inherit execution ownership. Ordinary forks stay native. */
export function superagentSessionInventory({ state, database, records = [] }) {
  const owned = new Set(), executions = new Map();
  const add = id => { if (typeof id === 'string' && id) owned.add(id); };
  add(state.mainSessionId);
  for (const thread of state.threads || []) add(thread.sessionId);
  for (const ids of Object.values(state.sessionLineage || {})) for (const id of ids) add(id);
  const roles = new Map((database?.listSessionRoles?.() || []).map(role => [role.sessionId, role]));
  for (const id of roles.keys()) add(id);
  const privateIds = new Set([...owned].filter(id => !roles.has(id) || roles.get(id).role === 'router'));
  const headers = new Map(records.map(row => [row.header.id, row.header]));
  const projections = new Map((database?.executionProjections?.() || []).map(row => [row.sessionId, row]));
  for (const id of projections.keys()) add(id);
  for (let offset = 0; database?.listTickets; offset += 100) {
    const tickets = database.listTickets({ limit: 100, offset });
    for (const ticket of tickets) for (const assignment of database.assignments(ticket.id)) for (const run of database.runs(assignment.id)) {
      add(run.sessionId);
      const role = roles.get(run.sessionId);
      if (!role || role.role === 'worker' && role.ticketId === ticket.id && role.assignmentId === assignment.id && role.runId === run.id)
        executions.set(run.sessionId, { ticket, assignment, run, role: 'worker', parentSessionId: null });
    }
    if (tickets.length < 100) break;
  }
  const children = new Map();
  for (const header of headers.values()) {
    if (header.origin !== 'subagent' || !header.parentSession) continue;
    const siblings = children.get(header.parentSession) || [];
    siblings.push(header); children.set(header.parentSession, siblings);
  }
  const privateQueue = [...owned];
  for (let index = 0; index < privateQueue.length; index++) for (const header of children.get(privateQueue[index]) || []) {
    if (!owned.has(header.id)) { owned.add(header.id); privateQueue.push(header.id); }
  }
  // Separate traversal: historical role rows may list a child before its parent.
  const executionQueue = [...executions.keys()];
  for (let index = 0; index < executionQueue.length; index++) for (const header of children.get(executionQueue[index]) || []) {
    const parent = executions.get(header.parentSession), role = roles.get(header.id);
    if (executions.has(header.id)) continue;
    if (role && (role.role !== 'child-worker' || role.parentSessionId !== header.parentSession
      || role.runId !== parent.run.id || role.ticketId !== parent.ticket.id || role.assignmentId !== parent.assignment.id)) continue;
    const projection = projections.get(header.id);
    if (projection && (projection.parentSessionId !== header.parentSession || projection.runId !== parent.run.id
      || projection.ticketId !== parent.ticket.id || projection.assignmentId !== parent.assignment.id)) continue;
    executions.set(header.id, { ...parent, role: 'child-worker', parentSessionId: header.parentSession });
    executionQueue.push(header.id);
  }
  const sessions = [];
  for (const [sessionId, { ticket, assignment, run, role, parentSessionId }] of executions) {
    if (!headers.has(sessionId)) continue;
    // Input admission belongs to the original official session, including cold runs.
    const promptable = true;
    sessions.push({ available: true, sessionId, ticketId: ticket.id, title: ticket.title || ticket.target,
      assignmentId: assignment.id, runId: run.id, role, parentSessionId, status: ticket.status, runState: run.state,
      placement: ticket.mandate?.project ? 'project' : 'ungrouped', promptable });
  }
  return { privateSessionIds: [...privateIds], ownedSessionIds: [...owned], sessions, executions, roles, projections, headers };
}

/** Cold owned sessions stay owned even before their first assembly audit. */
export async function readOwnedSessionRole({ store, sessionId, listSessions }) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const database = store.orchestration, saved = database?.getSessionRole?.(sessionId);
  if (saved) return saved;
  const state = await store.getState();
  const threadOf = id => state.mainSessionId === id ? 'main' : state.threads?.find(row => row.sessionId === id)?.id
    ?? Object.entries(state.sessionLineage || {}).find(([, ids]) => ids.includes(id))?.[0];
  const pending = identity => ({ sessionId, ...identity, expected: { ...SUPERAGENT_ROLE_PROFILE }, actual: null,
    status: 'pending', reason: { code: 'ROLE_NOT_VERIFIED', message: '自有会话尚未核验实际角色装配' }, updatedAt: null });
  const blocked = (identity, message) => ({ ...pending(identity), status: 'blocked',
    reason: { code: 'OWNED_SESSION_UNAVAILABLE', message } });
  const thread = threadOf(sessionId);
  if (thread) return pending({ role: 'router', threadId: thread });
  const records = listSessions ? await listSessions() : [];
  const inventory = superagentSessionInventory({ state, database, records });
  if (!inventory.ownedSessionIds.includes(sessionId)) return null;
  const execution = inventory.executions.get(sessionId);
  if (execution) {
    const { role, parentSessionId, ticket, assignment, run } = execution;
    const identity = { role, ticketId: ticket.id, assignmentId: assignment.id, runId: run.id,
      ...(parentSessionId ? { parentSessionId } : {}) };
    const result = pending(identity);
    if (role === 'child-worker') Object.assign(result, { expected: null, actual: null, status: 'ready', reason: null });
    return result;
  }
  const projection = inventory.projections.get(sessionId);
  if (projection) {
    const root = inventory.executions.get(projection.rootSessionId);
    if (root && root.run.id === projection.runId && root.ticket.id === projection.ticketId && root.assignment.id === projection.assignmentId)
      return blocked({ role: sessionId === root.run.sessionId ? 'worker' : 'child-worker', ticketId: root.ticket.id,
        assignmentId: root.assignment.id, runId: root.run.id, ...(projection.parentSessionId ? { parentSessionId: projection.parentSessionId } : {}) },
      '该历史执行会话缺少可核验的原生会话目录记录，请从所属工单查看执行记录。');
  }
  // Follow only official subagent edges, retaining native child-session behavior.
  const visited = new Set();
  let id = sessionId;
  while (!visited.has(id)) {
    visited.add(id);
    const ancestorThread = threadOf(id), ancestorRole = inventory.roles.get(id);
    if (id === sessionId && ancestorRole?.role === 'router') return blocked({ role: 'router', threadId: ancestorRole.threadId }, '请在 SuperAgent 原对话继续。');
    if (ancestorThread || ancestorRole?.role === 'router') return { sessionId, role: 'child-worker',
      parentSessionId: inventory.headers.get(sessionId)?.parentSession, expected: null, actual: null, status: 'ready', reason: null };
    const header = inventory.headers.get(id);
    if (header?.origin !== 'subagent' || !header.parentSession) break;
    id = header.parentSession;
  }
  return blocked({ role: 'child-worker' }, '该 SuperAgent 历史会话归属尚无法完整核验，请从 SuperAgent 查看原任务。');
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
    placement: ticket.mandate?.project ? 'project' : 'ungrouped' };
}

/** Official membership validates the bound project's execution cwd against
 * workspace.path; the Run directory separately retains task artifacts. */
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

