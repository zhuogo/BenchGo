import { normalizeTicketTitle } from './ticket-title.mjs';

/** Human list organization is separate from execution and acceptance state. */
export function createTaskManagement({ database, orchestration, scheduler }) {
  const key = (kind, id) => `task-presentation:${kind}:${id}`;
  const settled = (kind, row) => (kind === 'ticket' ? ['completed', 'failed', 'closed', 'cancelled'] : kind === 'goal' ? ['completed', 'failed', 'cancelled'] : ['unavailable', 'decided']).includes(row.status);
  const executionRevision = (kind, row) => kind === 'ticket' ? row.instructionRevision ?? 1 : kind === 'goal' ? row.rowVersion ?? 0 : row.dispositionRevision ?? 0;
  const meta = (kind, row) => {
    const stored = database.meta(key(kind, row.id)) || { version: 0 };
    const value = kind === 'ticket' && stored.title !== undefined
      ? { ...stored, title: normalizeTicketTitle(stored.title, row.title || row.target) } : stored;
    // A fresh execution must not inherit a previous run's completion or deletion.
    return (value.completed || value.deleted) && (!settled(kind, row) || value.executionRevision !== executionRevision(kind, row))
      ? { ...value, completed: false, deleted: false } : value;
  };
  const project = (kind, rows) => rows.map(row => ({ ...row, taskMeta: meta(kind, row), taskCanOrganize: settled(kind, row) })).filter(row => !row.taskMeta.deleted);
  function update({ kind, id, operation, title, version }) {
    if (!['ticket', 'goal', 'evaluation'].includes(kind) || typeof id !== 'string' || !id) throw new Error('无效任务标识');
    if (!['rename', 'complete', 'reopen', 'delete'].includes(operation)) throw new Error('无效任务操作');
    return database.transaction(() => {
      const row = kind === 'ticket' ? orchestration.getTicket(id) : kind === 'goal' ? scheduler.getGoal(id) : orchestration.getEvaluation(id);
      if (!row) throw new Error('任务不存在');
      const current = meta(kind, row);
      if (!Number.isSafeInteger(version) || version !== current.version) throw Object.assign(new Error('任务已变化，请刷新后重试'), { code: 'REVISION_CONFLICT' });
      if (current.deleted) throw new Error('任务已删除');
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
  return { project, update };
}
