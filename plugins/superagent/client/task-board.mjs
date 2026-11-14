export const taskLanes = Object.freeze([
  { id: 'running', title: '进行', empty: '没有正在推进的任务' },
  { id: 'waiting', title: '等待', empty: '没有等待中的任务' },
  { id: 'completed', title: '完成', empty: '成功完成的任务会保留在这里' },
]);

/** Display metadata never overrides the durable execution state. */
export function taskLane(task) {
  return taskLanes.some(lane => lane.id === task.status) ? task.status : 'waiting';
}

export function filterTasks(rows, query = '') {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(row => !row.taskMeta?.deleted && (!words.length || words.every(word =>
    [row.id, row.title, row.taskMeta?.title, row.target, row.acceptance, row.projectId,
      row.mandate?.source?.channel, row.mandate?.source?.scheduleId]
      .filter(value => typeof value === 'string').join('\n').toLocaleLowerCase().includes(word))));
}

export function groupTasks(rows) {
  const groups = Object.fromEntries(taskLanes.map(lane => [lane.id, []]));
  for (const row of rows) if (!row.taskMeta?.deleted) groups[taskLane(row)].push(row);
  return taskLanes.map(lane => ({ ...lane, rows: groups[lane.id] }));
}
