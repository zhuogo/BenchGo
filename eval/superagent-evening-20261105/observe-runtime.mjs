import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseAttentionDecisions } from '../../plugins/benchgo/lib/modules/superagent/src/attention-triage.mjs';
export const name = 'superagent-evening-observation';
export const inject = ['agents', 'llm'];
const purposes = new Set(['attention-triage', 'superagent-assessment', 'superagent-verification', 'superagent-learning', 'compaction']);
const failureCodes = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'STREAM_CLOSED',
  'AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'CONTEXT_WINDOW_EXCEEDED', 'NO_ADAPTER', 'UNKNOWN', 'ABORTED',
  'INVALID_ARGS', 'INVALID_REQUEST', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'IMAGE_OFFLOAD_REQUIRED']);
const finishKinds = new Set(['stop', 'tool-calls', 'max-tokens', 'aborted', 'error', 'blocked']);
const safeFailureCode = (code) => failureCodes.has(code) ? code : 'OTHER';
const safeStatus = (status) => Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
export function triageDiagnostic(text, options) {
  const diagnostic = { textLength: text.length, fenced: /^\s*```(?:json)?/iu.test(text) };
  try {
    const input = JSON.parse(options.messages.at(-1).content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
    const decisions = parseAttentionDecisions(text, input);
    diagnostic.code = 'VALID';
    diagnostic.routes = Object.fromEntries(['self', 'default', 'user'].map(route => [route, decisions.filter(row => row.route === route).length]));
  } catch (error) {
    const allowed = new Set(['ATTENTION_INVALID_DECISION', 'ATTENTION_UNSUPPORTED_ANSWER', 'ATTENTION_DEFAULT_NOT_AUTHORIZED']);
    diagnostic.code = error instanceof SyntaxError ? 'ATTENTION_INVALID_JSON' : allowed.has(error?.code) ? error.code : 'OTHER';
  }
  return diagnostic;
}
export function apply(ctx, config = {}) {
  const streams = new Map();
  let writes = Promise.resolve();
  const record = (path, row) => { writes = writes.then(() => appendFile(path, JSON.stringify(row) + '\n')); };
  ctx.on('llm/stream', async function* (options, next) {
    const id = randomUUID(), started = Date.now();
    let chunks = 0, firstChunkAt, finishKind, errorCode, failureCode, failureStatus, triageText = '';
    record(config.requestPath, { id, type: 'request', at: new Date(started).toISOString(), providerId: options.provider,
      modelId: options.model, stream: true, reasoningEffort: options.reasoningEffort, serviceTier: options.serviceTier,
      purpose: options.purpose === undefined ? undefined : purposes.has(options.purpose) ? options.purpose : 'other',
      maxTokens: Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0 ? options.maxTokens : undefined,
      toolsCount: Array.isArray(options.tools) ? options.tools.length : undefined });
    try {
      for await (const chunk of next()) {
        chunks++; firstChunkAt ??= new Date().toISOString();
        if (options.purpose === 'attention-triage' && chunk.type === 'text-delta') triageText = (triageText + chunk.text).slice(0, 20001);
        if (chunk.type === 'finish') {
          finishKind = finishKinds.has(chunk.reason?.kind) ? chunk.reason.kind : 'other';
          const failure = chunk.reason?.failure;
          if (failure) { failureCode = safeFailureCode(failure.code); failureStatus = safeStatus(failure.status); }
        }
        yield chunk;
      }
    } catch (error) { errorCode = safeFailureCode(error?.code); failureStatus ??= safeStatus(error?.failure?.status); throw error; }
    finally {
      record(config.requestPath, { id, type: 'end', at: new Date().toISOString(), elapsedMs: Date.now() - started, chunks, firstChunkAt, finishKind, errorCode, failureCode, failureStatus,
        ...(options.purpose === 'attention-triage' && finishKind === 'stop' ? { triage: triageDiagnostic(triageText, options) } : {}) });
      triageText = '';
    }
  }, { global: true });
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const key = `${agent.id}:${frame.attemptId}`;
    if (frame.type === 'start') streams.set(key, { length: 0, turn: frame.turn, step: frame.step });
    const stream = streams.get(key);
    if (!stream) return;
    const cwd = String(agent.session.header.cwd || '').replaceAll('\\', '/');
    const row = { at: new Date().toISOString(), observedAt: Date.now(), sessionId: agent.id,
      role: cwd.includes('/workers/') ? 'worker' : 'router', attemptId: frame.attemptId,
      type: frame.type, turn: stream.turn, step: stream.step };
    if (frame.type === 'chunk') {
      row.chunkType = frame.chunk.type;
      if (frame.chunk.type === 'text-delta') stream.length += frame.chunk.text.length;
      row.publicTextLength = stream.length;
    }
    if (frame.type === 'end') { row.outcome = frame.outcome; row.publicTextLength = stream.length; streams.delete(key); }
    // Persist timing/counts only. Never retain reasoning or raw chunks/tool arguments.
    record(config.streamPath, row);
  }, { global: true });
  ctx.effect(() => () => writes);
}
