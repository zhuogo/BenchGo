import { normalizeTaskTitle } from './task-title.mjs';
import { taskPresentation, taskIsArchived, taskIsSettled } from './task-archive.mjs';

function activityTime(row) {
  for (const value of [row.updatedAt, row.createdAt]) {
    const time = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
    if (Number.isFinite(time)) return time;
  }
  return -Infinity;
}

/** Human list organization is separate from execution and acceptance state. */
export function createTaskManagement({ database, orchestration, goals, onTaskRename }) {
  const key = (kind, id) => `task-presentation:${kind}:${id}`;
  const settled = (kind, row) => kind === 'task' ? taskIsSettled(row) : kind === 'goal' || ['unavailable', 'decided'].includes(row.status);
  const executionRevision = (kind, row) => kind === 'task' ? row.instructionRevision ?? 1 : row.dispositionRevision ?? 0;
  const meta = (kind, row) => {
    if (kind === 'goal') return { version: row.rowVersion, title: row.objective, completed: row.status === 'completed', deleted: !!row.deleted };
    const stored = database.meta(key(kind, row.id)) || { version: 0 };
    if (kind === 'task') {
      const value = taskPresentation(row, stored);
      if (stored.title !== undefined) value.title = normalizeTaskTitle(stored.title, row.title || row.target);
      return value;
    }
    // A fresh execution must not inherit a previous run's completion or deletion.
    return (stored.completed || stored.deleted) && (!settled(kind, row) || stored.executionRevision !== executionRevision(kind, row))
      ? { ...stored, completed: false, deleted: false } : stored;
  };
  const project = (kind, rows, { archived } = {}) => rows.map(row => {
    const taskMeta = meta(kind, row);
    return { ...row, ...(kind === 'task' ? { archived: taskIsArchived(row, taskMeta),
      cleanup: taskMeta.archived && taskMeta.cleanupReceiptId ? { id: taskMeta.cleanupReceiptId, archivedAt: taskMeta.archivedAt, version: taskMeta.version } : null } : {}), taskMeta, taskCanOrganize: settled(kind, row) };
  })
    .filter(row => kind === 'task' ? archived === undefined || row.archived === archived : !row.taskMeta.deleted)
    // Stable sort retains the source order when activity timestamps are equal.
    .sort((a, b) => activityTime(b) - activityTime(a));
  function update({ kind, id, operation, title, version }) {
    if (!['task', 'goal', 'evaluation'].includes(kind) || typeof id !== 'string' || !id) throw new Error('无效任务标识');
    if (!['rename', 'complete', 'reopen', 'delete'].includes(operation)) throw new Error('无效任务操作');
    if (kind === 'task' && operation === 'delete') throw Object.assign(new Error('任务清理须先预览具体清单并取得本次确认'), { code: 'CLEANUP_PREVIEW_REQUIRED' });
    const result = database.transaction(() => {
      const row = kind === 'task' ? orchestration.getTask(id) : kind === 'goal' ? goals.getGoal(id) : orchestration.getEvaluation(id);
      if (!row) throw new Error('任务不存在');
      if (kind === 'task' && ['complete', 'reopen'].includes(operation)) throw Object.assign(new Error('任务完成由实际执行与交付确认，不能人工标记'), { code: 'TASK_COMPLETION_MANAGED' });
      const current = meta(kind, row);
      if (!Number.isSafeInteger(version) || version !== current.version) throw Object.assign(new Error('任务已变化，请刷新后重试'), { code: 'REVISION_CONFLICT' });
      if (kind !== 'task' && current.deleted) throw new Error('任务已删除');
      if (kind === 'goal') {
        const goal = goals.updateGoal(id, operation === 'rename' ? { objective: title } : operation === 'delete' ? { deleted: true } : { status: operation === 'complete' ? 'completed' : 'active' }, { rowVersion: version });
        return { id, kind, goal, taskMeta: meta(kind, goal) };
      }
      if (operation === 'rename' && (typeof title !== 'string' || !title.trim() || kind !== 'task' && title.trim().length > 200)) throw new Error(kind === 'task' ? '名称不能为空' : '名称须为 1 至 200 字');
      if (['complete', 'delete'].includes(operation)) {
        if (!settled(kind, row)) throw Object.assign(new Error('任务仍在执行或等待执行，请先停止，再进行此操作'), { code: 'EXECUTION_PENDING' });
      }
      const next = { ...current, version: current.version + 1, updatedAt: new Date().toISOString(),
        ...(operation === 'rename' ? { title: kind === 'task' ? normalizeTaskTitle(title) : title.trim() } : operation === 'delete' ? { deleted: true, executionRevision: executionRevision(kind, row) } : { completed: operation === 'complete', executionRevision: executionRevision(kind, row) }) };
      database.setMeta(key(kind, id), next);
      return { id, kind, taskMeta: next };
    });
    if (kind === 'task' && operation === 'rename') onTaskRename?.(id);
    return result;
  }
  const cleanup = name => (...args) => database.taskCleanup[name](...args);
  return { project, update,
    previewCleanup: cleanup('previewCleanup'), getCleanupPreview: cleanup('getCleanupPreview'),
    commitCleanup: cleanup('commitCleanup'), previewRestore: cleanup('previewRestore'), restoreCleanup: cleanup('restoreCleanup'),
    createCleanupConfirmation: cleanup('createConfirmation'), cleanupHistory: cleanup('cleanupHistory'),
    cleanupReceiptByRequest: cleanup('receiptForRequest') };
}
