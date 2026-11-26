export const taskIsSettled = row => typeof row.executionExited === 'boolean' ? row.executionExited
  : row.status === 'completed' || row.executionControl?.stopped === true;
/** Rename and local display version stay here; archival never does. */
export const taskPresentationKey = id => `task-presentation:task:${id}`;

/**
 * Business waiting/completed alone cannot prove that an executor has exited.
 * This is a display fact only and never gates archival.
 */
export function taskExecutionExitedSql() {
  return `(sa_tasks.status<>'running'
    AND (sa_tasks.status='completed' OR json_extract(sa_tasks.execution_control,'$.stopped')=1
      OR EXISTS (SELECT 1 FROM sa_assignments a WHERE a.task_id=sa_tasks.id))
    AND NOT EXISTS (SELECT 1 FROM sa_assignments a WHERE a.task_id=sa_tasks.id AND a.state NOT IN ('completed','failed','cancelled'))
    AND NOT EXISTS (SELECT 1 FROM sa_runs r JOIN sa_assignments a ON a.id=r.assignment_id
      WHERE a.task_id=sa_tasks.id AND r.state NOT IN ('completed','failed','cancelled')))`;
}

/** Archival is the official Workspace archive set, projected onto Tasks. */
export function taskArchiveSql() {
  return `(EXISTS (SELECT 1 FROM sa_task_archive arch WHERE arch.task_id=sa_tasks.id))`;
}

/**
 * Only local display fields survive here. Archival is not a stored intent any
 * more: it is the official archive set, so nothing is derived from revisions.
 */
export function taskPresentation(row, stored = { version: 0 }) {
  const settled = taskIsSettled(row);
  return { ...stored,
    ...(stored.completed && (!settled || stored.executionRevision !== (row.instructionRevision ?? 1)) ? { completed: false } : {}) };
}
