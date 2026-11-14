import { taskExecutionBlocked } from './task-lifecycle.mjs';
/** Drain source additions on the existing execution; receipts remain owned by the inbox. */
export async function continueWorkerContext({ database, assignment, signal, runTurn, isWaiting = () => false, maxTurns = 8 }) {
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error('Invalid context continuation limit');
  let turns = 0;
  const pendingInputs = () => [...database.pendingSubscriptionMessages(assignment.taskId),
    ...database.pendingTaskInputs(assignment.taskId).filter(row => ['revision', 'authorization'].includes(row.kind))];
  for (;;) {
    signal?.throwIfAborted();
    if (isWaiting() || taskExecutionBlocked(database.getTask(assignment.taskId))) return { turns, waiting: true };
    const pending = pendingInputs();
    if (!pending.length) return { turns, waiting: false };
    if (turns >= maxTurns) throw new Error('Worker source context continuation limit exceeded; reconciliation required');
    const ids = new Set(pending.map(message => message.id));
    // runTurn must reuse the live Agent and wait for its next idle boundary.
    // Only its ordinary inbox/model-stream hook can acknowledge source messages.
    await runTurn();
    turns++;
    signal?.throwIfAborted();
    if (isWaiting()) return { turns, waiting: true };
    const remaining = pendingInputs();
    if (remaining.some(message => ids.has(message.id))) throw new Error('Worker did not consume pending source context; reconciliation required');
  }
}
