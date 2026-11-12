import { createHash } from 'node:crypto';
import { executionEffects } from './execution-effects.mjs';

const mismatch = message => Object.assign(new Error(message), { code: 'EVIDENCE_MISMATCH' });
const recoveryUnavailable = (code, message) => Object.assign(new Error(message), { code });

/** Seed markers close storage handles; they do not start another execution. */
export function executionCompletion(events = []) {
  let terminal;
  for (const event of events) {
    if (['turn/start', 'step/start', 'assistant/message', 'tool/result', 'user/message'].includes(event.type)) terminal = undefined;
    if (event.type === 'turn/end') terminal = { ...event.data?.reason,
      ...(event.time !== undefined && Number.isFinite(new Date(event.time).getTime()) ? { at: new Date(event.time).toISOString() } : {}) };
  }
  return terminal;
}

/** A pause is resumable only on the official pre-step rejection ending. */
export function isVerifiedPauseEnding(reason) {
  return reason?.kind === 'blocked';
}

/** The result is the Worker's last message; the whole process stays in the official session. */
export function executionEvidence(log) {
  const events = log.events || [];
  const texts = events.filter(event => event.type === 'assistant/message')
    .map(event => (event.data?.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n'))
    .filter(text => text.trim());
  return {
    summary: texts.at(-1) || '',
    transcript: { lastSeq: events.at(-1)?.seq ?? null, hash: createHash('sha256').update(JSON.stringify(events)).digest('hex') },
  };
}

export function recoveryStorage(ctx) {
  return ctx.get ? ctx.get('sessionPersistence') : ctx.sessionPersistence;
}

/** Reuse an idle host session or hold the official writer lock without running an Agent. */
export function withRecoveredEvidence(input, action) {
  return inspectRecoveredExecution(input, action, false);
}

export function withRecoveredPause(input, action) {
  return inspectRecoveredExecution(input, action, true);
}

async function inspectRecoveredExecution({ ctx, run, signal }, action, paused) {
  signal.throwIfAborted();
  const persistence = recoveryStorage(ctx);
  if (!persistence?.open || !ctx.agents?.get) throw recoveryUnavailable('SESSION_UNAVAILABLE', 'Official session ownership cannot be verified');
  const live = ctx.agents.get(run.sessionId);
  if (live && (paused || live.status !== 'idle' || !live.session?.snapshotEvents || !ctx.sessions?.flush)) throw recoveryUnavailable('SESSION_STILL_LIVE', 'Previous session is still live');
  let handle;
  if (live) await ctx.sessions.flush(live.session);
  else handle = await persistence.open(run.sessionId, 'write', { signal });
  try {
    signal.throwIfAborted();
    if (handle && (handle.id !== run.sessionId || handle.access !== 'write')) throw recoveryUnavailable('SESSION_UNAVAILABLE', 'Unexpected session ownership');
    if (live && (ctx.agents.get(run.sessionId) !== live || live.status !== 'idle' || live.session.id !== run.sessionId)) throw recoveryUnavailable('SESSION_STILL_LIVE', 'Previous session is still live');
    const log = live ? { events: live.session.snapshotEvents() } : await handle.read(undefined, undefined, { signal });
    const observed = executionEvidence(log), observedEffects = executionEffects(log, new Map(Object.entries(run.evidence?.toolReceipts || {}))), saved = run.evidence;
    if (!paused) {
      // Preserve the host's saved draft exactly. Hash/seed/projection differences
      // are diagnostics, never an admission gate for an already produced result.
      const completion = executionCompletion(log.events);
      const diagnostics = [];
      if (saved?.transcript?.hash !== observed.transcript.hash) diagnostics.push('TRANSCRIPT_CHANGED');
      const result = { ...observed, ...saved, runId: run.id, sessionId: run.sessionId, directory: run.directory,
        completion,
        executionEffects: saved?.executionEffects ?? observedEffects,
        recoveryObservation: { ...observed.transcript, diagnostics } };
      return await action(result, { sessionId: run.sessionId, completed: completion?.kind === 'completed', ...observed.transcript });
    }
    if (!saved || saved.runId !== run.id || saved.sessionId !== run.sessionId || !Number.isSafeInteger(saved.transcript?.lastSeq)
      || saved.transcript.lastSeq !== observed.transcript.lastSeq || saved.transcript.hash !== observed.transcript.hash || saved.summary !== observed.summary) throw mismatch('Persisted execution evidence does not match the official transcript');
    if (paused && saved.executionEffects !== undefined && JSON.stringify(saved.executionEffects) !== JSON.stringify(observedEffects)) throw mismatch('Persisted execution effects do not match the official transcript');
    let terminal;
    for (const event of log.events) {
      if (['turn/start', 'step/start', 'assistant/message', 'tool/result', 'user/message'].includes(event.type)) terminal = undefined;
      if (event.type === 'turn/end') terminal = event;
    }
    if (paused ? !isVerifiedPauseEnding(terminal?.data?.reason) : terminal?.data?.reason?.kind !== 'completed') throw recoveryUnavailable('EXECUTION_END_UNVERIFIED', paused ? 'Previous execution has no verified pause ending' : 'Previous execution has no verified normal ending');
    if (paused && saved.waitingPause !== true) throw new Error('Execution has no saved explicit pause');
    // The original session and saved Run remain authoritative. File changes are
    // ordinary working state, not a reason to scan or restore the whole directory.
    if (saved.directory !== run.directory || JSON.stringify(saved.environment) !== JSON.stringify(run.environment))
      throw mismatch('Saved execution directory belongs to another execution');
    signal.throwIfAborted();
    // No asynchronous boundary between this check and the atomic acceptance callback.
    if (live && (ctx.agents.get(run.sessionId) !== live || live.status !== 'idle'
      || executionEvidence({ events: live.session.snapshotEvents() }).transcript.hash !== observed.transcript.hash)) throw mismatch('Official session changed before result acceptance');
    return await action({ ...saved, executionEffects: observedEffects }, { sessionId: run.sessionId, completed: !paused, paused, ...observed.transcript });
  } finally { if (handle) await handle.close(); }
}
