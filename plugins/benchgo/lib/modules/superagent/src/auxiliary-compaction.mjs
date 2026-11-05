import { canFallback, isTransientFailure } from './routing.mjs';
import { validateAssistantAuxiliary } from './store.mjs';

/** Route only compaction; failed partial summaries must never reach the assembler. */
export function createAuxiliaryCompactionHook({ getConfig, onRoute, dispatch, maxBufferedBytes = 8 * 1024 * 1024 }) {
  const active = new WeakSet();
  return async function* auxiliaryCompaction(options, next) {
    if (active.has(options)) { yield* next(); return; }
    if (options.purpose !== 'compaction') { yield* next(); return; }
    options.signal?.throwIfAborted();
    const config = structuredClone(await getConfig()), auxiliary = config.auxiliary ?? null;
    if (!auxiliary?.capabilities?.includes('compression')) { yield* next(); return; }
    validateAssistantAuxiliary(auxiliary);
    const main = { providerId: options.provider, modelId: options.model, options: { reasoningEffort: options.reasoningEffort, maxTokens: options.maxTokens } };
    const routes = [...auxiliary.models, main].filter((route, index, all) =>
      route?.providerId && route?.modelId && all.findIndex(other => other?.providerId === route.providerId && other?.modelId === route.modelId) === index);
    const attempts = [];
    let dispatched = false;
    const stream = () => {
      if (dispatched && dispatch) return dispatch(options);
      dispatched = true;
      return next();
    };
    active.add(options);
    let retried = false;
    try { for (let index = 0; index < routes.length; index++) {
      const model = routes[index];
      if (!model?.providerId || !model?.modelId) throw new Error('辅助压缩备选模型不可用');
      options.signal?.throwIfAborted();
      // The official summarizer records these same options after consumption.
      options.provider = model.providerId;
      options.model = model.modelId;
      delete options.reasoningEffort;
      if (model.options?.reasoningEffort !== undefined) options.reasoningEffort = model.options.reasoningEffort;
      options.maxTokens = model.options?.maxTokens ?? main.options.maxTokens;
      const attempt = { providerId: options.provider, modelId: options.model, maxTokens: options.maxTokens, retry: retried, status: 'running' };
      attempts.push(attempt);
      const chunks = [];
      let bytes = 0, finish;
      try {
        for await (const chunk of stream()) {
          options.signal?.throwIfAborted();
          bytes += Buffer.byteLength(JSON.stringify(chunk));
          if (bytes > maxBufferedBytes) throw Object.assign(new Error('Compaction output exceeded buffer limit'), { code: 'COMPACTION_BUFFER_LIMIT' });
          chunks.push(chunk);
          if (chunk.type === 'finish') finish = chunk.reason;
        }
        options.signal?.throwIfAborted();
        if (!finish) throw Object.assign(new Error('Compaction stream ended without a finish'), { code: 'COMPACTION_INCOMPLETE_STREAM' });
        if (finish.kind === 'error' && canFallback(finish.failure)) {
          attempt.status = 'failed'; attempt.code = finish.failure?.code;
          if (!retried && isTransientFailure(finish.failure)) { retried = true; index--; continue; }
          if (index + 1 < routes.length) { retried = false; continue; }
        }
        if (finish.kind === 'stop' && !chunks.some(chunk => chunk.type === 'text-delta' && chunk.text.trim())) {
          attempt.status = 'failed'; attempt.code = 'EMPTY_SUMMARY';
          const mainIndex = routes.findIndex(route => route.providerId === main.providerId && route.modelId === main.modelId);
          if (mainIndex > index) { index = mainIndex - 1; retried = false; continue; }
          throw new Error('辅助压缩未生成有效摘要');
        }
        attempt.status = finish.kind === 'stop' ? 'completed' : 'failed';
        yield* chunks;
        return;
      } catch (error) {
        options.signal?.throwIfAborted();
        attempt.status = 'failed'; attempt.code = error.code || error.name;
        const failure = error.failure ?? error;
        if (!retried && canFallback(failure) && isTransientFailure(failure)) { retried = true; index--; continue; }
        if (index + 1 < routes.length && (canFallback(failure) || error.code === 'NO_ADAPTER')) { retried = false; continue; }
        throw error;
      }
    } } finally { active.delete(options); await onRoute?.({ sessionId: options.sessionId, configRevision: config.revision ?? null, capability: 'compression', attempts }); }
  };
}
