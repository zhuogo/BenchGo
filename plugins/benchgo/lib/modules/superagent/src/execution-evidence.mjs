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
    const provenance = projectSourceEvidence(call, text, event, raw.isError);
    if (provenance.length) raw.sources = provenance;
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

/** Provenance is observed tool data. Missing publication time stays unknown, never inferred. */
function projectSourceEvidence(call, text, event, failed) {
  let args, payload;
  try { args = typeof call?.arguments === 'string' ? JSON.parse(call.arguments) : call?.arguments; } catch { /* Preserve raw evidence above. */ }
  try { payload = JSON.parse(text); } catch { /* Plain text can still contain source links. */ }
  const found = new Map(), namedSources = new Set();
  const observedAt = Number.isFinite(event.time) ? new Date(event.time).toISOString() : null;
  const boundedText = (value, limit) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, limit) || undefined : undefined;
  const httpUrl = value => {
    if (typeof value !== 'string' || value.length > 2048) return;
    try { if (['http:', 'https:'].includes(new URL(value).protocol)) return value; } catch { /* Unsupported source reference. */ }
  };
  const urls = value => (Array.isArray(value) ? value.slice(0, 16) : [value]).map(httpUrl).filter(Boolean);
  const relation = value => {
    if (typeof value === 'string') return boundedText(value, 300);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const type = boundedText(value.type, 100), url = httpUrl(value.url);
    return type || url ? { ...(type ? { type } : {}), ...(url ? { url } : {}) } : undefined;
  };
  const add = (value, fields = {}) => {
    if (!httpUrl(value) || (!found.has(value) && found.size >= 16)) return;
    const prior = found.get(value);
    const source = boundedText(fields.source, 300);
    const entry = { ...prior, url: value, source: !namedSources.has(value) && source ? source : prior?.source || new URL(value).hostname,
      publishedAt: prior?.publishedAt || boundedText(fields.publishedAt ?? fields.published_at ?? fields.publishedTime, 100) || null,
      fetchedAt: observedAt, status: prior?.status || (failed ? 'failed' : 'observed') };
    if (source) namedSources.add(value);
    const failureReason = boundedText(fields.failureReason, 500);
    const error = boundedText(typeof fields.error === 'object' ? fields.error?.message : fields.error, 500);
    if (failureReason && !entry.failureReason) entry.failureReason = failureReason;
    if (error && !entry.error) entry.error = error;
    if (fields.isError === true || fields.status === 'failed' || failureReason || error) entry.status = 'failed';
    for (const key of ['relatedUrls', 'corroborates']) {
      const related = [...new Set([...(entry[key] || []), ...urls(fields[key])])].slice(0, 16);
      if (related.length) entry[key] = related;
    }
    if (!entry.relationship) {
      const relationship = relation(fields.relationship);
      if (relationship) entry.relationship = relationship;
    }
    found.set(value, entry);
  };
  const visit = (value, depth = 0) => {
    if (depth > 4 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const row of value.slice(0, 16)) visit(row, depth + 1); return; }
    add(value.url, value); add(value.link, value);
    for (const key of ['sources', 'results', 'items', 'articles', 'data']) visit(value[key], depth + 1);
  };
  visit(args); visit(payload);
  // A URL-less fetch error still describes the explicitly requested URL.
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && !payload.url && !payload.link) add(args?.url, payload);
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'\]\[)]+/g)) {
    if (found.size >= 16) break;
    add(match[0]);
  }
  return [...found.values()];
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
