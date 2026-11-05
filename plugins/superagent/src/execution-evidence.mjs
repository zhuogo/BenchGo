import { createHash } from 'node:crypto';
import { verifyArtifactCheckpoint } from './worker-artifact-checkpoint.mjs';
import { isVerifiedPauseEnding } from './goal-budget-gate.mjs';
import { executionEffects } from './execution-effects.mjs';

export async function verifyExecutionArtifacts(run, result, signal) {
  if (!run?.environment) throw new Error('Project execution environment is unavailable');
  if (!result?.checkpoint) throw new Error('Project execution recovery requires a verified artifact checkpoint');
  if (JSON.stringify(run.environment) !== JSON.stringify(result.environment)
    || JSON.stringify(run.evidence?.checkpoint) !== JSON.stringify(result.checkpoint)
    || result.directory !== run.environment.path || result.runId !== run.id || result.sessionId !== run.sessionId) throw new Error('Artifact evidence belongs to another execution');
  return verifyArtifactCheckpoint(run.environment, result.checkpoint, { signal });
}

export function executionEvidence(log) {
  const events = log.events || [];
  const assistantTexts = events.filter(event => event.type === 'assistant/message')
    .map(event => (event.data?.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n'))
    .filter(text => text.trim());
  return {
    summary: events.filter(event => event.type === 'assistant/message')
      .flatMap(event => (event.data?.message?.content || []).filter(block => block.type === 'text').map(block => block.text)).join('\n'),
    finalSummary: assistantTexts.at(-1) || '',
    transcript: { lastSeq: events.at(-1)?.seq ?? null, hash: createHash('sha256').update(JSON.stringify(events)).digest('hex') },
    toolEvidence: projectToolEvidence(events),
  };
}

/** Host-derived, bounded tool evidence; never project reasoning or binary content. */
function projectToolEvidence(events) {
  const calls = new Map(), results = [];
  for (const event of events) {
    const message = event.data?.message;
    if (event.type === 'assistant/message') {
      for (const block of message?.content || []) if (block.type === 'tool-call') calls.set(block.id, block);
    }
    if (event.type !== 'tool/result') continue;
    const callId = message?.toolCallId ?? message?.source?.callId;
    const call = calls.get(callId);
    const text = (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    const args = typeof call?.arguments === 'string' ? call.arguments : JSON.stringify(call?.arguments ?? null);
    const raw = { seq: event.seq, callId, name: call?.name, arguments: args, text,
      isError: message?.isError === true || !!event.data?.error };
    results.push({ ...raw, arguments: args.slice(0, 2000), text: text.slice(0, 4000),
      argumentsLength: args.length, textLength: text.length,
      truncated: args.length > 2000 || text.length > 4000,
      hash: createHash('sha256').update(JSON.stringify(raw)).digest('hex') });
  }
  const entries = [];
  let size = 0;
  // Prefer recent verification results; preserve original order in the projection.
  for (let index = results.length - 1; index >= 0 && entries.length < 64; index--) {
    const entry = results[index], length = JSON.stringify(entry).length;
    if (size + length > 24000) break;
    entries.unshift(entry); size += length;
  }
  return { entries, total: results.length, omitted: results.length - entries.length,
    failedCount: results.filter(entry => entry.isError).length,
    truncated: entries.length !== results.length || entries.some(entry => entry.truncated) };
}

export function recoveryStorage(ctx) {
  return ctx.get?.('sessionPersistence') || ctx.sessionPersistence;
}

/** Hold the official writer lock without appending or running an Agent. */
export function withRecoveredEvidence(input, action) {
  return inspectRecoveredExecution(input, action, false);
}

export function withRecoveredPause(input, action) {
  return inspectRecoveredExecution(input, action, true);
}

async function inspectRecoveredExecution({ ctx, run, signal }, action, paused) {
  signal.throwIfAborted();
  const persistence = recoveryStorage(ctx);
  if (!persistence?.open || !ctx.agents?.get) throw new Error('Official session ownership cannot be verified');
  if (ctx.agents.get(run.sessionId)) throw new Error('Previous session is still live');
  const handle = await persistence.open(run.sessionId, 'write', { signal });
  try {
    signal.throwIfAborted();
    if (handle.id !== run.sessionId || handle.access !== 'write') throw new Error('Unexpected session ownership');
    const log = await handle.read(undefined, undefined, { signal });
    const observed = executionEvidence(log), observedEffects = executionEffects(log), saved = run.evidence;
    if (!saved || saved.runId !== run.id || saved.sessionId !== run.sessionId || !Number.isSafeInteger(saved.transcript?.lastSeq)
      || saved.transcript.lastSeq !== observed.transcript.lastSeq || saved.transcript.hash !== observed.transcript.hash || saved.summary !== observed.summary) throw new Error('Persisted execution evidence does not match the official transcript');
    if (saved.finalSummary !== undefined && saved.finalSummary !== observed.finalSummary) throw new Error('Persisted final result does not match the official transcript');
    if (saved.toolEvidence && JSON.stringify(saved.toolEvidence) !== JSON.stringify(observed.toolEvidence)) throw new Error('Persisted tool evidence does not match the official transcript');
    if (saved.executionEffects !== undefined && JSON.stringify(saved.executionEffects) !== JSON.stringify(observedEffects)) throw new Error('Persisted execution effects do not match the official transcript');
    let terminal;
    for (const event of log.events) {
      if (['turn/start', 'step/start', 'assistant/message', 'tool/result', 'user/message'].includes(event.type)) terminal = undefined;
      if (event.type === 'turn/end') terminal = event;
    }
    if (paused ? !isVerifiedPauseEnding(terminal?.data?.reason, saved) : terminal?.data?.reason?.kind !== 'completed') throw new Error(paused ? 'Previous execution has no verified pause ending' : 'Previous execution has no verified normal ending');
    if (paused && saved.waitingPause !== true) throw new Error('Execution has no saved explicit pause');
    if (run.environment) await verifyExecutionArtifacts(run, saved, signal);
    else if (paused) {
      if (saved.directory !== run.directory) throw new Error('Pause directory changed');
      await verifyArtifactCheckpoint(run.directory, saved.checkpoint, { signal });
    }
    signal.throwIfAborted();
    return await action({ ...saved, finalSummary: observed.finalSummary, toolEvidence: observed.toolEvidence, executionEffects: observedEffects }, { sessionId: run.sessionId, completed: !paused, paused, ...observed.transcript });
  } finally { await handle.close(); }
}
