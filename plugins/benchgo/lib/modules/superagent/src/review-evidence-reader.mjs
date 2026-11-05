import { executionEvidence } from './execution-evidence.mjs';

/** Read only tool results from the exact transcript submitted for review. */
export function createReviewEvidenceReader({ ctx, result }) {
  const expected = { sessionId: result?.sessionId, summary: result?.summary,
    transcript: { ...result?.transcript } };
  let snapshot;
  async function entries() {
    snapshot ??= (async () => {
      if (typeof expected.sessionId !== 'string' || !expected.sessionId
        || !Number.isSafeInteger(expected.transcript.lastSeq) || !expected.transcript.hash)
        throw new Error('Review evidence has no verified session identity');
      const log = await ctx.sessionQuery.readSession(expected.sessionId);
      const observed = executionEvidence(log);
      if ((log.session?.id != null && log.session.id !== expected.sessionId)
        || observed.transcript.lastSeq !== expected.transcript.lastSeq
        || observed.transcript.hash !== expected.transcript.hash || observed.summary !== expected.summary)
        throw new Error('Review evidence does not match the official transcript');
      const calls = new Map(), results = new Map();
      for (const event of log.events) {
        const message = event.data?.message;
        if (event.type === 'assistant/message') {
          for (const block of message?.content || []) if (block.type === 'tool-call') calls.set(block.id, block);
        }
        if (event.type !== 'tool/result') continue;
        const call = calls.get(message?.toolCallId ?? message?.source?.callId);
        if (!call || typeof call.name !== 'string' || !Number.isSafeInteger(event.seq)) continue;
        if (results.has(event.seq)) throw new Error('Duplicate tool result sequence');
        results.set(event.seq, { seq: event.seq, name: call.name,
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? null),
          text: (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n'),
          isError: message?.isError === true || !!event.data?.error });
      }
      return results;
    })();
    return snapshot;
  }
  const reader = async ({ seq, offset = 0, limit = 4000 } = {}) => {
    if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 8000)
      throw new Error('Invalid evidence page');
    const entry = (await entries()).get(seq);
    if (!entry) throw new Error('Sequence is not a tool result in this execution');
    if (offset > entry.text.length) throw new Error('Evidence offset is out of range');
    const end = Math.min(offset + limit, entry.text.length);
    return { ...entry, arguments: entry.arguments.slice(0, 2000),
      argumentsLength: entry.arguments.length, argumentsTruncated: entry.arguments.length > 2000,
      text: entry.text.slice(offset, end), offset,
      nextOffset: end < entry.text.length ? end : null, totalLength: entry.text.length };
  };
  reader.index = async () => {
    const all = [...(await entries()).values()];
    return { entries: all.slice(-256).map(entry => ({ seq: entry.seq, name: entry.name,
      arguments: entry.arguments.slice(0, 500), textLength: entry.text.length })),
      total: all.length, omitted: Math.max(0, all.length - 256) };
  };
  return reader;
}
