import { interruptedTurnClosers } from '@deepseek-ai/dsh-session';
import { executionEvidence, recoveryStorage } from './execution-evidence.mjs';
import { executionEffects } from './execution-effects.mjs';
import { validateTaskMandate } from './assessment-policy.mjs';
import { taskExecutionBlocked } from './task-lifecycle.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });

/** Validate only the official crash-repair suffix; never generate or append log events. */
export function verifyInterruptedTranscript(events, saved) {
  const prefix = events.filter(event => event.seq <= saved?.transcript?.lastSeq);
  const suffix = events.filter(event => event.seq > saved?.transcript?.lastSeq);
  const observed = executionEvidence({ events: prefix });
  if (observed.transcript.hash !== saved?.transcript?.hash || observed.transcript.lastSeq !== saved.transcript.lastSeq) {
    throw fail('EVIDENCE_MISMATCH', 'Interrupted execution transcript changed');
  }
  const expected = interruptedTurnClosers(prefix);
  const repair = suffix.slice(0, expected.length), tail = suffix.slice(expected.length);
  if (JSON.stringify(repair) !== JSON.stringify(expected) || tail.length > 1 || tail.some(event => event.type !== 'session/end-seed')) {
    throw fail('EVIDENCE_MISMATCH', 'Unexpected events appeared before interrupted continuation');
  }
}

/** Inspect the original session under the live writer or a cold write handle. */
export async function requestInterruptedContinuation({ ctx, database, assignmentId, fence, instructionRevision, readPolicy, signal, now = Date.now() }) {
  signal.throwIfAborted();
  const assignment = database.getAssignment(assignmentId), task = assignment && database.getTask(assignment.taskId);
  const run = database.runs(assignmentId).find(item => item.fence === fence);
  if (!assignment || !['uncertain', 'failed'].includes(assignment.state) || assignment.fence !== fence || !run || !['uncertain', 'verifying', 'failed'].includes(run.state)
    || assignment.stopRequest || !task || taskExecutionBlocked(task)) throw fail('FENCING_CONFLICT', 'Original execution is not available for continuation');
  if (task.instructionRevision !== instructionRevision) throw fail('INSTRUCTION_REVISION_CONFLICT', 'Original execution requirements changed');
  if (!database.getWorkerExecutionState(run.id)?.models?.length) throw fail('WORKER_MODEL_ROUTE', 'Original frozen Worker model is unavailable');
  if (database.attentions(task.id).some(row => row.state === 'waiting')) throw fail('EXECUTION_PAUSE_UNVERIFIED', 'Original execution is waiting for a user answer');
  const persistence = recoveryStorage(ctx);
  if (!persistence?.open || !ctx.agents?.get || !ctx.agents?.resume) throw fail('SESSION_UNAVAILABLE', 'Official session recovery is unavailable');
  const live = ctx.agents.get(run.sessionId);
  const idle = () => live?.status === 'idle' && live.session?.id === run.sessionId && ctx.agents.get(run.sessionId) === live;
  if (live && (!idle() || !live.session.snapshotEvents || !ctx.sessions?.flush))
    throw fail('SESSION_STILL_LIVE', 'Original execution has not reached an idle boundary');
  const handle = live ? null : await persistence.open(run.sessionId, 'write', { signal });
  try {
    if (handle && (handle.id !== run.sessionId || handle.access !== 'write')) throw fail('SESSION_UNAVAILABLE', 'Original session writer ownership could not be verified');
    if (live && await ctx.sessions.flush(live.session) === false) throw fail('SESSION_UNAVAILABLE', 'Original session could not be flushed');
    if (live && !idle()) throw fail('SESSION_STILL_LIVE', 'Original execution has not reached an idle boundary');
    const log = live ? { events: live.session.snapshotEvents() } : await handle.read(0, undefined, { signal });
    const events = log.events || [], last = events.at(-1);
    if (!events.some(event => event.type === 'turn/start') || !Number.isSafeInteger(last?.seq)) throw fail('EVIDENCE_MISMATCH', 'Original execution has no verifiable turn');
    const toolReceipts = run.evidence?.toolReceipts || {};
    const closers = interruptedTurnClosers(events);
    const terminal = closers.at(-1) || [...events].reverse().find(event => event.type === 'turn/end');
    // A cancelled turn can accept a new instruction. The Task's own stop
    // request is checked separately before reclaiming the original Run.
    const ending = terminal?.data?.reason;
    const resumable = ['interrupted', 'error'].includes(ending?.kind)
      || ending?.kind === 'aborted' && ['disposed', 'user'].includes(ending.reason?.kind);
    if (!resumable) throw fail('EXECUTION_PAUSE_UNVERIFIED', 'Execution has no resumable interrupted ending');
    const evidence = { ...executionEvidence(log), executionEffects: executionEffects(log, new Map(Object.entries(toolReceipts))), toolReceipts, directory: run.directory,
      ...(run.environment ? { environment: run.environment } : {}), runId: run.id, sessionId: run.sessionId, interrupted: true };
    const policy = await readPolicy();
    signal.throwIfAborted();
    if (live && (!idle() || executionEvidence({ events: live.session.snapshotEvents() }).transcript.hash !== evidence.transcript.hash))
      throw fail('SESSION_STILL_LIVE', 'Original execution changed during continuation admission');
    const result = database.queueInterruptedContinuation(assignmentId, { fence, runId: run.id, instructionRevision,
      evidence, now, mandate: task.mandate, validateMandate: mandate => validateTaskMandate(mandate, { policy }) });
    return { state: 'queued', assignment: result };
  } finally { await handle?.close(); }
}
