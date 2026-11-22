import { applyExecutionEvent, executionActivities, executionActivityTime, executionStopStatus, executionToolCategory,
  initialExecutionProjection } from '../../base/shared/execution-projection.mjs';
import { scanWorkerProgressLine } from '../../base/shared/worker-progress.mjs';

const childLimit = 8;
const historyLimit = 64;
const activePhases = new Set(['running', 'waiting']);
const settled = new Set(['completed', 'failed', 'cancelled']);

function worker(state, label, phase = state.status) {
  const status = activePhases.has(phase) || settled.has(phase) ? phase : 'unknown';
  const settledActivity = { completed: '本轮执行已结束', failed: '执行遇到错误', cancelled: '执行已停止', unknown: '执行状态待核实' }[status];
  const activity = settledActivity || state.activity || '正在处理任务';
  return { id: state.sessionId, label, status, activity, activitySource: settledActivity ? 'runtime' : state.activitySource,
    updatedAt: state.updatedAt, history: state.activityHistory, historyTruncated: state.activityHistoryTruncated };
}

export function officialExecutionProgress(sessionId, previous) {
  let root = initialExecutionProjection({ id: sessionId }, 0);
  const children = new Map();
  const observeRoot = event => { if (event.seq > root.cursor) root = applyExecutionEvent(root, event); };
  return {
    replay(log) {
      if (log?.header?.id && log.header.id !== sessionId) return;
      for (const event of log?.events || []) observeRoot(event);
    },
    observe(session, event) {
      if (session.id === sessionId) observeRoot(event);
      else {
        const child = children.get(session.id);
        if (!child || session.header?.origin !== 'subagent' || session.header.parentSession !== sessionId) return;
        if (event.seq >= (session.inheritedEventCount ?? 0) && event.seq > child.state.cursor)
          child.state = applyExecutionEvent(child.state, event);
      }
    },
    activate(info, session) {
      if (info.parentSessionId !== sessionId || !info.id || !info.runId || info.id === sessionId
        || session && (session.id !== info.id || session.header?.origin !== 'subagent' || session.header.parentSession !== sessionId)
        || !children.has(info.id) && children.size >= childLimit) return;
      const tracked = children.get(info.id);
      if (tracked?.activation === info.runId) return;
      const prior = previous?.children.find(child => child.id === info.id);
      const state = initialExecutionProjection({ id: info.id, origin: 'subagent', parentSession: sessionId }, session?.inheritedEventCount ?? 0);
      if (prior) Object.assign(state, { cursor: prior.history.at(-1)?.seq ?? -1, activityHistory: prior.history,
        activityHistoryTruncated: prior.historyTruncated });
      children.set(info.id, { activation: info.runId, status: 'running', updatedAt: new Date().toISOString(),
        state: tracked?.state || state });
    },
    settle(info) {
      if (info.parentSessionId !== sessionId) return;
      const child = children.get(info.id);
      const status = executionStopStatus(info.stopReason);
      if (child?.activation === info.runId && child.status !== status) {
        child.status = status;
        child.updatedAt = new Date().toISOString();
      }
    },
    snapshot() {
      if (root.cursor < 0 && !children.size) return previous || null;
      const visibleChildren = new Map((previous?.children || []).map(child => [child.id, child]));
      for (const [id, child] of children) {
        if (!visibleChildren.has(id) && visibleChildren.size >= childLimit) continue;
        const status = child.status === 'running' && child.state.status === 'waiting' ? 'waiting' : child.status;
        visibleChildren.set(id, worker({ ...child.state, updatedAt: child.state.updatedAt > child.updatedAt ? child.state.updatedAt : child.updatedAt }, '', status));
      }
      return { worker: worker(root, '主 Worker'),
        children: [...visibleChildren.values()].map((child, index) => ({ ...child, label: `子 Worker ${index + 1}` })) };
    },
  };
}

export function nativeExecutionProgress(sessionId, previous) {
  let current = previous?.worker || worker(initialExecutionProjection({ id: sessionId }, 0), '主 Worker');
  const previousCursor = current.history.at(-1)?.seq ?? -1;
  let line = '', overflow = false, itemId, scan = {};
  function record(event, activity, activitySource, status = 'running') {
    if (!activity || event.seq <= previousCursor || current.status === status && current.activity === activity && current.activitySource === activitySource) return;
    const time = executionActivityTime(event.time);
    const entry = { seq: event.seq, time, status, activity, activitySource };
    const last = current.history.at(-1);
    const history = last?.seq === entry.seq ? [...current.history.slice(0, -1), entry] : [...current.history, entry];
    current = { ...current, status, activity, activitySource, updatedAt: time || current.updatedAt,
      history: history.slice(-historyLimit), historyTruncated: current.historyTruncated || history.length > historyLimit };
  }
  function flushLine(event) {
    if (!overflow) record(event, scanWorkerProgressLine(line, scan), 'report');
    line = ''; overflow = false;
  }
  return {
    observe(event) {
      if (event.type === 'text.delta' && typeof event.data?.text === 'string') {
        if (itemId !== event.data.itemId) {
          if (itemId !== undefined) flushLine(event);
          itemId = event.data.itemId; scan = {};
        }
        const parts = event.data.text.split('\n');
        for (let index = 0; index < parts.length; index++) {
          if (index) flushLine(event);
          if (line.length + parts[index].length > 1024) { line = ''; overflow = true; }
          else if (!overflow) line += parts[index];
        }
        return;
      }
      if (event.type === 'turn.completed') { flushLine(event); return; }
      if (event.type !== 'item') return;
      const item = event.data?.item || event.data;
      if (item?.type === 'agentMessage' && event.data?.phase === 'item/completed') {
        flushLine(event); itemId = undefined; scan = {};
        return;
      }
      if (event.data?.phase !== 'item/started' && item?.type !== 'tool_use') return;
      const category = item?.type === 'commandExecution' ? 'command' : item?.type === 'fileChange' ? 'write'
        : item?.type === 'webSearch' ? 'search' : item?.type === 'mcpToolCall' || item?.type === 'tool_use' ? executionToolCategory(item.name ?? item.tool) : null;
      if (category && current.activitySource !== 'report') record(event, executionActivities[category], 'runtime');
    },
    snapshot() { return current.updatedAt ? { worker: current, children: [] } : null; },
  };
}
