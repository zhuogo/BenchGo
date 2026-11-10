import { auxiliaryModels, canFallback, isTransientFailure } from './routing.mjs';
const failureDiagnostics = new WeakMap();
const failureRoutes = new WeakMap();
const finishKinds = new Set(['stop', 'max-tokens', 'tool-calls', 'blocked', 'error', 'aborted']);
const qualityKinds = new Set(['TEXT_LIMIT', 'TOOL_CALL', 'MAX_TOKENS', 'INCOMPLETE_FINISH', 'EMPTY_TEXT', 'INVALID_JSON', 'INVALID_DECISION']);
const qualityFailure = (message, quality) => Object.assign(new Error(message), { code: 'AUXILIARY_QUALITY', quality });
/** Bound a stalled adapter as well as an adapter which observes AbortSignal. */
async function* boundedStream(llm, options) {
  options.signal?.throwIfAborted();
  if (!options.signal) { yield* llm.stream(options); return; }
  const iterator = llm.stream(options)[Symbol.asyncIterator]();
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(options.signal.reason);
  options.signal.addEventListener('abort', onAbort, { once: true });
  try {
    options.signal.throwIfAborted();
    for (;;) {
      const chunk = await Promise.race([iterator.next(), aborted]);
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally {
    options.signal.removeEventListener('abort', onAbort);
    // Do not let a non-cooperative adapter hold the host's timeout open.
    Promise.resolve().then(() => iterator.return?.()).catch(() => {});
  }
}

/** Host-only stream metadata; never response text, reasoning, tool arguments or provider bodies. */
export const auxiliaryFailureDiagnostic = error => error instanceof Error ? failureDiagnostics.get(error) : undefined;
export const auxiliaryFailureRouting = error => error instanceof Error ? failureRoutes.get(error) : undefined;
/** A read-only operation may retry before publishing anything, never replay tools. */
export async function collectAuxiliaryText({ llm, config, capability, model, request, validate, routePolicy = 'router-fallback' }) {
  const frozen = structuredClone(config), main = structuredClone(model);
  const auxiliary = frozen.auxiliary?.capabilities?.includes(capability) ? frozen.auxiliary : null;
  const routes = auxiliaryModels(main, frozen, capability, routePolicy);
  let routeIndex = 0, selected = routes[0], switched = false;
  if (!selected?.providerId || !selected?.modelId) throw Object.assign(new Error('辅助任务模型未配置'), { code: 'AUXILIARY_UNCONFIGURED' });
  const attempts = [];
  const routing = () => ({ configRevision: frozen.revision ?? null, capability, auxiliary: !!auxiliary, routePolicy,
    switched: switched, attempts: structuredClone(attempts) });
  for (;;) {
    for (let retry = 0; ; retry++) {
      request.signal?.throwIfAborted();
      const attempt = { providerId: selected.providerId, modelId: selected.modelId, retry, status: 'running' };
      attempts.push(attempt);
      let text = '', finish;
      const options = { ...request, ...selected.options, provider: selected.providerId, model: selected.modelId, tools: [] };
      if (Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0) attempt.maxTokens = options.maxTokens;
      try {
        for await (const chunk of boundedStream(llm, options)) {
          request.signal?.throwIfAborted();
          if (chunk.type === 'text-delta') { text += chunk.text; if (text.length > 20000) throw qualityFailure('辅助响应过长', 'TEXT_LIMIT'); }
          if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') throw qualityFailure('辅助任务不得调用工具', 'TOOL_CALL');
          if (chunk.type === 'finish') finish = chunk.reason;
        }
        request.signal?.throwIfAborted();
        if (finish?.kind === 'error') throw Object.assign(new Error(finish.failure?.message || '辅助请求失败'), finish.failure);
        if (finish?.kind === 'aborted') throw Object.assign(new Error('辅助请求已取消'), { name: 'AbortError' });
        if (finish?.kind === 'blocked') throw Object.assign(new Error('辅助请求被策略拒绝'), { code: 'POLICY_DENIED' });
        if (finish?.kind === 'max-tokens') throw qualityFailure('辅助响应达到输出上限', 'MAX_TOKENS');
        if (finish?.kind !== 'stop') throw qualityFailure('辅助响应未完整结束', 'INCOMPLETE_FINISH');
        if (!text.trim()) throw qualityFailure('辅助响应没有正文', 'EMPTY_TEXT');
        try { validate?.(text); } catch (cause) {
          const error = qualityFailure('辅助响应格式不符合要求', cause instanceof SyntaxError ? 'INVALID_JSON' : 'INVALID_DECISION');
          throw error;
        }
        attempt.status = 'completed';
        Object.assign(attempt, { finishKind: 'stop', textCharacters: text.length, hasText: !!text.trim() });
        return { text, routing: routing() };
      } catch (error) {
        attempt.status = 'failed';
        const code = request.signal?.aborted ? (error.name === 'TimeoutError' ? 'TIMEOUT' : 'ABORTED') : error.code || error.name;
        attempt.code = typeof code === 'string' && /^[A-Za-z0-9_:-]{1,100}$/.test(code) ? code : 'PROVIDER_ERROR';
        const diagnostic = { finishKind: finishKinds.has(finish?.kind) ? finish.kind : 'missing', textCharacters: text.length, hasText: !!text.trim(),
          ...(attempt.maxTokens ? { maxTokens: attempt.maxTokens } : {}),
          ...(error.code === 'AUXILIARY_QUALITY' && qualityKinds.has(error.quality) ? { quality: error.quality } : {}) };
        Object.assign(attempt, diagnostic);
        if (error instanceof Error) {
          failureDiagnostics.set(error, Object.freeze(diagnostic));
          failureRoutes.set(error, routing());
        }
        request.signal?.throwIfAborted();
        const failure = error.failure ?? error;
        if (canFallback(failure) && isTransientFailure(failure) && retry === 0) continue;
        if ((!canFallback(failure) && !['AUXILIARY_QUALITY', 'NO_ADAPTER'].includes(error.code))) throw error;
        const nextIndex = error.code === 'AUXILIARY_QUALITY' && routePolicy !== 'auxiliary-only'
          ? routes.findIndex(route => route.providerId === main.providerId && route.modelId === main.modelId)
          : routeIndex + 1;
        if (nextIndex <= routeIndex || !routes[nextIndex]) throw error;
        routeIndex = nextIndex; selected = routes[routeIndex]; switched = true;
        break;
      }
    }
  }
}
