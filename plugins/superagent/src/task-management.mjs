import { normalizeTicketTitle } from './ticket-title.mjs';
import { ticketPresentation, ticketIsArchived } from './ticket-archive.mjs';

function activityTime(row) {
  for (const value of [row.updatedAt, row.createdAt]) {
    const time = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
    if (Number.isFinite(time)) return time;
  }
  return -Infinity;
}

/** Human list organization is separate from execution and acceptance state. */
export function createTaskManagement({ database, orchestration, scheduler }) {
  const key = (kind, id) => `task-presentation:${kind}:${id}`;
  const settled = (kind, row) => kind === 'ticket' ? row.status === 'completed' || row.executionControl?.stopped === true : (kind === 'goal' ? ['completed', 'failed', 'cancelled'] : ['unavailable', 'decided']).includes(row.status);
  const executionRevision = (kind, row) => kind === 'ticket' ? row.instructionRevision ?? 1 : kind === 'goal' ? row.rowVersion ?? 0 : row.dispositionRevision ?? 0;
  const meta = (kind, row) => {
    const stored = database.meta(key(kind, row.id)) || { version: 0 };
    if (kind === 'ticket') {
      const value = ticketPresentation(row, stored);
      if (stored.title !== undefined) value.title = normalizeTicketTitle(stored.title, row.title || row.target);
      return value;
    }
    // A fresh execution must not inherit a previous run's completion or deletion.
    return (stored.completed || stored.deleted) && (!settled(kind, row) || stored.executionRevision !== executionRevision(kind, row))
      ? { ...stored, completed: false, deleted: false } : stored;
  };
  const project = (kind, rows, { archived } = {}) => rows.map(row => {
    const taskMeta = meta(kind, row);
    return { ...row, ...(kind === 'ticket' ? { archived: ticketIsArchived(row, taskMeta),
      cleanup: taskMeta.archived && taskMeta.cleanupReceiptId ? { id: taskMeta.cleanupReceiptId, archivedAt: taskMeta.archivedAt, version: taskMeta.version } : null } : {}), taskMeta, taskCanOrganize: settled(kind, row) };
  })
    .filter(row => kind === 'ticket' ? archived === undefined || row.archived === archived : !row.taskMeta.deleted)
    // Stable sort retains the source order when activity timestamps are equal.
    .sort((a, b) => activityTime(b) - activityTime(a));
  function update({ kind, id, operation, title, version }) {
    if (!['ticket', 'goal', 'evaluation'].includes(kind) || typeof id !== 'string' || !id) throw new Error('无效任务标识');
    if (!['rename', 'complete', 'reopen', 'delete'].includes(operation)) throw new Error('无效任务操作');
    if (kind === 'ticket' && operation === 'delete') throw Object.assign(new Error('工单清理须先预览具体清单并取得本次确认'), { code: 'CLEANUP_PREVIEW_REQUIRED' });
    return database.transaction(() => {
      const row = kind === 'ticket' ? orchestration.getTicket(id) : kind === 'goal' ? scheduler.getGoal(id) : orchestration.getEvaluation(id);
      if (!row) throw new Error('任务不存在');
      if (kind === 'ticket' && ['complete', 'reopen'].includes(operation)) throw Object.assign(new Error('工单完成由实际执行与交付确认，不能人工标记'), { code: 'TICKET_COMPLETION_MANAGED' });
      const current = meta(kind, row);
      if (!Number.isSafeInteger(version) || version !== current.version) throw Object.assign(new Error('任务已变化，请刷新后重试'), { code: 'REVISION_CONFLICT' });
      if (kind !== 'ticket' && current.deleted) throw new Error('任务已删除');
      if (operation === 'rename' && (typeof title !== 'string' || !title.trim() || kind !== 'ticket' && title.trim().length > 200)) throw new Error(kind === 'ticket' ? '名称不能为空' : '名称须为 1 至 200 字');
      if (['complete', 'delete'].includes(operation)) {
        if (!settled(kind, row)) throw Object.assign(new Error('任务仍在执行或等待执行，请先停止，再进行此操作'), { code: 'EXECUTION_PENDING' });
      }
      const next = { ...current, version: current.version + 1, updatedAt: new Date().toISOString(),
        ...(operation === 'rename' ? { title: kind === 'ticket' ? normalizeTicketTitle(title) : title.trim() } : operation === 'delete' ? { deleted: true, executionRevision: executionRevision(kind, row) } : { completed: operation === 'complete', executionRevision: executionRevision(kind, row) }) };
      database.setMeta(key(kind, id), next);
      return { id, kind, taskMeta: next };
    });
  }
  const cleanup = name => (...args) => {
    if (!database.taskCleanup) throw new Error('工单清理存储不可用');
    return database.taskCleanup[name](...args);
  };
  return { project, update,
    previewCleanup: cleanup('previewCleanup'), getCleanupPreview: cleanup('getCleanupPreview'),
    commitCleanup: cleanup('commitCleanup'), previewRestore: cleanup('previewRestore'), restoreCleanup: cleanup('restoreCleanup'),
    createCleanupConfirmation: cleanup('createConfirmation'), cleanupHistory: cleanup('cleanupHistory') };
}
