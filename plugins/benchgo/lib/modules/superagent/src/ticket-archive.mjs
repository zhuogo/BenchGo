export const settledTicketStates = Object.freeze(['completed', 'failed', 'closed', 'cancelled']);
export const automaticArchiveStates = Object.freeze(['completed', 'failed', 'closed']);
export const ticketPresentationKey = id => `task-presentation:ticket:${id}`;

/** Current Ticket presentation; legacy hidden rows are migrated on store open. */
export function ticketPresentation(row, stored = { version: 0 }) {
  const settled = settledTicketStates.includes(row.status);
  const current = settled && stored.archiveRevision === (row.instructionRevision ?? 1);
  return { ...stored,
    ...(stored.archived ? { archived: current } : {}),
    ...(stored.completed && (!settled || stored.executionRevision !== (row.instructionRevision ?? 1)) ? { completed: false } : {}) };
}
export function ticketIsArchived(row, stored) {
  return automaticArchiveStates.includes(row.status) || ticketPresentation(row, stored).archived === true;
}

/** Apply the same visibility predicate in SQL before ORDER/LIMIT/OFFSET. */
export function ticketArchiveSql() {
  const automatic = `status IN ('completed','failed','closed')`;
  return `(${automatic} OR (status IN ('completed','failed','closed','cancelled') AND EXISTS (
    SELECT 1 FROM task_meta tm WHERE tm.key='task-presentation:ticket:' || sa_tickets.id
      AND json_extract(tm.value,'$.archiveRevision')=sa_tickets.instruction_revision
      AND json_extract(tm.value,'$.archived')=1)))`;
}
