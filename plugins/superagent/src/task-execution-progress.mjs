// Discardable presentation facts only. Authorization, completion and recovery
// remain owned by the Ticket/Assignment/Run ledger and official Harness.
const CACHE_LIMIT = 2048;
const terminal = new Set(['completed', 'failed', 'cancelled']);
const iso = value => {
  const date = new Date(value);
  return value != null && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const latest = (...values) => values.filter(Boolean).sort().at(-1) || null;
const stopStatus = reason => reason === 'completed' ? 'completed'
  : reason === 'aborted' ? 'cancelled'
  : ['error', 'max-tokens', 'refusal'].includes(reason) ? 'failed' : 'unknown';

// Never expose tool arguments, provider errors, outputs or model-authored prose.
function toolActivity(name) {
  if (name === 'web_search') return '正在搜索网页';
  if (name === 'web_fetch') return '正在读取网页';
  if (['read', 'read_file', 'glob', 'grep', 'list_directory'].includes(name)) return '正在读取文件';
  if (['write', 'write_file', 'edit', 'apply_patch'].includes(name)) return '正在修改文件';
  if (['bash', 'pwsh', 'shell', 'exec_command'].includes(name)) return '正在执行命令';
  if (['subagent', 'spawn_agent', 'send_message', 'followup_task', 'wait_agent', 'list_agents'].includes(name)) return '正在协调子 Worker';
  if (name === 'ask_user_question') return '正在等待问题答复';
  return '正在使用工具';
}

/**
 * Observe public Harness lifecycle/events without reading cold transcripts or
 * introducing another execution loop. Each batch scans the live registry once.
 * Historical child details unavailable after restart are explicitly unknown.
 */
export function createTaskExecutionProgress({ ctx, database, now = Date.now }) {
  const records = new Map(), disposers = [], sessions = new WeakMap();
  let disposed = false, evicted = false, order = 0, generation = 0;
  function remember(id, parentId) {
    if (!id || disposed) return null;
    let row = records.get(id);
    if (!row) {
      row = { id, parentId, parentGeneration: records.get(parentId)?.generation, attachedOrder: order,
        status: 'unknown', activity: '', updatedAt: null, seq: -1, order: order++, complete: false };
      records.set(id, row);
      if (records.size > CACHE_LIMIT) { records.delete(records.keys().next().value); evicted = true; }
    } else if (parentId) {
      // A durable direct-parent relation must never be rewritten by another tree.
      if (row.parentId && row.parentId !== parentId) return null;
      row.parentId = parentId;
    }
    return row;
  }
  function sessionRecord(session) {
    if (!session) return null;
    const header = session?.header;
    const row = remember(session.id || header?.id, header?.origin === 'subagent' ? header.parentSession : undefined);
    if (!row) return null;
    if (!sessions.has(session)) sessions.set(session, ++generation);
    const current = sessions.get(session);
    if (row.generation !== current) {
      // Resuming the same session id creates a new official Session instance.
      // Children from its preceding residency are history, not current work.
      Object.assign(row, { generation: current, scopeStart: 0, seq: -1, status: 'unknown', activity: '', updatedAt: null,
        complete: false, settled: false, activation: undefined, parentGeneration: records.get(row.parentId)?.generation, attachedOrder: order++ });
    }
    return row;
  }
  function settled(parentId, id, reason, at) {
    const row = remember(id, parentId);
    if (!row) return;
    row.status = stopStatus(reason);
    row.activity = row.status === 'completed' ? '已返回父 Worker'
      : row.status === 'failed' ? '子 Worker 执行失败'
      : row.status === 'cancelled' ? '子 Worker 已停止' : '子 Worker 结束状态待核实';
    row.updatedAt = at;
    row.settled = true;
  }
  function message(parentId, value, at) {
    const source = value?.source;
    if (source?.kind !== 'subagent-settled') return;
    const child = records.get(source.senderSessionId), parent = records.get(parentId);
    // A notice has no activation id. Once lifecycle events were observed, its
    // captured output cannot overrule their final outcome (cleanup can fail),
    // or be proven to belong to the current activation after a restart.
    if (!child || child.parentId !== parentId || child.parentGeneration !== parent?.generation
      || child.attachedOrder < (parent?.scopeStart || 0) || child.activation || value.id && child.noticeId === value.id) return;
    // The same durable notice first enters the inbox and later the transcript.
    // Re-reading it must not replace a newer child activation's outcome.
    child.noticeId = value.id;
    settled(parentId, source.senderSessionId, source.stopReason, at);
  }
  function event(session, item) {
    if (!item || item.seq < (session.inheritedEventCount || 0)) return;
    if (!['turn/start', 'turn/end', 'tool/call', 'tool/result', 'request/header', 'subagent/catalog', 'user/message', 'agent/inbox/spliced'].includes(item.type)) return;
    const row = sessionRecord(session);
    if (!row || item.seq <= row.seq) return;
    row.seq = item.seq;
    const at = iso(item.time), data = item.data || {};
    if (item.type === 'subagent/catalog') {
      if (![0, 1, 2, 3].includes(data.version)) return;
      const child = remember(data.childId, row.id);
      if (child) {
        child.updatedAt ||= iso(data.childCreatedAt) || at;
        child.parentGeneration = row.generation; child.attachedOrder = order++;
      }
      return;
    }
    if (item.type === 'user/message') { message(row.id, data, at); return; }
    if (item.type === 'agent/inbox/spliced') {
      for (const value of data.inserted || []) message(row.id, value, at);
      return;
    }
    row.updatedAt = at || row.updatedAt;
    if (item.type === 'turn/end') {
      const reason = data.reason?.kind;
      row.status = ['completed', 'blocked'].includes(reason) ? 'waiting' : stopStatus(reason);
      row.activity = reason === 'completed' ? '本轮执行已结束'
        : reason === 'blocked' ? '正在等待处理'
        : row.status === 'failed' ? '执行遇到错误'
        : row.status === 'cancelled' ? '执行已停止' : '执行状态待核实';
    } else {
      row.status = 'running'; row.settled = false;
      row.activity = item.type === 'tool/call' ? toolActivity(data.name)
        : item.type === 'tool/result' && data.message?.isError ? '工具调用失败，正在处理' : '正在处理任务';
    }
  }
  const on = (name, callback) => {
    const stop = ctx.on?.(name, callback, { global: true });
    if (stop) disposers.push(stop);
  };
  on('session/created', session => {
    const row = sessionRecord(session);
    // A newly created, empty non-seeded log was observed from its beginning.
    if (row && session.seq === 0 && !session.header?.isSeeded) row.complete = true;
  });
  on('session/event', event);
  on('subagent/start', info => {
    const row = remember(info.id, info.parentSessionId);
    if (!row) return;
    row.activation = info.runId; row.settled = false; row.status = 'running';
    row.parentGeneration = records.get(info.parentSessionId)?.generation; row.attachedOrder = order++;
    row.activity = '正在处理子任务'; row.updatedAt = iso(now());
  });
  on('subagent/end', info => {
    const row = remember(info.id, info.parentSessionId);
    if (!row || row.activation && row.activation !== info.runId) return;
    row.activation = info.runId;
    settled(info.parentSessionId, info.id, info.stopReason, iso(now()));
  });
  on('agent/disposed', ({ agent }) => {
    const row = records.get(agent.id);
    // Disposal by itself proves neither success nor cancellation.
    if (row && row.status === 'running' && !row.settled) {
      row.status = 'unknown'; row.activity = '执行状态待核实'; row.updatedAt = iso(now());
    }
  });

  function batch() {
    const agents = new Map((ctx.agents?.list?.() || []).map(agent => [agent.id, agent]));
    const children = new Map();
    for (const agent of agents.values()) {
      const row = sessionRecord(agent.session);
      if (!row) continue;
      if (agent.status === 'running') {
        if (row.settled) row.activity = '正在处理任务';
        row.status = 'running'; row.settled = false;
        row.activity ||= '正在处理任务';
      } else if (!row.settled && ['running', 'unknown'].includes(row.status)) {
        row.status = 'waiting'; row.activity = '等待后续处理';
      }
    }
    for (const row of records.values()) {
      if (!row.parentId) continue;
      if (!children.has(row.parentId)) children.set(row.parentId, []);
      children.get(row.parentId).push(row);
    }
    return (ticket, assignments = ticket.assignments || []) => {
      const revision = ticket.instructionRevision ?? 1;
      const assignment = assignments.filter(row => row.ticketId === ticket.id && (row.instructionRevision ?? 1) === revision).at(-1);
      if (!assignment) return null;
      const run = database.runs(assignment.id).filter(row => row.assignmentId === assignment.id && row.fence === assignment.fence).at(-1);
      if (!run) return null;
      const worker = records.get(run.sessionId), live = agents.get(run.sessionId);
      const binding = `${assignment.id}:${run.id}:${assignment.fence}:${revision}`;
      if (worker) {
        if (worker.binding && worker.binding !== binding && worker.bindingGeneration === worker.generation) {
          // An ownership change without a fresh Session boundary cannot lend
          // old child observations to the new lease. Wait for new facts.
          worker.scopeStart = order++; worker.complete = false; worker.activity = '';
          worker.status = live?.status === 'running' ? 'running' : live?.status === 'idle' ? 'waiting' : 'unknown';
        }
        worker.binding = binding; worker.bindingGeneration = worker.generation;
      }
      const observed = !!worker;
      const phase = run.state === 'prepared' ? 'preparing'
        : run.state === 'verifying' ? 'verifying'
        : terminal.has(run.state) ? 'finished'
        : run.state === 'waiting' ? 'waiting'
        : run.state === 'uncertain' ? 'unknown' : 'executing';
      let status = terminal.has(run.state) ? run.state : worker?.status || (live?.status === 'running' ? 'running' : 'unknown');
      if (run.state === 'verifying') status = 'waiting';
      if (run.state === 'uncertain') status = 'unknown';
      const activity = phase === 'verifying' ? '执行结果正在核验'
        : phase === 'preparing' ? '正在准备执行环境'
        : run.state === 'completed' ? '执行已结束'
        : run.state === 'failed' ? '执行失败'
        : run.state === 'cancelled' ? '执行已停止'
        : worker?.activity || '执行动态暂不可用';
      const childRows = (children.get(run.sessionId) || []).filter(child => worker
        && child.parentGeneration === worker.generation && child.attachedOrder >= (worker.scopeStart || 0))
        .sort((a, b) => a.order - b.order).map((child, index) => ({
        id: child.id, label: `子 Worker ${index + 1}`, status: child.status,
        activity: child.activity || '子任务动态暂不可用', updatedAt: child.updatedAt,
      }));
      const childCounts = { total: childRows.length, running: 0, completed: 0, failed: 0 };
      for (const child of childRows) if (child.status in childCounts) childCounts[child.status]++;
      const complete = !!worker?.complete && !evicted;
      return { assignmentId: assignment.id, runId: run.id, sessionId: run.sessionId, instructionRevision: revision,
        phase, observed, updatedAt: latest(iso(run.updatedAt), worker?.updatedAt, ...childRows.map(row => row.updatedAt)),
        worker: { id: run.sessionId, label: '主 Worker', status, activity, updatedAt: latest(iso(run.updatedAt), worker?.updatedAt) },
        children: childRows, childCounts,
        ...(!complete ? { limitation: '仅显示当前可核实的执行动态，历史子任务记录未完整加载。' } : {}),
      };
    };
  }
  return {
    batch,
    dispose() { disposed = true; for (const stop of disposers.splice(0)) stop(); records.clear(); },
  };
}
