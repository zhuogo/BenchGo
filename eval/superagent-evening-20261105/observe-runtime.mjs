import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
export const name = 'superagent-evening-observation';
export const inject = ['agents', 'llm'];
export function apply(ctx, config = {}) {
  const streams = new Map();
  let writes = Promise.resolve();
  const record = (path, row) => { writes = writes.then(() => appendFile(path, JSON.stringify(row) + '\n')); };
  ctx.on('llm/stream', async function* (options, next) {
    const id = randomUUID(), started = Date.now();
    let chunks = 0, firstChunkAt, finishKind, errorCode;
    record(config.requestPath, { id, type: 'request', at: new Date(started).toISOString(), providerId: options.provider,
      modelId: options.model, stream: true, reasoningEffort: options.reasoningEffort, serviceTier: options.serviceTier });
    try {
      for await (const chunk of next()) {
        chunks++; firstChunkAt ??= new Date().toISOString();
        if (chunk.type === 'finish') finishKind = chunk.reason?.kind;
        yield chunk;
      }
    } catch (error) { errorCode = /^[A-Za-z0-9_:-]{1,100}$/.test(error?.code || '') ? error.code : 'REQUEST_ERROR'; throw error; }
    finally { record(config.requestPath, { id, type: 'end', at: new Date().toISOString(), elapsedMs: Date.now() - started, chunks, firstChunkAt, finishKind, errorCode }); }
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
