export const taskIsSettled = row => typeof row.executionExited === 'boolean' ? row.executionExited
  : row.status === 'completed' || row.executionControl?.stopped === true;
export const taskPresentationKey = id => `task-presentation:task:${id}`;

/** Business waiting/completed alone cannot prove that an executor has exited. */
export function taskExecutionExitedSql() {
  return `(sa_tasks.status<>'running'
    AND (sa_tasks.status='completed' OR json_extract(sa_tasks.execution_control,'$.stopped')=1
      OR EXISTS (SELECT 1 FROM sa_assignments a WHERE a.task_id=sa_tasks.id))
    AND NOT EXISTS (SELECT 1 FROM sa_assignments a WHERE a.task_id=sa_tasks.id AND a.state NOT IN ('completed','failed','cancelled'))
    AND NOT EXISTS (SELECT 1 FROM sa_runs r JOIN sa_assignments a ON a.id=r.assignment_id
      WHERE a.task_id=sa_tasks.id AND r.state NOT IN ('completed','failed','cancelled')))`;
}

/** Archival is an explicit user presentation choice and never follows completion. */
export function taskPresentation(row, stored = { version: 0 }) {
  const settled = taskIsSettled(row);
  const current = settled && stored.archiveRevision === (row.instructionRevision ?? 1);
  return { ...stored,
    ...(stored.archived ? { archived: current } : {}),
    ...(stored.completed && (!settled || stored.executionRevision !== (row.instructionRevision ?? 1)) ? { completed: false } : {}) };
}
export function taskIsArchived(row, stored) {
  return taskPresentation(row, stored).archived === true;
}

/** Apply the same manual visibility predicate before ORDER/LIMIT/OFFSET. */
export function taskArchiveSql() {
  return `(${taskExecutionExitedSql()} AND EXISTS (
    SELECT 1 FROM task_meta tm WHERE tm.key='task-presentation:task:' || sa_tasks.id
      AND json_extract(tm.value,'$.archiveRevision')=sa_tasks.instruction_revision
      AND json_extract(tm.value,'$.archived')=1))`;
}
