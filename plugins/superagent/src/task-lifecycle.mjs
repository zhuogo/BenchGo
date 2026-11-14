export const taskStates = Object.freeze(['running', 'waiting', 'completed']);
// Read compatibility for a status sentence saved by older runtimes. Preserve
// unknown text and all protocol/model identifiers instead of guessing aliases.
export function executionStatusText(value) {
  return typeof value === 'string' && /^Saved result is awaiting persistence\.?$/i.test(value.trim())
    ? '执行结果已暂存，尚未完成正式保存。' : value;
}
export const taskStopped = task => task?.executionControl?.stopRequested === true || task?.executionControl?.stopped === true;
export const taskPaused = task => task?.executionControl?.pauseRequested === true || task?.executionControl?.paused === true;
export const taskExecutionBlocked = task => task?.status === 'completed' || taskStopped(task) || taskPaused(task);
export function assertTaskStatus(status) {
  if (!taskStates.includes(status)) throw new Error('Invalid Task status');
  return status;
}
