import { taskExecutionBlocked } from './task-lifecycle.mjs';

export function isTaskStateNotice(value) {
  return value?.type === 'task.result' && value.publication?.origin === 'system'
    && ['continuation_wait', 'delivery_wait'].includes(value.publication.systemState?.state);
}

/** Failure facts come from the execution ledger, never inferred by the Router. */
export function taskStateSignal(database, delivery) {
  const task = database.getTask(delivery.taskId), payload = delivery.payload;
  if (!isTaskStateNotice(payload) || !task
    || taskExecutionBlocked(task) || task.instructionRevision !== payload.instructionRevision
    || task.resultVersion !== payload.resultVersion) return null;
  const state = payload.publication.systemState;
  const assignment = database.assignments(task.id).find(row => ['uncertain', 'failed'].includes(row.state)
    && row.lastFailure?.code === state.code && row.lastFailure?.stage === state.stage
    && (!payload.assignmentId || row.id === payload.assignmentId && row.fence === payload.fence));
  if (state.state === 'continuation_wait' && !assignment) return null;
  return { eventKey: delivery.uniqueKey, taskId: task.id, title: task.title, status: task.status,
    instructionRevision: task.instructionRevision, resultVersion: task.resultVersion,
    state: state.state, code: state.code, stage: state.stage,
    ...(assignment ? { assignmentId: assignment.id, fence: assignment.fence, executionState: assignment.state,
      ...(assignment.firstFailure ? { failure: assignment.firstFailure } : {}) } : {}) };
}
