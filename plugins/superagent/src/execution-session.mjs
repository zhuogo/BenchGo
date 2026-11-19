import { SUPERAGENT_ROLE_PROFILE } from './session-role-assembly.mjs';

const remotePlacement = (database, task, assignment) => (assignment && database.remoteExecution?.(assignment.id))
  || assignment?.remoteExecution || task.mandate?.execution || null;

function remoteSessionProjection(database, task, assignment, run) {
  const location = remotePlacement(database, task, assignment);
  if (!location) return null;
  const target = task.mandate?.execution || {};
  const sessionId = location.sessionId || null;
  const identity = { deviceId: location.deviceId || target.deviceId, hostId: location.hostId || target.hostId,
    authorizationId: location.authorizationId || target.authorizationId };
  const ownerHostId = task.ownerHostId || database.ownerHostId?.();
  const harness = target.config?.harness;
  return { available: !!(sessionId && location.executionId && ownerHostId && identity.deviceId && identity.hostId && identity.authorizationId), remote: true,
    taskId: task.id, title: task.title || task.target, ownerHostId,
    ...identity, deviceName: target.deviceName || target.name || identity.deviceId,
    executionId: location.executionId || null, sessionId, assignmentId: assignment?.id, runId: location.runId || run?.id,
    status: task.status, phase: location.phase || 'prepared', observedAt: location.observedAt || null,
    observed: location.available === true && !!location.observedAt, code: location.code,
    reason: sessionId ? '远端执行会话只读，请在原任务补充或调整要求。' : '远端执行会话尚未就绪，请稍后重试。',
    ...(['codex', 'claude'].includes(harness) ? { nativeWorker: true, harness } : {}),
    placement: task.mandate?.project ? 'project' : 'ungrouped', promptable: false };
}

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
  const owned = new Set(), executions = new Map(), remoteSessions = [];
  const add = id => { if (typeof id === 'string' && id) owned.add(id); };
  add(state.mainSessionId);
  for (const thread of state.threads || []) add(thread.sessionId);
  for (const ids of Object.values(state.sessionLineage || {})) for (const id of ids) add(id);
  const roles = new Map(database.listSessionRoles().map(role => [role.sessionId, role]));
  for (const id of roles.keys()) add(id);
  const privateIds = new Set([...owned].filter(id => !roles.has(id) || roles.get(id).role === 'router'));
  const headers = new Map(records.map(row => [row.header.id, row.header]));
  const projections = new Map(database.executionProjections().map(row => [row.sessionId, row]));
  for (const id of projections.keys()) add(id);
  for (let offset = 0; ; offset += 100) {
    const tasks = database.listTasks({ limit: 100, offset });
    for (const task of tasks) for (const assignment of database.assignments(task.id)) {
      const runs = database.runs(assignment.id);
      if (remotePlacement(database, task, assignment)) {
        const run = runs.findLast(item => item.fence === assignment.fence) || runs.at(-1);
        const entry = remoteSessionProjection(database, task, assignment, run);
        if (entry.sessionId) remoteSessions.push({ ...entry, role: 'worker', parentSessionId: null, runState: run?.state });
        continue;
      }
      for (const run of runs) {
        add(run.sessionId);
        const role = roles.get(run.sessionId);
        if (!role || role.role === 'worker' && role.taskId === task.id && role.assignmentId === assignment.id && role.runId === run.id)
          executions.set(run.sessionId, { task, assignment, run, role: 'worker', parentSessionId: null });
      }
    }
    if (tasks.length < 100) break;
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
      || role.runId !== parent.run.id || role.taskId !== parent.task.id || role.assignmentId !== parent.assignment.id)) continue;
    const projection = projections.get(header.id);
    if (projection && (projection.parentSessionId !== header.parentSession || projection.runId !== parent.run.id
      || projection.taskId !== parent.task.id || projection.assignmentId !== parent.assignment.id)) continue;
    executions.set(header.id, { ...parent, role: 'child-worker', parentSessionId: header.parentSession });
    executionQueue.push(header.id);
  }
  const sessions = [];
  for (const [sessionId, { task, assignment, run, role, parentSessionId }] of executions) {
    if (!headers.has(sessionId)) continue;
    // Input admission belongs to the original official session, including cold runs.
    const promptable = true;
    sessions.push({ available: true, sessionId, taskId: task.id, title: task.title || task.target,
      assignmentId: assignment.id, runId: run.id, role, parentSessionId, status: task.status, runState: run.state,
      placement: task.mandate?.project ? 'project' : 'ungrouped', promptable });
  }
  return { privateSessionIds: [...privateIds], ownedSessionIds: [...owned], sessions: [...sessions, ...remoteSessions], executions, roles, projections, headers };
}

/** Cold owned sessions stay owned even before their first assembly audit. */
export async function readOwnedSessionRole({ store, sessionId, listSessions }) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const database = store.orchestration, saved = database.getSessionRole(sessionId);
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
    const { role, parentSessionId, task, assignment, run } = execution;
    const identity = { role, taskId: task.id, assignmentId: assignment.id, runId: run.id,
      ...(parentSessionId ? { parentSessionId } : {}) };
    const result = pending(identity);
    if (role === 'child-worker') Object.assign(result, { expected: null, actual: null, status: 'ready', reason: null });
    return result;
  }
  const projection = inventory.projections.get(sessionId);
  if (projection) {
    const root = inventory.executions.get(projection.rootSessionId);
    if (root && root.run.id === projection.runId && root.task.id === projection.taskId && root.assignment.id === projection.assignmentId)
      return blocked({ role: sessionId === root.run.sessionId ? 'worker' : 'child-worker', taskId: root.task.id,
        assignmentId: root.assignment.id, runId: root.run.id, ...(projection.parentSessionId ? { parentSessionId: projection.parentSessionId } : {}) },
      '该历史执行会话缺少可核验的原生会话目录记录，请从所属任务查看执行记录。');
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

/** Resolve only persisted Task/Assignment/Run ownership, never UI input. */
export function findExecutionSessionOwner(database, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  for (let offset = 0; ; offset += 100) {
    const tasks = database.listTasks({ limit: 100, offset });
    for (const task of tasks) for (const assignment of database.assignments(task.id)) {
      if (remotePlacement(database, task, assignment)) continue;
      const run = database.runs(assignment.id).find(item => item.sessionId === sessionId);
      if (run) return { task, assignment, run };
    }
    if (tasks.length < 100) break;
  }
  return null;
}

export function executionSessionProjection(database, taskId) {
  const task = database.getTask(taskId);
  if (!task) return null;
  const assignments = database.assignments(taskId);
  const latest = assignments.at(-1);
  if (!latest && task.mandate?.execution) return remoteSessionProjection(database, task);
  if (latest && remotePlacement(database, task, latest)) {
    const runs = database.runs(latest.id);
    return remoteSessionProjection(database, task, latest, runs.findLast(run => run.fence === latest.fence) || runs.at(-1));
  }
  const runs = assignments.flatMap(assignment => database.runs(assignment.id).map(run => ({ assignment, run })));
  const current = runs.findLast(({ assignment, run }) => run.fence === assignment.fence) || runs.at(-1);
  if (!current) return { available: false, reason: 'execution-session-unavailable' };
  const model = database.getWorkerExecutionState?.(current.run.id)?.models?.[0];
  const nativeWorker = ['codex', 'claude'].includes(model?.harness);
  return { available: true, taskId, title: task.title || task.target, sessionId: current.run.sessionId,
    assignmentId: current.assignment.id, runId: current.run.id, status: task.status,
    ...(nativeWorker ? { nativeWorker: true, harness: model.harness, promptable: false } : {}),
    placement: task.mandate?.project ? 'project' : 'ungrouped' };
}

export async function readNativeWorkerSession({ ctx, database, taskId, sessionId, after = 0, signal }) {
  const remote = database.remoteExecutionBySession?.(sessionId);
  if (remote) {
    const task = database.getTask(taskId), target = task?.mandate?.execution;
    const assignment = database.getAssignment(remote.assignmentId);
    if (assignment?.taskId !== taskId || !['codex', 'claude'].includes(target?.config?.harness)) throw new Error('无法定位任务的外部执行记录');
    const link = ctx.get?.('benchgoLink');
    if (!link?.callDevice) throw new Error('跨设备连接不可用');
    const reply = await link.callDevice({ deviceId: remote.deviceId, expectedHostId: remote.hostId, expectedAuthorizationId: remote.authorizationId,
      input: { action: 'execution', version: target.protocolVersion, operation: 'get', executionId: remote.executionId, after, limit: 100 }, signal });
    const { execution, events, cursor } = reply;
    if (reply.version !== target.protocolVersion || execution?.executionId !== remote.executionId || execution.sessionId !== sessionId
      || execution.identity?.taskId !== taskId || execution.identity.ownerHostId !== task.ownerHostId
      || execution.identity.assignmentId !== remote.assignmentId || execution.identity.runId !== remote.runId || execution.identity.fence !== remote.fence)
      throw new Error('目标执行记录身份不匹配');
    return { status: execution.phase === 'accepted' ? 'connecting' : execution.phase, cursor, summary: execution.evidence?.summary,
      events: events.filter(event => event.kind === 'progress' && typeof event.data?.text === 'string')
        .map(event => ({ seq: event.seq, text: event.data.text.slice(-12_000) })) };
  }
  const owned = findExecutionSessionOwner(database, sessionId);
  const model = owned && database.getWorkerExecutionState?.(owned.run.id)?.models?.[0];
  const commander = ctx.get?.('commander');
  const session = owned && commander?.executionSession(owned.run.id);
  if (owned?.task.id !== taskId || !['codex', 'claude'].includes(model?.harness) || session?.id !== sessionId) {
    throw new Error('无法定位任务的外部执行记录');
  }
  const page = commander.events(sessionId, after, 200);
  return { status: session.status, cursor: page.cursor, truncated: page.truncated, events: page.events
    .filter(event => event.type === 'text.delta' && typeof event.data?.text === 'string')
    .map(event => ({ seq: event.seq, text: event.data.text.slice(-12_000) })) };
}

/** Official membership validates the bound project's execution cwd against
 * workspace.path; the Run directory separately retains task artifacts. */
export async function attachExecutionSession(ctx, agent, { task, run }) {
  if (task.mandate?.execution) throw new Error('远端执行会话不能绑定到宿主的本机工作区');
  const registry = ctx.get?.('workspaceRegistry') || ctx.workspaceRegistry;
  const project = task.mandate?.project;
  let workspace;
  if (project) {
    if (!registry?.resolveByPath) throw new Error('Official workspace registry is unavailable');
    workspace = await registry.resolveByPath(project.path) || await registry.create(project.path);
    await workspace.attachSession(run.sessionId);
  }
  return workspace;
}

