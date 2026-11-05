import { ticketSnapshot } from './ticket-state.mjs';
import { normalizeTicketTitle } from '../src/ticket-title.mjs';

export const terminalActivityStates = new Set(['completed', 'failed', 'cancelled', 'closed']);
// Paused/cancelling work remains in the history list, but it is no longer
// actively executing. Keep this set shared by the trigger and drawer so a
// paused or stopping ticket cannot leave the activity badge looking busy.
export const inactiveActivityStates = new Set(['paused', 'pausing', 'cancelling']);
export const attentionActivityStates = new Set(['waiting', 'awaiting_user', 'continuation_wait', 'blocked', 'uncertain', 'failed']);
export const liveActivityStates = status => !terminalActivityStates.has(status) && !inactiveActivityStates.has(status);
export const activeActivityStates = status => liveActivityStates(status) && !attentionActivityStates.has(status);
export const activityLabels = { open: '已接收', queued: '等待执行', claimed: '执行中', active: '进行中', reworking: '原工单补做中', completed: '已完成', waiting: '等待处理', awaiting_user: '等待你的答复', review_wait: '系统自动核验中', continuation_wait: '系统等待续做资源', paused: '已暂停', pausing: '正在暂停', resuming: '正在恢复', cancelling: '正在停止', cancelled: '已停止', failed: '执行失败', uncertain: '待核实', blocked: '受阻', closed: '已结束' };

export function activityTask(row, kind) {
  const { assignment, result, delivery, status: ticketStatus, safetyWait } = ticketSnapshot(row);
  const status = kind === 'goal' ? row.status : ticketStatus;
  const detail = kind === 'goal' ? row.error || ({ building_children: '正在拆分子目标', verify: '正在核验目标' })[row.nextStep] : result?.delivery?.text || result?.review?.reason || result?.summary;
  const phase = kind === 'goal' ? `${row.ticketIds?.length || 0} 项关联工单`
    : status === 'reworking' ? '沿原会话补做并重新核验'
    : status === 'awaiting_user' ? '等待你的答复 · 原工单保留'
    : status === 'review_wait' ? '系统自动补证与核验'
    : status === 'continuation_wait' ? safetyWait ? '系统待核实外部效果' : '系统等待续做资源'
    : delivery?.state === 'sent' ? '结果已交付' : delivery ? '结果交付阶段'
    : result?.review ? '自动核验已结束' : result ? '正在自动核验结果'
    : assignment ? `执行阶段 · ${activityLabels[assignment.state] || assignment.state || '状态未知'}` : '已接收 · 等待分配';
  return { ...row, key: `${kind}:${row.id}`, kind, status, detail, phase, title: kind === 'ticket' ? normalizeTicketTitle(row.taskMeta?.title || row.title, row.target) : row.target || row.title || row.objective || '未命名任务', time: row.updatedAt || row.createdAt };
}

export function groupHomeActivity(rows = []) {
  const sorted = [...rows].sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0));
  return {
    attention: sorted.filter(row => attentionActivityStates.has(row.status)).slice(0, 2),
    active: sorted.filter(row => activeActivityStates(row.status)).slice(0, 3),
    completed: sorted.filter(row => row.status === 'completed').slice(0, 2),
  };
}

/** One request stream shared by the home brief and the activity drawer. */
export function createActivityStore(api, environment = {}) {
  const page = environment.document ?? globalThis.document;
  const schedule = environment.setTimeout ?? globalThis.setTimeout;
  const cancel = environment.clearTimeout ?? globalThis.clearTimeout;
  const listeners = new Set();
  let snapshot = { rows: null, error: '', loading: true, updated: null };
  let timer, request;
  const publish = patch => { snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener()); };
  const refresh = async () => {
    if (!listeners.size || page?.hidden || request) return;
    cancel(timer);
    const controller = new AbortController(); request = controller;
    publish({ loading: true });
    try {
      const [tickets, goals] = await Promise.all([api('tickets', {}, controller.signal), api('goalList', {}, controller.signal)]);
      if (!controller.signal.aborted) publish({ rows: [...(tickets.tickets || []).map(row => activityTask(row, 'ticket')), ...(goals.goals || []).map(row => activityTask(row, 'goal'))], error: '', updated: new Date().toISOString() });
    } catch (cause) {
      if (!controller.signal.aborted) publish({ error: cause.message || '任务读取失败' });
    } finally {
      if (request === controller) {
        request = null;
        publish({ loading: false });
        if (listeners.size && !page?.hidden) timer = schedule(refresh, 10000);
      }
    }
  };
  const visibility = () => { cancel(timer); if (!page?.hidden) void refresh(); };
  return {
    getSnapshot: () => snapshot,
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        page?.addEventListener('visibilitychange', visibility);
        page?.addEventListener('benchgo:assistant-changed', refresh);
        void refresh();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          cancel(timer); request?.abort(); request = null;
          page?.removeEventListener('visibilitychange', visibility);
          page?.removeEventListener('benchgo:assistant-changed', refresh);
        }
      };
    },
  };
}

