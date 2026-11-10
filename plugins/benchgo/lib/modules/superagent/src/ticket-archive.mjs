export const ticketIsSettled = row => row.status === 'completed' || row.executionControl?.stopped === true;
export const ticketPresentationKey = id => `task-presentation:ticket:${id}`;

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
  return `((status='completed' OR json_extract(execution_control,'$.stopped')=1) AND EXISTS (
    SELECT 1 FROM task_meta tm WHERE tm.key='task-presentation:ticket:' || sa_tickets.id
      AND json_extract(tm.value,'$.archiveRevision')=sa_tickets.instruction_revision
      AND json_extract(tm.value,'$.archived')=1))`;
}
