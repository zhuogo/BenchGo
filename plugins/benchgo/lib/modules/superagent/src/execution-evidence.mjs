import { createHash } from 'node:crypto';
import { executionEffects } from './execution-effects.mjs';

const mismatch = message => Object.assign(new Error(message), { code: 'EVIDENCE_MISMATCH' });
const recoveryUnavailable = (code, message) => Object.assign(new Error(message), { code });

const LEGACY_EXECUTION_BUDGET_HOOK = 'benchgo-execution-budget-exhausted';

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

/**
 * A pause is resumable only on the official pre-step rejection ending. Runs parked
 * by the removed budget gates (before 2026-11-06) keep their exact saved ending.
 */
export function isVerifiedPauseEnding(reason, saved) {
  return reason?.kind === 'blocked' || (saved?.waitingExecutionBudget?.kind === 'execution-time'
    && reason?.kind === 'aborted' && reason.reason?.kind === 'hook' && reason.reason.reason === LEGACY_EXECUTION_BUDGET_HOOK
    && JSON.stringify(reason) === JSON.stringify(saved.waitingExecutionBudget.terminal)) || (saved?.waitingBudget?.terminal?.kind === 'error'
    && reason?.kind === 'error' && JSON.stringify(reason) === JSON.stringify(saved.waitingBudget.terminal));
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
        finalSummary: saved?.finalSummary ?? observed.finalSummary, completion,
        executionEffects: saved?.executionEffects ?? observedEffects,
        recoveryObservation: { ...observed.transcript, diagnostics } };
      return await action(result, { sessionId: run.sessionId, completed: completion?.kind === 'completed', ...observed.transcript });
    }
    if (!saved || saved.runId !== run.id || saved.sessionId !== run.sessionId || !Number.isSafeInteger(saved.transcript?.lastSeq)
      || saved.transcript.lastSeq !== observed.transcript.lastSeq || saved.transcript.hash !== observed.transcript.hash || saved.summary !== observed.summary) throw mismatch('Persisted execution evidence does not match the official transcript');
    if (saved.finalSummary !== undefined && saved.finalSummary !== observed.finalSummary) throw mismatch('Persisted final result does not match the official transcript');
    if (saved.toolEvidence && JSON.stringify(saved.toolEvidence) !== JSON.stringify(observed.toolEvidence)) throw mismatch('Persisted tool evidence does not match the official transcript');
    if (paused && saved.executionEffects !== undefined && JSON.stringify(saved.executionEffects) !== JSON.stringify(observedEffects)) throw mismatch('Persisted execution effects do not match the official transcript');
    let terminal;
    for (const event of log.events) {
      if (['turn/start', 'step/start', 'assistant/message', 'tool/result', 'user/message'].includes(event.type)) terminal = undefined;
      if (event.type === 'turn/end') terminal = event;
    }
    if (paused ? !isVerifiedPauseEnding(terminal?.data?.reason, saved) : terminal?.data?.reason?.kind !== 'completed') throw recoveryUnavailable('EXECUTION_END_UNVERIFIED', paused ? 'Previous execution has no verified pause ending' : 'Previous execution has no verified normal ending');
    if (paused && saved.waitingPause !== true) throw new Error('Execution has no saved explicit pause');
    // The original session and saved Run remain authoritative. File changes are
    // ordinary working state, not a reason to scan or restore the whole directory.
    if (saved.directory !== run.directory || JSON.stringify(saved.environment) !== JSON.stringify(run.environment))
      throw mismatch('Saved execution directory belongs to another execution');
    signal.throwIfAborted();
    // No asynchronous boundary between this check and the atomic acceptance callback.
    if (live && (ctx.agents.get(run.sessionId) !== live || live.status !== 'idle'
      || executionEvidence({ events: live.session.snapshotEvents() }).transcript.hash !== observed.transcript.hash)) throw mismatch('Official session changed before result acceptance');
    return await action({ ...saved, finalSummary: observed.finalSummary, toolEvidence: observed.toolEvidence, executionEffects: observedEffects }, { sessionId: run.sessionId, completed: !paused, paused, ...observed.transcript });
  } finally { if (handle) await handle.close(); }
}
