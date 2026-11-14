import { taskSnapshot, taskWaiting, taskResultSummary, shortTaskText } from './task-state.mjs';
import { normalizeTaskTitle } from '../src/task-title.mjs';
import { transientRefreshError } from './refresh-error.mjs';
import { executionStatusText } from '../src/task-lifecycle.mjs';

export const terminalActivityStates = new Set(['completed', 'failed', 'cancelled']);
// Goal controls retain their own lifecycle; Task activity uses only three states.
export const attentionActivityStates = new Set(['waiting', 'blocked', 'uncertain', 'failed']);
export const liveActivityStates = status => ['running', 'waiting', 'active', 'resuming'].includes(status);
export const activeActivityStates = status => ['running', 'active', 'resuming'].includes(status);
export const activityLabels = { running: '进行', waiting: '等待', completed: '完成', active: '进行中', paused: '已暂停', pausing: '正在暂停', resuming: '正在恢复', cancelling: '正在停止', cancelled: '已停止', failed: '执行失败', blocked: '受阻', uncertain: '待核实' };
const TASK_READ_CONCURRENCY = 4;
const TASK_PAGE_SIZE = 1000;
const SNAPSHOT_TIMEOUT_MS = 45000;

export const archivedActivityTask = row => row.kind === 'task' && (row.archived === true || !!row.cleanup?.id || row.taskMeta?.archived === true);

/** The chat board and its trigger show the same current Task set. */
export function boardTaskRows(rows = []) {
  return [...new Map(rows.filter(row => row.kind === 'task' && ['running', 'waiting', 'completed'].includes(row.status)
    && !archivedActivityTask(row) && !row.taskMeta?.deleted).map(row => [row.id, row])).values()];
}

/** Runtime activity is evidence about an execution, never a replacement for Task state. */
function currentExecution(row, assignment) {
  const execution = row.execution;
  if (!execution || execution.instructionRevision !== (row.instructionRevision ?? 1)
    || (assignment?.id && execution.assignmentId !== assignment.id)) return undefined;
  return execution;
}

function executionSummary(execution) {
  if (!execution) return '';
  const parts = [execution.worker?.status === 'completed' ? '执行已结束' : execution.worker?.activity];
  const children = execution.children || [];
  if (children.length) {
    const returned = children.filter(child => child.status === 'completed').length;
    const running = children.filter(child => child.status === 'running').length;
    const failed = children.filter(child => child.status === 'failed').length;
    parts.push(`子任务 ${returned}/${children.length} 已返回`);
    if (running) parts.push(`${running} 项执行中`);
    if (failed) parts.push(`${failed} 项失败`);
  }
  return parts.filter(Boolean).join(' · ');
}

export function activityTask(row, kind) {
  const domain = row.domainStatus ? { ...row, status: row.domainStatus } : row;
  const { assignment, result, delivery, status: taskStatus, safetyWait } = taskSnapshot(domain);
  const execution = kind === 'task' ? currentExecution(row, assignment) : undefined;
  const status = kind === 'goal' ? row.status : taskStatus;
  const waiting = kind === 'task' ? taskWaiting(domain) : null;
  const detail = kind === 'goal' ? undefined : waiting?.reason || taskResultSummary(result) || undefined;
  const phase = kind === 'goal' ? '长期目标'
    : status === 'completed' ? delivery?.state === 'sent' ? '执行完成 · 结果已交付' : '执行完成'
    : waiting ? waiting.reason
    : delivery?.state === 'sent' ? '结果已交付' : delivery ? '结果交付阶段'
    : result ? '结果已保存'
    : assignment ? `执行阶段 · ${({ claimed: '执行中', queued: '等待执行', waiting: '等待后续', uncertain: '待核实', blocked: '授权已变更' })[assignment.state] || '已记录'}` : '已接收 · 等待分配';
  const progressing = status === 'running';
  const reportedActivity = execution?.observed !== false && execution?.worker?.status === 'running'
    && execution.worker.activitySource === 'report' ? execution.worker.activity : '';
  const summaryText = progressing
    ? shortTaskText(executionStatusText(execution?.worker?.status === 'completed' ? '执行已结束'
      : reportedActivity || execution?.summary?.text || (typeof row.currentSummary === 'string' ? row.currentSummary : row.currentSummary?.text))) : '';
  const progressSummary = progressing ? summaryText || executionSummary(execution) : '';
  return { ...row, domainStatus: row.domainStatus ?? row.status, execution, stateLabel: waiting?.label || activityLabels[status] || status, executionNotice: waiting?.executionNotice, summaryText, progressSummary, key: `${kind}:${row.id}`, kind, status, detail, phase, title: kind === 'task' ? normalizeTaskTitle(row.taskMeta?.title || row.title, row.target) : row.target || row.title || row.objective || '未命名任务', time: row.updatedAt || row.createdAt };
}

export function groupHomeActivity(rows = []) {
  const sorted = [...rows].sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0));
  return {
    attention: sorted.filter(row => !archivedActivityTask(row) && attentionActivityStates.has(row.status)).slice(0, 2),
    active: sorted.filter(row => activeActivityStates(row.status)).slice(0, 3),
  };
}

/** One authoritative snapshot and incremental task reads, shared by every task view. */
export function createActivityStore(api, environment = {}) {
  const page = environment.document ?? globalThis.document;
  const schedule = environment.setTimeout ?? globalThis.setTimeout;
  const cancel = environment.clearTimeout ?? globalThis.clearTimeout;
  const listeners = new Set(), taskRequests = new Map(), queuedTasks = new Map(), revisions = new Map(), dirty = new Set(), failures = new Map();
  let snapshot = { rows: null, error: '', loading: true, updated: null, connection: 'connecting', completeness: null, lastFailure: null };
  let tasks = new Map(), goals = new Map(), timer, mergeTimer, request, goalRequest, transport, replacement, activeTaskReads = 0;
  let generation = 0, subscription = 0, cursor = null, healthy = false, retryDelay = 10000, refreshPending = false, sourceFailed = false, goalsDirty = false, goalsLoaded = false;
  const publish = patch => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(); };
  const recovered = key => { failures.delete(key); return { error: [...failures.values()].join('；') }; };
  const failure = (key, cause, manual = false, carrier = false) => {
    const message = cause?.message || '任务读取失败';
    if (manual || snapshot.rows === null || !(carrier || transientRefreshError(cause))) failures.set(key, message);
    return { error: [...failures.values()].join('；'), lastFailure: { source: key, message, time: new Date().toISOString() } };
  };
  const failed = (...args) => publish(failure(...args));
  const finishReplacement = () => { if (replacement) { const current = replacement; replacement = null; cancel(current.timer); current.resolve(); } };
  const same = (a, b) => a && JSON.stringify(a) === JSON.stringify(b);
  const project = (row, kind, prior) => { const next = activityTask(row, kind); return same(prior, next) ? prior : next; };
  const rows = () => [...tasks.values(), ...goals.values()];
  const commit = (extra = {}) => {
    const next = rows(), previous = snapshot.rows;
    publish({ rows: previous?.length === next.length && next.every((row, index) => row === previous[index]) ? previous : next, updated: new Date().toISOString(), ...extra });
  };
  const cancelReads = () => {
    request?.abort(); request = null; goalRequest?.abort(); goalRequest = null;
    for (const entry of taskRequests.values()) { entry.controller.abort(); entry.resolve(null); } taskRequests.clear(); queuedTasks.clear();
    dirty.clear(); goalsDirty = false; cancel(mergeTimer); mergeTimer = null;
  };
  const scheduleFallback = (ms = retryDelay) => {
    cancel(timer);
    if (!healthy && listeners.size && !page?.hidden && !request) timer = schedule(() => { cancel(timer); timer = null; if (sourceFailed && environment.connect) connect(); void pull(); }, ms);
  };
  const readGoals = async (manual = false) => {
    goalRequest?.abort(); const controller = new AbortController(), epoch = generation; goalRequest = controller;
    try {
      const response = await api('goalList', {}, controller.signal);
      if (!controller.signal.aborted && epoch === generation) {
        goalsLoaded = true; goalsDirty = false; goals = new Map((response.goals || []).map(row => [row.id, project(row, 'goal', goals.get(row.id))])); commit(recovered('goals'));
      }
    } catch (cause) { if (!controller.signal.aborted && epoch === generation) { goalsDirty = true; failed('goals', cause, manual || !goalsLoaded); if (!mergeTimer && listeners.size && !page?.hidden) mergeTimer = schedule(flushChanges, retryDelay); retryDelay = Math.min(retryDelay * 2, 60000); } }
    finally { if (goalRequest === controller) goalRequest = null; }
  };
  function drainTasks() {
    while (activeTaskReads < TASK_READ_CONCURRENCY && queuedTasks.size) {
      const [id, entry] = queuedTasks.entries().next().value; queuedTasks.delete(id);
      activeTaskReads++;
      void (async () => {
        let result;
        try { result = { row: (await api('tasks', { taskId: id }, entry.controller.signal)).tasks?.find(row => row.id === id) }; }
        catch (cause) { result = { cause }; }
        finally {
          activeTaskReads--;
          if (taskRequests.get(id) === entry) taskRequests.delete(id);
          entry.resolve({ ...entry, ...result }); drainTasks();
        }
      })();
    }
  }
  const refreshTasks = async (ids, manual = true) => {
    const epoch = generation;
    const reads = [...new Set(ids)].map(id => {
      const previous = taskRequests.get(id);
      if (previous) { previous.controller.abort(); previous.resolve(null); queuedTasks.delete(id); }
      const version = (revisions.get(id) || 0) + 1; revisions.set(id, version);
      const entry = { id, version, controller: new AbortController() };
      const pending = new Promise(resolve => { entry.resolve = resolve; });
      taskRequests.set(id, entry); queuedTasks.set(id, entry);
      return pending;
    });
    drainTasks();
    const results = await Promise.all(reads);
    if (epoch !== generation) return;
    let changed = false, lastFailure, retry = false;
    for (const result of results) {
      if (!result || result.controller.signal.aborted || revisions.get(result.id) !== result.version) continue;
      changed = true;
      if ('cause' in result) { dirty.add(result.id); retry = true; lastFailure = failure(`task:${result.id}`, result.cause, manual).lastFailure; }
      else {
        if (result.row) tasks.set(result.id, project(result.row, 'task', tasks.get(result.id))); else tasks.delete(result.id);
        failures.delete(`task:${result.id}`);
      }
    }
    if (changed) commit({ error: [...failures.values()].join('；'), ...(lastFailure ? { lastFailure } : {}) });
    if (retry) {
      if (!mergeTimer && listeners.size && !page?.hidden) mergeTimer = schedule(flushChanges, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60000);
    }
  };
  const flushChanges = () => {
    cancel(mergeTimer); mergeTimer = null;
    const ids = [...dirty]; dirty.clear();
    if (ids.length) void refreshTasks(ids, false);
    if (goalsDirty) void readGoals();
  };
  const replace = value => {
    const waiting = replacement;
    generation++; cancelReads(); cursor = value.cursor; healthy = true; sourceFailed = false; retryDelay = 10000; cancel(timer);
    tasks = new Map((value.tasks || []).map(row => [row.id, project(row, 'task', tasks.get(row.id))]));
    for (const key of failures.keys()) if (key !== 'goals') failures.delete(key);
    commit({ loading: false, error: [...failures.values()].join('；'), connection: 'live', completeness: value.completeness || null });
    const epoch = generation;
    void readGoals(!!waiting).finally(() => { if (epoch === generation && replacement === waiting) finishReplacement(); });
  };
  const carrierFailed = (cause, carrier = true) => {
    healthy = false; failed('stream', cause, !!replacement, carrier); finishReplacement(); publish({ connection: 'reconnecting', loading: snapshot.rows === null }); scheduleFallback();
  };
  const connect = () => {
    const token = ++subscription;
    void transport?.dispose();
    const guarded = fn => value => { if (token === subscription && listeners.size) fn(value); };
    transport = environment.connect({ replace: guarded(replace), update: guarded(update), carrierFailed: guarded(carrierFailed), failed: guarded(error => { sourceFailed = true; carrierFailed(error, false); }) });
    transport.start();
  };
  const update = frame => {
    if (!healthy) return;
    if (cursor === null) throw new Error('执行事实尚无快照');
    let next = cursor;
    for (const entry of frame.entries || []) {
      if (entry.seq <= next) continue;
      if (entry.seq !== next + 1) {
        generation++; cancelReads(); carrierFailed(new Error('执行记录出现缺口，正在重新同步')); transport?.restart(); return;
      }
      next = entry.seq;
    }
    if (frame.cursor > next) { generation++; cancelReads(); carrierFailed(new Error('执行记录水位不连续，正在重新同步')); transport?.restart(); return; }
    for (const entry of frame.entries || []) {
      if (entry.seq <= cursor) continue;
      if (entry.taskId) { dirty.add(entry.taskId); revisions.set(entry.taskId, (revisions.get(entry.taskId) || 0) + 1); }
      if (entry.kind === 'goal' || (!entry.taskId && entry.kind === 'presentation')) void readGoals();
    }
    cursor = next;
    if (dirty.size && !mergeTimer) mergeTimer = schedule(flushChanges, 80);
  };
  const taskPages = async (archived, signal) => {
    const values = new Map();
    for (let offset = 0; ; offset += TASK_PAGE_SIZE) {
      const response = await api('tasks', { archived, limit: TASK_PAGE_SIZE, offset }, signal);
      signal.throwIfAborted();
      if (!Array.isArray(response.tasks)) throw new Error('任务分页响应无效，请重试');
      const previousSize = values.size;
      for (const row of response.tasks) values.set(row.id, row);
      if (response.tasks.length < TASK_PAGE_SIZE) return [...values.values()];
      if (values.size === previousSize) throw new Error('任务分页未继续前进，请重试');
    }
  };
  async function pull(manual = false) {
    if (!listeners.size || page?.hidden) return;
    if (request) { if (!manual) { refreshPending = true; return; } request.abort(); request = null; }
    cancel(timer); refreshPending = false;
    const controller = new AbortController(), epoch = generation; request = controller;
    if (snapshot.rows === null) publish({ loading: true });
    try {
      const [active, archived, targetGoals] = await Promise.all([
        taskPages(false, controller.signal), taskPages(true, controller.signal), api('goalList', {}, controller.signal),
      ]);
      if (!controller.signal.aborted && epoch === generation && !refreshPending) {
        const unique = new Map([...archived, ...active].map(row => [row.id, row]));
        tasks = new Map([...unique].map(([id, row]) => [id, project(row, 'task', tasks.get(id))]));
        goalsLoaded = true; goals = new Map((targetGoals.goals || []).map(row => [row.id, project(row, 'goal', goals.get(row.id))]));
        for (const key of failures.keys()) if (key !== 'stream') failures.delete(key);
        retryDelay = 10000; commit({ error: [...failures.values()].join('；'), connection: healthy ? 'live' : 'reconnecting' });
      }
    } catch (cause) {
      if (!controller.signal.aborted && epoch === generation) { retryDelay = Math.min(retryDelay * 2, 60000); failed('snapshot', cause, manual); }
    } finally {
      if (request === controller) { request = null; publish({ loading: false }); scheduleFallback(refreshPending ? 0 : retryDelay); }
    }
  }
  const refresh = () => {
    if (!listeners.size || page?.hidden) return Promise.resolve();
    if (!environment.connect) return pull(true);
    if (replacement) return replacement.promise;
    const waiting = {}; waiting.promise = new Promise(resolve => { waiting.resolve = resolve; }); replacement = waiting;
    waiting.timer = schedule(() => { if (replacement === waiting) { failed('snapshot', new Error('任务快照读取超时，请重试'), true); finishReplacement(); } }, SNAPSHOT_TIMEOUT_MS);
    try {
      generation++; cancelReads();
      if (!transport || sourceFailed) connect(); else if (cursor !== null) transport.restart();
    }
    catch (cause) { failed('snapshot', cause, true); finishReplacement(); }
    return waiting.promise;
  };
  const changed = event => {
    if (request) refreshPending = true;
    if (event?.detail?.taskId) { const id = event.detail.taskId; dirty.add(id); revisions.set(id, (revisions.get(id) || 0) + 1); if (!mergeTimer) mergeTimer = schedule(flushChanges, 80); }
    else if (!healthy) void pull();
  };
  const visibility = () => {
    cancel(timer); cancel(mergeTimer); mergeTimer = null;
    if (page?.hidden) finishReplacement();
    else { if (sourceFailed && environment.connect) connect(); else if (transport) transport.restart(); else void pull(); }
  };
  return {
    getSnapshot: () => snapshot, refresh, refreshTasks,
    setEnvironment(next = {}) {
      if (environment === next) return;
      environment = next;
      generation++; subscription++; cancel(timer); cancelReads(); finishReplacement(); refreshPending = false;
      healthy = false; sourceFailed = false; cursor = null;
      void transport?.dispose(); transport = null;
      publish({ ...recovered('stream'), connection: 'reconnecting', loading: snapshot.rows === null });
      if (listeners.size) {
        if (environment.connect) connect();
        else void pull();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        page?.addEventListener('visibilitychange', visibility); page?.addEventListener('benchgo:assistant-changed', changed);
        if (environment.connect) {
          connect();
        } else void pull();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          generation++; subscription++; cancel(timer); cancelReads(); finishReplacement(); refreshPending = false; healthy = false;
          void transport?.dispose(); transport = null;
          page?.removeEventListener('visibilitychange', visibility); page?.removeEventListener('benchgo:assistant-changed', changed);
        }
      };
    },
  };
}
