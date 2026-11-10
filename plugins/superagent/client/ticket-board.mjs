export const ticketLanes = Object.freeze([
  { id: 'running', title: '进行', empty: '没有正在推进的工单' },
  { id: 'waiting', title: '等待', empty: '没有等待中的工单' },
  { id: 'completed', title: '完成', empty: '成功完成的工单会保留在这里' },
]);

/** Display metadata never overrides the durable execution state. */
export function ticketLane(ticket) {
  return ticketLanes.some(lane => lane.id === ticket.status) ? ticket.status : 'waiting';
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
