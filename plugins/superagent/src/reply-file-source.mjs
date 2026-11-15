const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const unavailable = () => Object.assign(new Error('无法核验这条交付文件的原执行设备，请从原任务打开执行记录后重试。'), { code: 'REPLY_FILE_SOURCE_UNAVAILABLE' });
const same = (left, right, keys) => keys.every(key => left?.[key] === right?.[key]);

/** Resolve display provenance from the original admitted request, never a path or latest run.
 * requestSource must come from the authorized session's original user/message event. */
export function resolveReplyFileSource({ database, state, threadId = 'main', sessionId, requestId, requestSource }) {
  if (![sessionId, requestId].every(identity)) throw unavailable();
  const receipts = (state?.requests || []).filter(row => row.messageId === requestId);
  if (receipts.some(row => row.threadId !== threadId || row.sessionId !== sessionId)) throw unavailable();
  if (receipts.length > 1) throw unavailable();
  const receipt = receipts[0], signal = receipt?.taskReply;
  const source = requestSource ?? receipt?.message?.source;
  if (signal) {
    if (signal.kind !== 'result' || source && (source.kind !== 'benchgo-task-reply' || source.replyKind !== 'result'
      || !same(source, signal, ['taskId', 'eventKey']))) throw unavailable();
  } else if (['user', 'user-question-reply'].includes(source?.kind)) return { remote: false };
  else if (source?.kind !== 'benchgo-task-reply' || source.replyKind !== 'result') throw unavailable();

  const binding = signal || source;
  if (![binding.taskId, binding.eventKey].every(identity)) throw unavailable();
  const task = database.getTask(binding.taskId);
  if (!task) throw unavailable();
  // resultNotification() intentionally only resolves current notifications. The
  // durable delivery key also resolves historical replies after later revisions.
  const results = database.results(task.id).filter(result => result.deliveryKey === binding.eventKey);
  if (results.length !== 1) throw unavailable();
  const result = results[0];
  if (signal && (result.version !== signal.resultVersion || result.instructionRevision !== signal.instructionRevision)
    || result.reply && (result.reply.sessionId !== sessionId || result.reply.requestId !== requestId)
    || ![result.runId, result.sessionId].every(identity)) throw unavailable();
  const executions = database.assignments(task.id).flatMap(assignment => database.runs(assignment.id)
    .filter(run => run.id === result.runId && run.sessionId === result.sessionId).map(run => ({ assignment, run })));
  if (executions.length !== 1) throw unavailable();
  const { assignment, run } = executions[0];
  const remote = database.remoteExecution?.(assignment.id) || assignment.remoteExecution;
  if (!remote && assignment.executor === 'harness' && !assignment.execution) return { remote: false };
  // The assignment and remote binding freeze device identity. The Task's current
  // mandate may now target a different device and is never a historical fallback.
  const frozen = assignment.execution;
  if (!remote || remote.runId !== run.id || remote.sessionId !== run.sessionId
    || frozen && !same(remote, frozen, ['deviceId', 'hostId', 'authorizationId'])) throw unavailable();
  const ownerHostId = task.ownerHostId || database.ownerHostId?.();
  const keys = ['deviceId', 'hostId', 'authorizationId', 'sessionId', 'executionId'];
  if (![...keys.map(key => remote[key]), ownerHostId].every(identity) || remote.deviceId === 'local') throw unavailable();
  return { remote: true, available: true, taskId: task.id, ownerHostId,
    assignmentId: assignment.id, runId: run.id, ...Object.fromEntries(keys.map(key => [key, remote[key]])),
    ...(identity(frozen?.deviceName) ? { deviceName: frozen.deviceName } : {}) };
}
