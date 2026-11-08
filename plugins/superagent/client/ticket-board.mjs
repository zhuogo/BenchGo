import { ticketSnapshot, terminalTicketStates } from './ticket-state.mjs';

export const ticketLanes = Object.freeze([
  { id: 'queued', title: '待执行', empty: '没有等待执行的工单' },
  { id: 'running', title: '执行中', empty: '没有正在执行的工单' },
  { id: 'attention', title: '待处理', empty: '没有需要处理的工单' },
  { id: 'finished', title: '已结束', empty: '完成或停止后的工单会显示在这里' },
]);

/** Display metadata never overrides the durable execution state. */
export function ticketLane(ticket) {
  if (terminalTicketStates.has(ticket.status)) return 'finished';
  const { status, safetyWait } = ticketSnapshot(ticket);
  if (safetyWait) return 'attention';
  if (['claimed', 'running', 'reworking', 'reviewing', 'review_wait', 'pausing', 'cancelling'].includes(status)) return 'running';
  if (['open', 'queued'].includes(status)) return 'queued';
  // Unknown states stay visible for inspection, rather than looking completed.
  return 'attention';
}

export function filterTickets(rows, query = '') {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(row => !row.taskMeta?.deleted && (!words.length || words.every(word =>
    [row.id, row.title, row.taskMeta?.title, row.target, row.acceptance, row.projectId,
      row.mandate?.source?.channel, row.mandate?.source?.scheduleId]
      .filter(value => typeof value === 'string').join('\n').toLocaleLowerCase().includes(word))));
}

export function groupTickets(rows) {
  const groups = Object.fromEntries(ticketLanes.map(lane => [lane.id, []]));
  for (const row of rows) if (!row.taskMeta?.deleted) groups[ticketLane(row)].push(row);
  return ticketLanes.map(lane => ({ ...lane, rows: groups[lane.id] }));
}
