export const ticketIsSettled = row => typeof row.executionExited === 'boolean' ? row.executionExited
  : row.status === 'completed' || row.executionControl?.stopped === true;
export const ticketPresentationKey = id => `task-presentation:ticket:${id}`;

/** Business waiting/completed alone cannot prove that an executor has exited. */
export function ticketExecutionExitedSql() {
  return `(sa_tickets.status<>'running'
    AND (sa_tickets.status='completed' OR json_extract(sa_tickets.execution_control,'$.stopped')=1
      OR EXISTS (SELECT 1 FROM sa_assignments a WHERE a.ticket_id=sa_tickets.id))
    AND NOT EXISTS (SELECT 1 FROM sa_assignments a WHERE a.ticket_id=sa_tickets.id AND a.state NOT IN ('completed','failed','cancelled'))
    AND NOT EXISTS (SELECT 1 FROM sa_runs r JOIN sa_assignments a ON a.id=r.assignment_id
      WHERE a.ticket_id=sa_tickets.id AND r.state NOT IN ('completed','failed','cancelled')))`;
}

/** Archival is an explicit user presentation choice and never follows completion. */
export function ticketPresentation(row, stored = { version: 0 }) {
  const settled = ticketIsSettled(row);
  const current = settled && stored.archiveRevision === (row.instructionRevision ?? 1);
  return { ...stored,
    ...(stored.archived ? { archived: current } : {}),
    ...(stored.completed && (!settled || stored.executionRevision !== (row.instructionRevision ?? 1)) ? { completed: false } : {}) };
}
export function ticketIsArchived(row, stored) {
  return ticketPresentation(row, stored).archived === true;
}

/** Apply the same manual visibility predicate before ORDER/LIMIT/OFFSET. */
export function ticketArchiveSql() {
  return `(${ticketExecutionExitedSql()} AND EXISTS (
    SELECT 1 FROM task_meta tm WHERE tm.key='task-presentation:ticket:' || sa_tickets.id
      AND json_extract(tm.value,'$.archiveRevision')=sa_tickets.instruction_revision
      AND json_extract(tm.value,'$.archived')=1))`;
}
