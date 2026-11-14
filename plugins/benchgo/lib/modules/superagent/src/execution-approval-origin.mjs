import { taskExecutionBlocked } from './task-lifecycle.mjs';
import { ownsDesktopTask } from './desktop-task-owner.mjs';
import { validateTaskMandate } from './assessment-policy.mjs';
import { workerAppliedTask } from './worker-permissions.mjs';
import { channelSessionKey } from './channel-policy.mjs';

// Historical or incomplete records are not an identity. Skip only that source;
// never infer a missing type or let one invalid record break the whole inbox.
function verifiedChannelKey(source) {
  if (typeof source?.channel !== 'string' || !source.channel || source.channel === 'desktop') return null;
  try { return channelSessionKey(source); }
  catch { return null; }
}
function sourceStillMatches(thread) {
  return thread.sourceKey ? thread.sourceKey === verifiedChannelKey(thread.source)
    : !thread.source?.channel || thread.source.channel === 'desktop';
}

/** Read-only presentation links. The official Worker request remains the only approval. */
export function executionApprovalOrigins({ database, ownerScope, ownerSessionId, policy, now = Date.now(), toolName = 'assistant_external_action', channelSource }) {
  if (!ownerSessionId || !ownerScope?.threadId || !ownerScope.sessionIds?.includes(ownerSessionId)) return [];
  const channelKey = channelSource ? verifiedChannelKey(channelSource) : null;
  if (channelSource && !channelKey) return [];
  const origins = [];
  for (let offset = 0; ; offset += 100) {
    const tasks = database.listTasks({ ...(!channelSource ? { ownerSessionIds: ownerScope.sessionIds, ownerThreadId: ownerScope.threadId } : {}),
      archived: false, limit: 100, offset });
    for (const task of tasks) {
      if (!['running', 'waiting'].includes(task.status) || taskExecutionBlocked(task) || !task.mandate) continue;
      const owned = channelSource ? verifiedChannelKey(task.mandate.source) === channelKey : ownsDesktopTask(task, ownerScope);
      if (!owned
        || !validateTaskMandate(task.mandate, { policy })) continue;
      for (const assignment of database.assignments(task.id)) {
        if (assignment.state !== 'claimed' || !assignment.owner || !Number.isFinite(assignment.leaseUntil) || assignment.leaseUntil <= now) continue;
        let applied;
        try {
          // Listing candidate sessions never grants a tool. At decision time the
          // actual PendingApproval tool name must pass the live capability gate.
          applied = toolName === null ? { ...task, ...database.appliedTaskSnapshot(assignment.id) }
            : workerAppliedTask(database, assignment, { name: toolName });
        }
        catch { continue; }
        if (!validateTaskMandate(applied.mandate, { policy })) continue;
        for (const run of database.runs(assignment.id)) {
          if (!run.sessionId || !['submitted', 'running'].includes(run.state)
            || run.owner !== assignment.owner || run.fence !== assignment.fence) continue;
          origins.push({ taskId: task.id, title: task.title || task.target, assignmentId: assignment.id,
            runId: run.id, sessionId: run.sessionId, ownerSessionId, ownerThreadId: ownerScope.threadId });
        }
      }
    }
    if (tasks.length < 100) break;
  }
  return origins;
}

/** The review inbox is a projection of this profile's existing official sessions,
 * not another approval store. Only the official PendingApproval can be answered. */
export async function resolveApprovalOrigins({ store, engine, input = {}, peer, readPolicy }) {
  if (peer?.principal?.kind !== 'owner') throw Object.assign(new Error('仅主人可查看待审核事项'), { status: 403 });
  if (input.sessionId !== undefined && (typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 200))
    throw Object.assign(new Error('无效审核会话标识'), { status: 400 });
  if (input.toolName !== undefined && (typeof input.toolName !== 'string' || !input.toolName || input.toolName.length > 200 || !input.sessionId))
    throw Object.assign(new Error('复核审批工具时必须指定原会话及工具名'), { status: 400 });
  const state = await store.getState(), origins = [];
  const sources = [
    ...(state.mainSessionId ? [{ id: 'main', sessionId: state.mainSessionId, title: '主聊天' }] : []),
    ...(state.threads || []).filter(thread => thread.id !== 'main' && thread.sessionId && !thread.archived),
  ];
  for (const source of sources) {
    if (!sourceStillMatches(source)) continue;
    const sourceTitle = source.title || '旁聊';
    if (!input.sessionId || input.sessionId === source.sessionId) origins.push({ kind: 'router', title: sourceTitle,
      sourceTitle, sessionId: source.sessionId, ownerSessionId: source.sessionId, ownerThreadId: source.id });
    const ownerScope = await engine.taskOwnerScope(source.id);
    const workers = executionApprovalOrigins({ database: store.orchestration, ownerScope,
      ownerSessionId: source.sessionId, policy: await readPolicy(source.id), toolName: input.toolName ?? null,
      ...(source.sourceKey ? { channelSource: source.source } : {}) });
    for (const worker of workers) if (!input.sessionId || input.sessionId === worker.sessionId)
      origins.push({ ...worker, kind: 'worker', sourceTitle });
  }
  // A clear/archive can complete during the asynchronous policy/scope reads.
  const latest = await store.getState();
  return { origins: origins.filter(origin => origin.ownerThreadId === 'main'
    ? latest.mainSessionId === origin.ownerSessionId
    : (latest.threads || []).some(thread => !thread.archived && thread.id === origin.ownerThreadId
      && thread.sessionId === origin.ownerSessionId && sourceStillMatches(thread))) };
}
