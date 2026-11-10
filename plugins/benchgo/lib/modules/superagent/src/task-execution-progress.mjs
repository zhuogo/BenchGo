import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// Official Session projections own replay. This text-free view never authorizes,
// executes, schedules, or changes the Ticket/Assignment/Run lifecycle.
const executionProjectionKey = 'benchgoExecutionFacts';
const terminal = new Set(['completed', 'failed', 'cancelled']);
const iso = value => value != null && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const latest = (...values) => values.filter(Boolean).sort().at(-1) || null;
const stopStatus = reason => reason === 'completed' ? 'completed' : reason === 'aborted' ? 'cancelled'
  : ['error', 'max-tokens', 'refusal'].includes(reason) ? 'failed' : 'unknown';
const activities = { search: '正在搜索网页', web: '正在读取网页', read: '正在读取文件', write: '正在修改文件',
  command: '正在执行命令', child: '正在协调子 Worker', question: '正在等待问题答复', tool: '正在使用工具' };
const category = name => name === 'web_search' ? 'search' : name === 'web_fetch' ? 'web'
  : ['read', 'read_file', 'glob', 'grep', 'list_directory'].includes(name) ? 'read'
  : ['write', 'write_file', 'edit', 'apply_patch'].includes(name) ? 'write'
  : ['bash', 'pwsh', 'shell', 'exec_command'].includes(name) ? 'command'
  : ['subagent', 'spawn_agent', 'send_message', 'followup_task', 'wait_agent', 'list_agents'].includes(name) ? 'child'
  : name === 'ask_user_question' ? 'question' : 'tool';
const eventSchema = z.object({ seq: z.number().int(), kind: z.string(), time: z.string().nullable(), category: z.string().optional() });
const requestSchema = z.object({ state: z.enum(['unknown', 'inflight', 'settled']), startedAt: z.string().nullable(), settledAt: z.string().nullable(), deadline: z.null() });
const stateSchema = z.object({ sessionId: z.string(), parentSessionId: z.string().nullable(), inheritedEventCount: z.number().int(),
  cursor: z.number().int(), status: z.string(), activity: z.string(), updatedAt: z.string().nullable(), turn: z.number().int().nullable(), step: z.number().int().nullable(),
  request: requestSchema, tools: z.object({ calls: z.number().int(), results: z.number().int(), errors: z.number().int(),
    incomplete: z.boolean(), active: z.array(z.object({ callId: z.string(), category: z.string(), sourceSeq: z.number().int() })).max(128) }),
  children: z.array(z.object({ sessionId: z.string(), catalogSeq: z.number().int(), createdAt: z.string().nullable(),
    notice: z.object({ seq: z.number().int(), reason: z.string(), messageId: z.string() }).optional() })).max(512),
  childrenTruncated: z.boolean(), milestones: z.array(eventSchema).max(64), lastEvent: eventSchema.nullable() });
const initialState = (header, inheritedEventCount) => ({ sessionId: header.id,
  parentSessionId: header.origin === 'subagent' ? header.parentSession || null : null, inheritedEventCount,
  cursor: -1, status: 'unknown', activity: '', updatedAt: null, turn: null, step: null,
  request: { state: 'unknown', startedAt: null, settledAt: null, deadline: null },
  tools: { calls: 0, results: 0, errors: 0, active: [], incomplete: false }, children: [], childrenTruncated: false, milestones: [], lastEvent: null });

/** Pure, bounded fold. Parameters, outputs, failure prose and reasoning never enter it. */
function applyExecutionEvent(state, event) {
  if (event.seq < state.inheritedEventCount) return state;
  if (!['turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call', 'tool/result', 'assistant/message',
    'assistant/attempt', 'subagent/catalog', 'user/message', 'agent/inbox/spliced'].includes(event.type)) return state;
  const data = event.data || {}, time = iso(event.time);
  let children = state.children;
  const notice = message => {
    const source = message?.source;
    if (source?.kind !== 'subagent-settled' || !message.id) return;
    const index = children.findIndex(child => child.sessionId === source.senderSessionId);
    if (index < 0 || children[index].notice?.messageId === message.id) return;
    children = children.map((child, i) => i === index ? { ...child, notice: { seq: event.seq,
      reason: ['completed', 'aborted', 'error', 'max-tokens', 'refusal'].includes(source.stopReason) ? source.stopReason : 'unknown',
      messageId: message.id } } : child);
  };
  if (event.type === 'user/message') notice(data);
  if (event.type === 'agent/inbox/spliced') for (const message of data.inserted || []) notice(message);
  if (['user/message', 'agent/inbox/spliced'].includes(event.type) && children === state.children) return state;
  const next = { ...state, cursor: event.seq, updatedAt: time || state.updatedAt, children };
  let kind = event.type, toolCategory;
  if (event.type === 'subagent/catalog') {
    if (![0, 1, 2, 3].includes(data.version) || typeof data.childId !== 'string') return state;
    if (children.some(child => child.sessionId === data.childId)) return state;
    if (children.length >= 512) next.childrenTruncated = true;
    else next.children = [...children, { sessionId: data.childId, catalogSeq: event.seq, createdAt: iso(data.childCreatedAt) || time }];
  } else if (event.type === 'turn/start') {
    next.status = 'running'; next.activity = '正在处理任务'; next.turn = Number.isSafeInteger(data.turn) ? data.turn : null;
  } else if (event.type === 'step/start') {
    next.status = 'running'; next.activity = '正在处理任务'; next.step = Number.isSafeInteger(data.step) ? data.step : null;
    // Preparation is not proof of an in-flight model request.
    next.request = { state: 'unknown', startedAt: null, settledAt: null, deadline: null };
  } else if (['assistant/message', 'assistant/attempt'].includes(event.type)) {
    next.request = { ...state.request, state: 'settled', settledAt: time };
  } else if (event.type === 'tool/call') {
    toolCategory = category(data.name); next.status = 'running'; next.activity = activities[toolCategory];
    const active = state.tools.active;
    next.tools = { ...state.tools, calls: state.tools.calls + 1, incomplete: state.tools.incomplete || active.length >= 128,
      active: active.length < 128 && typeof data.callId === 'string' ? [...active, { callId: data.callId, category: toolCategory, sourceSeq: event.seq }] : active };
  } else if (event.type === 'tool/result') {
    const callId = data.message?.toolCallId || data.message?.callId;
    toolCategory = state.tools.active.find(call => call.callId === callId)?.category || 'tool';
    next.tools = { ...state.tools, results: state.tools.results + 1, errors: state.tools.errors + (data.message?.isError ? 1 : 0),
      active: state.tools.active.filter(call => call.callId !== callId) };
    next.activity = data.message?.isError ? '工具调用失败，正在处理' : '正在处理任务';
  } else if (event.type === 'turn/end') {
    const reason = data.reason?.kind;
    next.status = ['completed', 'blocked'].includes(reason) ? 'waiting' : stopStatus(reason);
    next.activity = reason === 'completed' ? '本轮执行已结束' : reason === 'blocked' ? '正在等待处理'
      : next.status === 'cancelled' ? '执行已停止' : next.status === 'failed' ? '执行遇到错误' : '执行状态待核实';
    next.request = { ...state.request, state: 'settled', settledAt: time };
  }
  if (children !== state.children) kind = 'subagent/returned';
  next.lastEvent = { seq: event.seq, kind, time, ...(toolCategory ? { category: toolCategory } : {}) };
  if (event.type !== 'tool/call') next.milestones = [...state.milestones, next.lastEvent].slice(-64);
  return next;
}
const executionProjectionDefinition = { key: executionProjectionKey, stateVersion: 1, stateSchema,
  init: initialState, apply: applyExecutionEvent, wire: { viewSchema: stateSchema, view: state => state, summary: false } };

export function createTaskExecutionProgress({ ctx, database, now = Date.now, bootId = randomUUID() }) {
  const disposers = [], recovering = new Map(), shutdown = new AbortController();
  let handle, disposed = false, recoveryFailures = 0;
  const on = (name, callback) => { const stop = ctx.on(name, callback, { global: true }); if (stop) disposers.push(stop); };
  const bindingOf = state => database.getExecutionBinding(state.parentSessionId || state.sessionId);
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
      if (!database.getExecutionBinding(info.parentSessionId)) return;
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
  function batch() {
    const agents = new Map((ctx.agents?.list?.() || []).map(agent => [agent.id, agent]));
    const records = new Map(database.executionProjections().map(row => [row.sessionId, row]));
    return (ticket, assignments = ticket.assignments || []) => {
      const revision = ticket.instructionRevision ?? 1, assignment = assignments.filter(row => row.ticketId === ticket.id).at(-1);
      const run = assignment && database.runs(assignment.id).filter(row => row.fence === assignment.fence).at(-1);
      if (!run) return null;
      const worker = records.get(run.sessionId), live = agents.get(run.sessionId);
      const current = worker?.runId === run.id && worker?.fence === assignment.fence;
      const phase = run.state === 'prepared' ? 'preparing' : run.state === 'verifying' ? 'verifying'
        : terminal.has(run.state) ? 'finished' : run.state === 'waiting' ? 'waiting' : run.state === 'uncertain' ? 'unknown' : 'executing';
      let status = terminal.has(run.state) ? run.state : live?.status === 'running' ? 'running'
        : live?.status === 'idle' ? 'waiting' : current && terminal.has(worker?.state?.status) ? worker.state.status : 'unknown';
      if (run.state === 'verifying') status = 'waiting';
      if (run.state === 'uncertain') status = 'unknown';
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
            activity: childStatus === 'completed' ? '已返回父 Worker' : childStatus === 'failed' ? '子 Worker 执行失败'
              : childStatus === 'cancelled' ? '子 Worker 已停止' : childStatus === 'unknown' ? '子任务状态待核实' : child.state?.activity || '正在处理子任务',
            updatedAt: latest(child.state?.updatedAt, child.live?.observedAt), activationId: child.live?.activationId || null,
            historical: child.fence !== assignment.fence, sourceSeq: child.cursor };
        });
      const childCounts = { total: children.length, running: 0, completed: 0, failed: 0 };
      for (const child of children) if (child.status in childCounts) childCounts[child.status]++;
      const complete = !!current && worker.complete && children.every(child => records.get(child.id)?.complete);
      const text = phase === 'verifying' ? '正在保存执行结果' : phase === 'preparing' ? '正在准备执行环境'
        : run.state === 'completed' ? '执行已结束' : run.state === 'failed' ? '执行失败' : run.state === 'cancelled' ? '执行已停止'
          : status === 'unknown' ? '执行状态待核实' : current && worker.state?.activity || '执行动态暂不可用';
      return { ticketId: ticket.id, assignmentId: assignment.id, runId: run.id, sessionId: run.sessionId, fence: assignment.fence,
        instructionRevision: revision, appliedInstructionRevision: run.instructionRevision ?? assignment.instructionRevision ?? 1,
        phase, observed: !!worker, updatedAt: latest(iso(run.updatedAt), worker?.state?.updatedAt, ...children.map(row => row.updatedAt)),
        worker: { id: run.sessionId, label: '主 Worker', status, activity: text, updatedAt: latest(iso(run.updatedAt), worker?.state?.updatedAt) },
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
