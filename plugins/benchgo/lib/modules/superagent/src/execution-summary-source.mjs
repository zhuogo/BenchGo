import { redactExecutionText } from './execution-summary-input.mjs';

async function readSurface(sessionQuery, sessionId, signal) {
  signal?.throwIfAborted();
  let abort;
  const aborted = signal && new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await (aborted ? Promise.race([sessionQuery.readSurface(sessionId), aborted]) : sessionQuery.readSurface(sessionId));
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

/** Read the official current surface without retaining another transcript. */
export async function readExecutionProgressReports({ sessionQuery, facts, taskId, runId, instructionRevision, signal }) {
  if (!sessionQuery?.readSurface) return [];
  const sources = (facts.projections || []).filter(row => row.taskId === taskId && row.runId === runId
    && row.instructionRevision === instructionRevision && typeof row.sessionId === 'string' && Number.isSafeInteger(row.cursor));
  const root = sources.find(row => !row.parentSessionId);
  const selected = [root, ...sources.filter(row => row !== root).slice(-3)].filter(Boolean);
  const reports = [];
  for (const source of selected) {
    signal?.throwIfAborted();
    const surface = await readSurface(sessionQuery, source.sessionId, signal);
    signal?.throwIfAborted();
    if (surface.session?.id !== source.sessionId) continue;
    // Only committed top-level model text on the official surviving surface.
    // Attempts, partial streams, reasoning blocks and all tool bodies stay private.
    const events = (surface.events || []).filter(event => event.type === 'assistant/message'
      && event.seq >= (surface.inheritedEventCount || 0) && event.seq <= source.cursor
      && !event.data?.parentCallId && !event.data?.interrupted
      && event.data?.message?.role === 'assistant' && event.data.message.source?.kind === 'model').slice(-6);
    for (const event of events) {
      const text = redactExecutionText((event.data.message.content || []).filter(block => block.type === 'text')
        .map(block => block.text).join('\n'), 1200);
      if (text) reports.push({ text, evidenceRef: `${source.sessionId}:${event.seq}`, time: event.time });
    }
  }
  return reports.sort((a, b) => (Number(new Date(a.time)) || 0) - (Number(new Date(b.time)) || 0)).slice(-8);
}
