import { randomUUID } from 'node:crypto';
import { executionProjectionDefinition, executionProjectionKey, initialExecutionProjection as initialState,
  executionActivityTime as iso, executionStopStatus as stopStatus } from '../../base/shared/execution-projection.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled']);
const latest = (...values) => values.filter(Boolean).sort().at(-1) || null;

export function createTaskExecutionProgress({ ctx, database, now = Date.now, bootId = randomUUID() }) {
  const disposers = [], recovering = new Map(), shutdown = new AbortController();
  let handle, disposed = false, recoveryFailures = 0;
  const nativeRun = runId => ['codex', 'claude'].includes(database.getWorkerExecutionState?.(runId)?.models?.[0]?.harness);
  const on = (name, callback) => { const stop = ctx.on(name, callback, { global: true }); if (stop) disposers.push(stop); };
  const bindingOf = state => {
    const sessionId = state.parentSessionId || state.sessionId;
    if (database.remoteExecutionBySession?.(sessionId)) return null;
    const binding = database.getExecutionBinding(sessionId);
    return binding && database.getAssignment(binding.assignmentId)?.executor === 'remote' ? null : binding;
  };
  function save(state, cursor, { live, kind, sourceDurability = 'observed', missingReason, complete = true } = {}) {
    const binding = bindingOf(state);
    if (!binding || state.parentSessionId && state.parentSessionId !== binding.sessionId) return null;
    const prior = database.getExecutionProjection(state.sessionId), event = state.lastEvent;
    // A historical catalog is not a new delegation. Only an observed activation
    // can rebind an existing child to a different domain Run.
    if (state.parentSessionId && prior && prior.runId !== binding.runId && kind !== 'subagent/start') return prior;
    return database.recordExecutionProjection({ ...binding, sessionId: state.sessionId,
      parentSessionId: state.parentSessionId, rootSessionId: binding.sessionId, cursor,
      // A cold observation can contain official synthetic interrupted-turn
      // closers. Reading it does not prove a flush of that complete cursor.
      flushedCursor: prior?.flushedCursor ?? -1, sourceDurability,
      complete: complete && !state.childrenTruncated && !state.tools.incomplete,
      missingReason: missingReason || (state.childrenTruncated || state.tools.incomplete ? 'projection-capacity' : null), state,
      live: live || prior?.live || { status: 'unknown', observedAt: null, bootId },
      kind: kind || event?.kind || 'execution', fact: { kind: kind || event?.kind || 'execution', ...(event?.category ? { category: event.category } : {}),
        counterScope: 'session', counts: { calls: state.tools.calls, results: state.tools.results, errors: state.tools.errors },
        evidenceRefs: event ? [{ sessionId: state.sessionId, seq: event.seq }] : [] } });
  }
  function observeLive(session, live, kind) {
    if (disposed || !handle || !session) return;
    save(handle.stateOf(session), session.seq - 1, { live, kind });
  }
  async function recover(sessionId) {
    if (disposed || shutdown.signal.aborted) return;
    const binding = database.getExecutionBinding(sessionId);
    if (database.remoteExecutionBySession?.(sessionId) || binding && (database.getAssignment(binding.assignmentId)?.executor === 'remote'
      || nativeRun(binding.runId))) return;
    if (recovering.has(sessionId)) return recovering.get(sessionId);
    const operation = (async () => {
      let observation;
      try {
        observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'all', signal: shutdown.signal });
        if (disposed) return;
        const state = observation.projections?.values?.[executionProjectionKey];
        if (!state) throw Object.assign(new Error('Execution projection is unavailable'), { code: 'PROJECTION_UNAVAILABLE' });
        const prior = database.getExecutionProjection(sessionId);
        if (prior && observation.cursor < prior.cursor) {
          database.recordExecutionProjection({ ...prior, complete: false, missingReason: 'official-log-behind-observation',
            kind: 'recovery-unavailable', fact: { kind: 'recovery-unavailable' } });
        } else save(state, observation.cursor, { sourceDurability: observation.source === 'prepared' ? 'persisted' : 'observed' });
        if (!state.parentSessionId && bindingOf(state)) for (const child of state.children) await recover(child.sessionId);
      } catch (error) {
        if (disposed || shutdown.signal.aborted) return;
        recoveryFailures++;
        const prior = database.getExecutionProjection(sessionId), binding = database.getExecutionBinding(sessionId);
        if (prior) database.recordExecutionProjection({ ...prior, complete: false, missingReason: 'official-history-unavailable',
          kind: 'recovery-unavailable', fact: { kind: 'recovery-unavailable' } });
        else if (binding) save(initialState({ id: sessionId }, 0), -1, { complete: false, missingReason: 'official-history-unavailable' });
        ctx.logger?.warn?.('Execution fact recovery unavailable (' + (error.code || 'SESSION_READ_FAILED') + ')');
      } finally { observation?.[Symbol.dispose]?.(); }
    })();
    recovering.set(sessionId, operation);
    try { return await operation; } finally { if (recovering.get(sessionId) === operation) recovering.delete(sessionId); }
  }
  const ready = (async () => {
    if (!ctx.sessionProjections?.register || !ctx.sessionQuery?.observeSession) throw new Error('Execution facts require official Session projections and observations');
    handle = await ctx.sessionProjections.register(executionProjectionDefinition);
    if (disposed) { await handle.dispose(); return; }
    on('session/created', session => observeLive(session));
    on('session/event', session => observeLive(session));
    on('agent/status', ({ agent, status }) => observeLive(agent.session, { ...(database.getExecutionProjection(agent.id)?.live || {}), status, observedAt: iso(now()), bootId }, 'agent/status'));
    on('agent/created', ({ agent }) => observeLive(agent.session, { status: agent.status || 'unknown', observedAt: iso(now()), bootId }, 'agent/created'));
    on('agent/disposed', ({ agent }) => observeLive(agent.session, { ...(database.getExecutionProjection(agent.id)?.live || {}), status: 'disposed', observedAt: iso(now()), bootId }, 'agent/disposed'));
    on('agent/assistant-stream', ({ agent, frame }) => {
      if (!['start', 'end'].includes(frame.type)) return;
      const prior = database.getExecutionProjection(agent.id)?.live || {};
      observeLive(agent.session, { ...prior, status: agent.status || 'running', observedAt: iso(now()), bootId,
        request: { state: frame.type === 'start' ? 'inflight' : 'settled', startedAt: frame.type === 'start' ? iso(now()) : prior.request?.startedAt || null,
          settledAt: frame.type === 'end' ? iso(now()) : null, deadline: null } }, 'request/' + frame.type);
    });
    for (const type of ['start', 'end']) on('subagent/' + type, info => {
      if (!bindingOf({ sessionId: info.parentSessionId })) return;
      const prior = database.getExecutionProjection(info.id), session = ctx.agents?.get?.(info.id)?.session;
      if (type === 'end' && prior?.live?.activationId && prior.live.activationId !== info.runId) return;
      const state = session ? handle.stateOf(session) : prior?.state || initialState({ id: info.id, origin: 'subagent', parentSession: info.parentSessionId }, 0);
      save(state, session ? session.seq - 1 : prior?.cursor ?? -1, { kind: 'subagent/' + type, live: { status: type === 'start' ? 'running' : 'idle',
        observedAt: iso(now()), bootId, activationId: info.runId,
        ...(type === 'end' ? { settledReason: ['completed', 'aborted', 'error', 'max-tokens', 'refusal'].includes(info.stopReason) ? info.stopReason : 'unknown' } : {}) } });
    });
    // Listener first, immutable baseline second. Late/duplicate publications read
    // the official full cut, never fold an out-of-order notification themselves.
    for (const binding of database.executionBindings()) await recover(binding.sessionId);
    for (const agent of ctx.agents?.list?.() || []) observeLive(agent.session, { ...(database.getExecutionProjection(agent.id)?.live || {}),
      status: agent.status || 'unknown', observedAt: iso(now()), bootId });
  })();
  function batch(taskId) {
    const agents = new Map((ctx.agents?.list?.() || []).map(agent => [agent.id, agent]));
    const records = new Map(database.executionProjections({ taskId }).map(row => [row.sessionId, row]));
    return (task, assignments = task.assignments || []) => {
      const revision = task.instructionRevision ?? 1, assignment = assignments.filter(row => row.taskId === task.id).at(-1);
      const run = assignment && database.runs(assignment.id).filter(row => row.fence === assignment.fence).at(-1);
      if (!run) return null;
      const worker = records.get(run.sessionId);
      const current = worker?.runId === run.id && worker?.fence === assignment.fence;
      const native = nativeRun(run.id) ? ctx.get?.('commander')?.executionSession?.(run.id) : null;
      const live = agents.get(run.sessionId) || native || (current && worker.live?.bootId === bootId ? worker.live : null);
      const historyOf = record => record?.runId === run.id ? (record.state?.activityHistory || [])
        .filter(row => row.time && row.time >= run.createdAt) : [];
      const completed = task.status === 'completed' || run.state === 'completed';
      const phase = completed ? 'finished' : run.state === 'prepared' ? 'preparing'
        : terminal.has(run.state) ? 'finished' : run.state === 'waiting' ? 'waiting' : run.state === 'uncertain' ? 'unknown' : 'executing';
      let status = completed ? 'completed' : terminal.has(run.state) ? run.state : live?.status === 'running' ? 'running'
        : ['idle', 'waiting'].includes(live?.status) || run.state === 'waiting' ? 'waiting'
          : current && terminal.has(worker?.state?.status) ? worker.state.status : 'unknown';
      if (!completed && run.state === 'uncertain') status = 'unknown';
      const childRecords = [...records.values()].filter(row => row.parentSessionId === run.sessionId && row.runId === run.id);
      const childIndex = new Map((worker?.state?.children || []).filter(child => !records.has(child.sessionId)
        || records.get(child.sessionId).runId === run.id).map(child => [child.sessionId, { sessionId: child.sessionId, cursor: null }]));
      for (const child of childRecords) childIndex.set(child.sessionId, child);
      const children = [...childIndex.values()]
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId)).map((child, index) => {
          const known = worker?.state?.children.find(item => item.sessionId === child.sessionId), childLive = agents.get(child.sessionId);
          const ended = child.live?.settledReason, notice = !child.live?.activationId && known?.notice;
          const childStatus = ended ? stopStatus(ended) : childLive?.status === 'running' ? 'running'
            : notice ? stopStatus(notice.reason) : childLive?.status === 'idle' ? 'waiting' : 'unknown';
          return { id: child.sessionId, label: '子 Worker ' + (index + 1), status: childStatus,
            activity: childStatus === 'completed' ? '并行任务已完成' : childStatus === 'failed' ? '并行任务执行失败'
              : childStatus === 'cancelled' ? '并行任务已停止' : childStatus === 'unknown' ? '子任务状态待核实' : child.state?.activity || '正在处理子任务',
            activitySource: ['running', 'waiting'].includes(childStatus) && child.state?.activitySource === 'report' ? 'report' : 'runtime',
            updatedAt: latest(child.state?.updatedAt, child.live?.observedAt), activationId: child.live?.activationId || null,
            history: historyOf(child), historyTruncated: child.state?.activityHistoryTruncated === true,
            historical: child.fence !== assignment.fence, sourceSeq: child.cursor };
        });
      const childCounts = { total: children.length, running: 0, completed: 0, failed: 0 };
      for (const child of children) if (child.status in childCounts) childCounts[child.status]++;
      const complete = !!current && worker.complete && children.every(child => records.get(child.id)?.complete);
      const text = completed ? '执行已结束' : phase === 'preparing' ? '正在准备执行环境'
        : run.state === 'completed' ? '执行已结束' : run.state === 'failed' ? '执行失败' : run.state === 'cancelled' ? '执行已停止'
          : status === 'unknown' ? '执行状态待核实' : current && worker.state?.activity || '执行动态暂不可用';
      return { taskId: task.id, assignmentId: assignment.id, runId: run.id, sessionId: run.sessionId, fence: assignment.fence,
        instructionRevision: revision, appliedInstructionRevision: run.instructionRevision ?? assignment.instructionRevision ?? 1,
        phase, observed: !!current && (status !== 'unknown' || completed), updatedAt: latest(iso(run.updatedAt), worker?.state?.updatedAt, ...children.map(row => row.updatedAt)),
        worker: { id: run.sessionId, label: '主 Worker', status, activity: text,
          updatedAt: current && text === worker.state?.activity ? worker.state.updatedAt : iso(run.updatedAt),
          activitySource: current && text === worker.state?.activity && worker.state?.activitySource === 'report' ? 'report' : 'runtime',
          history: current ? historyOf(worker) : [], historyTruncated: current && worker.state?.activityHistoryTruncated === true },
        children, childCounts, milestones: worker?.state?.milestones || [],
        watermark: { projectionSeq: database.executionFactCursor(), sessionSeq: current ? worker.cursor : null },
        completeness: complete ? 'complete' : 'partial',
        ...(!complete ? { limitation: '仅显示当前可核实的执行事实，部分官方历史或执行归属暂不可恢复。' } : {}) };
    };
  }
  return { ready, batch, bootId, recover,
    diagnostics: () => ({ bootId, observedAt: iso(now()), recoveryFailures, recovering: recovering.size, disposed }),
    async dispose() { disposed = true; shutdown.abort(); for (const stop of disposers.splice(0)) stop(); await Promise.allSettled([...recovering.values()]); await handle?.dispose(); },
  };
}
