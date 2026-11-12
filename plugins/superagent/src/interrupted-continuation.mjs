import { interruptedTurnClosers } from '@deepseek-ai/dsh-session';
import { executionEvidence, recoveryStorage } from './execution-evidence.mjs';
import { executionEffects } from './execution-effects.mjs';
import { validateTicketMandate } from './assessment-policy.mjs';
import { ticketExecutionBlocked } from './ticket-lifecycle.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });

/** A read-only tool with no receipt is also unfinished; effects alone are insufficient. */
export function assertInterruptedToolsSettled(events) {
  const pending = new Set(), seen = new Set();
  const add = (kind, id) => {
    const key = `${kind}:${id}`;
    if (!id || seen.has(key)) throw fail('EXECUTION_EFFECTS_UNKNOWN', 'Tool identity is missing or duplicated');
    seen.add(key); pending.add(key);
  };
  const settle = (kind, id) => {
    if (!pending.delete(`${kind}:${id}`)) throw fail('EXECUTION_EFFECTS_UNKNOWN', 'Tool receipt has no matching call');
  };
  for (const event of events) {
    if (event.type === 'assistant/message') for (const block of event.data?.message?.content || []) {
      if (block.type === 'tool-call') add('tool', block.id);
    }
    if (event.type === 'tool/result') settle('tool', event.data?.message?.toolCallId ?? event.data?.message?.source?.callId);
    if (event.type === 'tool/ptc-dispatch-start') add('ptc', event.data?.subCallId);
    if (event.type === 'tool/ptc-dispatch') settle('ptc', event.data?.subCallId);
  }
  if (pending.size) throw fail('EXECUTION_EFFECTS_UNKNOWN', 'Interrupted execution still has unanswered tools');
  const effects = executionEffects({ events });
  if (!effects.effectsVerified) throw fail('EXECUTION_EFFECTS_UNKNOWN', 'External effects must be reconciled before continuation');
  return effects;
}

/** Validate only the official crash-repair suffix; never generate or append log events. */
export function verifyInterruptedTranscript(events, saved) {
  const prefix = events.filter(event => event.seq <= saved?.transcript?.lastSeq);
  const suffix = events.filter(event => event.seq > saved?.transcript?.lastSeq);
  const observed = executionEvidence({ events: prefix });
  if (observed.transcript.hash !== saved?.transcript?.hash || observed.transcript.lastSeq !== saved.transcript.lastSeq
    || JSON.stringify(assertInterruptedToolsSettled(prefix)) !== JSON.stringify(saved.executionEffects)) {
    throw fail('EVIDENCE_MISMATCH', 'Interrupted execution transcript changed');
  }
  const expected = interruptedTurnClosers(prefix);
  const repair = suffix.slice(0, expected.length), tail = suffix.slice(expected.length);
  if (JSON.stringify(repair) !== JSON.stringify(expected) || tail.length > 1 || tail.some(event => event.type !== 'session/end-seed')) {
    throw fail('EVIDENCE_MISMATCH', 'Unexpected events appeared before interrupted continuation');
  }
}

/** Lock the original official session, inspect it, then queue the same run; no Agent executes here. */
export async function requestInterruptedContinuation({ ctx, database, assignmentId, fence, instructionRevision, readPolicy, signal, now = Date.now() }) {
  signal.throwIfAborted();
  const assignment = database.getAssignment(assignmentId), ticket = assignment && database.getTicket(assignment.ticketId);
  const run = database.runs(assignmentId).find(item => item.fence === fence);
  if (!assignment || assignment.state !== 'uncertain' || assignment.fence !== fence || !run || run.state !== 'uncertain'
    || assignment.stopRequest || assignment.retiredExecution || !ticket || ticketExecutionBlocked(ticket)) throw fail('FENCING_CONFLICT', 'Original execution is not available for continuation');
  if (ticket.instructionRevision !== instructionRevision || assignment.instructionRevision !== instructionRevision) throw fail('INSTRUCTION_REVISION_CONFLICT', 'Original execution requirements changed');
  if (!database.getWorkerExecutionState(run.id)?.models?.length) throw fail('WORKER_MODEL_ROUTE', 'Original frozen Worker model is unavailable');
  if (database.attentions(ticket.id).some(row => row.state === 'waiting')) throw fail('EXECUTION_PAUSE_UNVERIFIED', 'Original execution is waiting for a user answer');
  const persistence = recoveryStorage(ctx);
  if (!persistence?.open || !ctx.agents?.get || !ctx.agents?.resume) throw fail('SESSION_UNAVAILABLE', 'Official session recovery is unavailable');
  if (ctx.agents.get(run.sessionId)) throw fail('SESSION_STILL_LIVE', 'Original execution still owns its session');
  const handle = await persistence.open(run.sessionId, 'write', { signal });
  try {
    if (handle.id !== run.sessionId || handle.access !== 'write') throw fail('SESSION_UNAVAILABLE', 'Original session writer ownership could not be verified');
    const log = await handle.read(0, undefined, { signal });
    const events = log.events || [], last = events.at(-1);
    if (!events.some(event => event.type === 'turn/start') || !Number.isSafeInteger(last?.seq)) throw fail('EVIDENCE_MISMATCH', 'Original execution has no verifiable turn');
    const executionEffects = assertInterruptedToolsSettled(events);
    const closers = interruptedTurnClosers(events);
    const terminal = closers.at(-1) || [...events].reverse().find(event => event.type === 'turn/end');
    // User cancellation, a pause and completed results keep their existing dedicated paths.
    if (!['interrupted', 'error'].includes(terminal?.data?.reason?.kind) || closers.some(event => event.type === 'tool/result')) throw fail('EXECUTION_PAUSE_UNVERIFIED', 'Execution has no safely resumable interrupted ending');
    const evidence = { ...executionEvidence(log), executionEffects, directory: run.directory,
      ...(run.environment ? { environment: run.environment } : {}), runId: run.id, sessionId: run.sessionId, interrupted: true };
    const policy = await readPolicy();
    signal.throwIfAborted();
    const result = database.queueInterruptedContinuation(assignmentId, { fence, runId: run.id, instructionRevision,
      evidence, now, mandate: ticket.mandate, validateMandate: mandate => validateTicketMandate(mandate, { policy }) });
    return { state: 'queued', assignment: result };
  } finally { await handle.close(); }
}
