import { ticketSnapshot, ticketWaiting, ticketResultSummary, shortTicketText } from './ticket-state.mjs';
import { normalizeTicketTitle } from '../src/ticket-title.mjs';
import { transientRefreshError } from './refresh-error.mjs';

export const terminalActivityStates = new Set(['completed', 'failed', 'cancelled']);
// Goal controls retain their own lifecycle; Ticket activity uses only three states.
export const inactiveActivityStates = new Set(['paused', 'pausing', 'cancelling']);
export const attentionActivityStates = new Set(['waiting', 'blocked', 'uncertain', 'failed']);
export const liveActivityStates = status => ['running', 'waiting', 'active', 'resuming'].includes(status);
export const activeActivityStates = status => ['running', 'active', 'resuming'].includes(status);
export const activityLabels = { running: '进行', waiting: '等待', completed: '完成', active: '进行中', paused: '已暂停', pausing: '正在暂停', resuming: '正在恢复', cancelling: '正在停止', cancelled: '已停止', failed: '执行失败', blocked: '受阻', uncertain: '待核实' };

export const archivedActivityTicket = row => row.kind === 'ticket' && (row.archived === true || !!row.cleanup?.id || row.taskMeta?.archived === true);

/** The chat board and its trigger show the same current Ticket set. */
export function boardTicketRows(rows = []) {
  return [...new Map(rows.filter(row => row.kind === 'ticket' && ['running', 'waiting'].includes(row.status)
    && !archivedActivityTicket(row) && !row.taskMeta?.deleted).map(row => [row.id, row])).values()];
}

/** Runtime activity is evidence about an execution, never a replacement for Ticket state. */
function currentExecution(row, assignment) {
  const execution = row.execution;
  if (!execution || execution.instructionRevision !== (row.instructionRevision ?? 1)
    || (assignment?.id && execution.assignmentId !== assignment.id)) return undefined;
  return execution;
}

function executionSummary(execution) {
  if (!execution) return '';
  const parts = [execution.worker?.activity];
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
  const { assignment, result, delivery, status: ticketStatus, safetyWait } = ticketSnapshot(domain);
  const execution = kind === 'ticket' ? currentExecution(row, assignment) : undefined;
  const status = kind === 'goal' ? row.status : ticketStatus;
  const waiting = kind === 'ticket' ? ticketWaiting(domain) : null;
  const detail = kind === 'goal' ? row.error || ({ building_children: '正在拆分子目标', verify: '正在同步目标状态' })[row.nextStep] : waiting?.reason || ticketResultSummary(result) || undefined;
  const phase = kind === 'goal' ? `${row.ticketIds?.length || 0} 项关联工单`
    : status === 'completed' ? '已完成并交付'
    : execution?.phase === 'verifying' && status === 'running' ? 'Worker 已交回结果，正在保存'
    : waiting ? waiting.reason
    : delivery?.state === 'sent' ? '结果已交付' : delivery ? '结果交付阶段'
    : result ? '结果已保存'
    : assignment ? `执行阶段 · ${({ claimed: '执行中', queued: '等待执行', waiting: '等待后续', uncertain: '待核实', blocked: '授权已变更' })[assignment.state] || '已记录'}` : '已接收 · 等待分配';
  const progressing = status === 'running';
  const summaryText = shortTicketText(execution?.summary?.text || (typeof row.currentSummary === 'string' ? row.currentSummary : row.currentSummary?.text));
  const progressSummary = progressing ? summaryText || (execution?.phase === 'verifying' ? phase : executionSummary(execution)) : '';
  return { ...row, domainStatus: row.domainStatus ?? row.status, execution, stateLabel: waiting?.label || activityLabels[status] || status, executionNotice: waiting?.executionNotice, verificationSummary: waiting?.verificationSummary, summaryText, progressSummary, key: `${kind}:${row.id}`, kind, status, detail, phase, title: kind === 'ticket' ? normalizeTicketTitle(row.taskMeta?.title || row.title, row.target) : row.target || row.title || row.objective || '未命名任务', time: row.updatedAt || row.createdAt };
}

export function groupHomeActivity(rows = []) {
  const sorted = [...rows].sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0));
  return {
    attention: sorted.filter(row => !archivedActivityTicket(row) && attentionActivityStates.has(row.status)).slice(0, 2),
    active: sorted.filter(row => activeActivityStates(row.status)).slice(0, 3),
    completed: sorted.filter(row => row.status === 'completed').slice(0, 2),
  };
}

/** One authoritative snapshot and incremental ticket reads, shared by every task view. */
export function createActivityStore(api, environment = {}) {
  const page = environment.document ?? globalThis.document;
  const schedule = environment.setTimeout ?? globalThis.setTimeout;
  const cancel = environment.clearTimeout ?? globalThis.clearTimeout;
  const listeners = new Set(), ticketRequests = new Map(), revisions = new Map(), dirty = new Set(), failures = new Map();
  let snapshot = { rows: null, error: '', loading: true, updated: null, connection: 'connecting', completeness: null, lastFailure: null };
  let tickets = new Map(), goals = new Map(), timer, mergeTimer, request, goalRequest, transport;
  let generation = 0, subscription = 0, cursor = null, healthy = false, retryDelay = 10000, refreshPending = false, sourceFailed = false, goalsDirty = false, goalsLoaded = false;
  const publish = patch => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(); };
  const recovered = key => { failures.delete(key); return { error: [...failures.values()].join('；') }; };
  const failed = (key, cause, manual = false, carrier = false) => {
    const message = cause?.message || '任务读取失败';
    if (manual || snapshot.rows === null || !(carrier || transientRefreshError(cause))) failures.set(key, message);
    publish({ error: [...failures.values()].join('；'), lastFailure: { source: key, message, time: new Date().toISOString() } });
  };
  const same = (a, b) => a && JSON.stringify(a) === JSON.stringify(b);
  const project = (row, kind, prior) => { const next = activityTask(row, kind); return same(prior, next) ? prior : next; };
  const rows = () => [...tickets.values(), ...goals.values()];
  const commit = (extra = {}) => {
    const next = rows(), previous = snapshot.rows;
    publish({ rows: previous?.length === next.length && next.every((row, index) => row === previous[index]) ? previous : next, updated: new Date().toISOString(), ...extra });
  };
  const cancelReads = () => {
    request?.abort(); request = null; goalRequest?.abort(); goalRequest = null;
    for (const controller of ticketRequests.values()) controller.abort(); ticketRequests.clear();
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
  const refreshTickets = async (ids, manual = true) => {
    const epoch = generation;
    await Promise.all([...new Set(ids)].map(async id => {
      const version = (revisions.get(id) || 0) + 1; revisions.set(id, version);
      ticketRequests.get(id)?.abort(); const controller = new AbortController(); ticketRequests.set(id, controller);
      try {
        const response = await api('tickets', { ticketId: id }, controller.signal);
        if (controller.signal.aborted || epoch !== generation || revisions.get(id) !== version) return;
        const row = response.tickets?.find(row => row.id === id);
        if (row) tickets.set(id, project(row, 'ticket', tickets.get(id))); else tickets.delete(id);
        commit(recovered(`ticket:${id}`));
      } catch (cause) {
        if (!controller.signal.aborted && epoch === generation) { dirty.add(id); failed(`ticket:${id}`, cause, manual); if (!mergeTimer && listeners.size && !page?.hidden) mergeTimer = schedule(flushChanges, retryDelay); retryDelay = Math.min(retryDelay * 2, 60000); }
      } finally { if (ticketRequests.get(id) === controller) ticketRequests.delete(id); }
    }));
  };
  const flushChanges = () => {
    cancel(mergeTimer); mergeTimer = null;
    const ids = [...dirty]; dirty.clear();
    if (ids.length) void refreshTickets(ids, false);
    if (goalsDirty) void readGoals();
  };
  const replace = value => {
    generation++; cancelReads(); cursor = value.cursor; healthy = true; sourceFailed = false; retryDelay = 10000; cancel(timer);
    tickets = new Map((value.tickets || []).map(row => [row.id, project(row, 'ticket', tickets.get(row.id))]));
    for (const key of failures.keys()) if (key !== 'goals') failures.delete(key);
    commit({ loading: false, error: [...failures.values()].join('；'), connection: 'live', completeness: value.completeness || null });
    void readGoals();
  };
  const carrierFailed = (cause, carrier = true) => {
    healthy = false; failed('stream', cause, false, carrier); publish({ connection: 'reconnecting', loading: snapshot.rows === null }); scheduleFallback();
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
      if (entry.ticketId) { dirty.add(entry.ticketId); revisions.set(entry.ticketId, (revisions.get(entry.ticketId) || 0) + 1); }
      if (entry.kind === 'goal' || (!entry.ticketId && entry.kind === 'presentation')) void readGoals();
    }
    cursor = next;
    if (dirty.size && !mergeTimer) mergeTimer = schedule(flushChanges, 80);
  };
  async function pull(manual = false) {
    if (!listeners.size || page?.hidden) return;
    if (request) { if (!manual) { refreshPending = true; return; } request.abort(); request = null; }
    cancel(timer); refreshPending = false;
    const controller = new AbortController(), epoch = generation; request = controller;
    if (snapshot.rows === null) publish({ loading: true });
    try {
      const [active, archived, targetGoals] = await Promise.all([
        api('tickets', { archived: false }, controller.signal), api('tickets', { archived: true }, controller.signal), api('goalList', {}, controller.signal),
      ]);
      if (!controller.signal.aborted && epoch === generation) {
        const unique = new Map([...(archived.tickets || []), ...(active.tickets || [])].map(row => [row.id, row]));
        tickets = new Map([...unique].map(([id, row]) => [id, project(row, 'ticket', tickets.get(id))]));
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
  const refresh = async () => {
    if (sourceFailed && environment.connect) connect();
    if (transport && healthy) { await Promise.all([refreshTickets([...tickets.keys()]), readGoals(true)]); }
    else await pull(true);
  };
  const changed = event => {
    if (event?.detail?.ticketId) { dirty.add(event.detail.ticketId); if (!mergeTimer) mergeTimer = schedule(flushChanges, 80); }
    else if (!healthy) void pull();
  };
  const visibility = () => {
    cancel(timer); cancel(mergeTimer); mergeTimer = null;
    if (!page?.hidden) { if (sourceFailed && environment.connect) connect(); else if (transport) transport.restart(); else void pull(); }
  };
  return {
    getSnapshot: () => snapshot, refresh, refreshTickets,
    setEnvironment(next = {}) {
      if (environment === next) return;
      environment = next;
      generation++; subscription++; cancel(timer); cancelReads(); refreshPending = false;
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
          generation++; subscription++; cancel(timer); cancelReads(); refreshPending = false; healthy = false;
          void transport?.dispose(); transport = null;
          page?.removeEventListener('visibilitychange', visibility); page?.removeEventListener('benchgo:assistant-changed', changed);
        }
      };
    },
  };
}
