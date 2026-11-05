import { auxiliaryModels, canFallback, isTransientFailure } from './routing.mjs';
const failureDiagnostics = new WeakMap();
const failureRoutes = new WeakMap();
const finishKinds = new Set(['stop', 'max-tokens', 'tool-calls', 'blocked', 'error', 'aborted']);
const qualityKinds = new Set(['TEXT_LIMIT', 'TOOL_CALL', 'MAX_TOKENS', 'INCOMPLETE_FINISH', 'EMPTY_TEXT', 'INVALID_JSON', 'INVALID_DECISION']);
const reviewSchemaCodes = new Set(['INVALID_DECISION_SHAPE', 'INVALID_EVIDENCE_REQUEST', 'INVALID_EVIDENCE_PAGE', 'INVALID_VERDICT', 'INVALID_REASON',
  'INVALID_PUBLICATION_ORIGIN', 'MISSING_DELIVERY', 'MISSING_DELIVERY_TEXT', 'INVALID_DELIVERY', 'CORRECTION_FIELDS', 'INVALID_ASK', 'UNEXPECTED_USER_DECISION', 'WAIT_CANNOT_BE_SILENT', 'SILENT_NOT_ALLOWED']);
const qualityFailure = (message, quality) => Object.assign(new Error(message), { code: 'AUXILIARY_QUALITY', quality });
const sameModel = (left, right) => left?.providerId === right?.providerId && left?.modelId === right?.modelId;
const repairableQuality = new Set(['INVALID_JSON', 'INVALID_DECISION']);

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

function qualityRepairInstruction(error) {
  const subtype = reviewSchemaCodes.has(error.reviewSchemaCode) ? error.reviewSchemaCode : error.quality;
  return { role: 'system', content: [{ type: 'text', text: `Host validation rejected the previous response (${subtype}). Reassess the ORIGINAL task and evidence and return exactly one complete valid JSON decision. Do not add acceptance criteria. Every verdict needs reason. deliver requires text. ask requires verdict=wait and userDecision with kind information, permission or scope and a nonempty question. failed/rework require instruction and deliver.text. Do not emit origin or systemState. This is one bounded format correction; no execution or external action is authorized.` }] };
}
/** Host-only stream metadata; never response text, reasoning, tool arguments or provider bodies. */
export const auxiliaryFailureDiagnostic = error => error instanceof Error ? failureDiagnostics.get(error) : undefined;
export const auxiliaryFailureRouting = error => error instanceof Error ? failureRoutes.get(error) : undefined;
/** A read-only operation may retry before publishing anything, never replay tools. */
export async function collectAuxiliaryText({ llm, config, capability, model, request, validate, policy, requestBudget }) {
  const frozen = structuredClone(config), main = structuredClone(model);
  const auxiliary = frozen.auxiliary?.capabilities?.includes(capability) ? frozen.auxiliary : null;
  const routes = auxiliaryModels(main, frozen, capability);
  let routeIndex = 0, selected = routes[0], switched = false, qualityRepair, mainQualityRepaired = false;
  if (!selected?.providerId || !selected?.modelId) throw new Error('辅助任务模型未配置');
  const attempts = [];
  const routing = () => ({ configRevision: frozen.revision ?? null, capability, auxiliary: !!auxiliary,
    switched: requestBudget?.switched || switched, attempts: structuredClone(requestBudget?.attempts ?? attempts) });
  for (;;) {
    for (let retry = 0; ; retry++) {
      request.signal?.throwIfAborted();
      if (attempts.length >= (policy?.maxAttempts ?? Infinity) || requestBudget?.remaining <= 0) {
        const error = Object.assign(new Error('验收请求额度已用尽，原结果已保留'), { code: 'REVIEW_REQUEST_LIMIT' });
        failureRoutes.set(error, routing());
        throw error;
      }
      if (requestBudget) requestBudget.remaining--;
      const attempt = { providerId: selected.providerId, modelId: selected.modelId, retry, status: 'running' };
      attempts.push(attempt);
      requestBudget?.attempts?.push(attempt);
      let text = '', finish;
      const options = { ...request, ...selected.options, provider: selected.providerId, model: selected.modelId, tools: [] };
      const timeoutMs = sameModel(selected, main) ? policy?.mainTimeoutMs : policy?.attemptTimeoutMs;
      const startedAt = Date.now();
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) attempt.timeoutMs = timeoutMs;
      const controller = new AbortController();
      const timer = Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(() => controller.abort(Object.assign(new Error('验收模型响应超时'), { code: 'TIMEOUT' })), timeoutMs) : null;
      options.signal = AbortSignal.any([controller.signal, ...(request.signal ? [request.signal] : [])]);
      if (qualityRepair) options.messages = [...(request.messages || []), qualityRepair];
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
          if (reviewSchemaCodes.has(cause?.reviewSchemaCode)) error.reviewSchemaCode = cause.reviewSchemaCode;
          throw error;
        }
        attempt.status = 'completed';
        if (policy) attempt.elapsedMs = Math.max(0, Date.now() - startedAt);
        Object.assign(attempt, { finishKind: 'stop', textCharacters: text.length, hasText: !!text.trim() });
        return { text, routing: routing() };
      } catch (error) {
        attempt.status = 'failed';
        if (policy) attempt.elapsedMs = Math.max(0, Date.now() - startedAt);
        const code = request.signal?.aborted ? (error.name === 'TimeoutError' ? 'TIMEOUT' : 'ABORTED') : error.code || error.name;
        attempt.code = typeof code === 'string' && /^[A-Za-z0-9_:-]{1,100}$/.test(code) ? code : 'PROVIDER_ERROR';
        const diagnostic = { finishKind: finishKinds.has(finish?.kind) ? finish.kind : 'missing', textCharacters: text.length, hasText: !!text.trim(),
          ...(attempt.maxTokens ? { maxTokens: attempt.maxTokens } : {}),
          ...(error.code === 'AUXILIARY_QUALITY' && qualityKinds.has(error.quality) ? { quality: error.quality } : {}),
          ...(error.quality === 'INVALID_DECISION' && reviewSchemaCodes.has(error.reviewSchemaCode) ? { schemaCode: error.reviewSchemaCode } : {}) };
        Object.assign(attempt, diagnostic);
        if (error instanceof Error) {
          failureDiagnostics.set(error, Object.freeze(diagnostic));
          failureRoutes.set(error, routing());
        }
        request.signal?.throwIfAborted();
        const failure = error.failure ?? error;
        if (policy?.repairQuality && sameModel(selected, main) && !mainQualityRepaired && !requestBudget?.mainQualityRepaired
          && error.code === 'AUXILIARY_QUALITY' && repairableQuality.has(error.quality)) {
          mainQualityRepaired = true;
          if (requestBudget) requestBudget.mainQualityRepaired = true;
          qualityRepair = qualityRepairInstruction(error);
          continue;
        }
        const mainIndex = routes.findIndex(route => sameModel(route, main));
        const fallbackToMain = policy?.preferMainFallback && mainIndex > routeIndex
          && (canFallback(failure) || ['AUXILIARY_QUALITY', 'NO_ADAPTER'].includes(error.code));
        if (fallbackToMain) {
          routeIndex = mainIndex; selected = routes[routeIndex]; switched = true;
          if (requestBudget) requestBudget.switched = true;
          qualityRepair = error.code === 'AUXILIARY_QUALITY' && repairableQuality.has(error.quality) ? qualityRepairInstruction(error) : undefined;
          break;
        }
        if (canFallback(failure) && isTransientFailure(failure) && retry === 0) continue;
        if ((!canFallback(failure) && !['AUXILIARY_QUALITY', 'NO_ADAPTER'].includes(error.code))) throw error;
        const nextIndex = error.code === 'AUXILIARY_QUALITY'
          ? routes.findIndex(route => route.providerId === main.providerId && route.modelId === main.modelId)
          : routeIndex + 1;
        if (nextIndex <= routeIndex || !routes[nextIndex]) throw error;
        routeIndex = nextIndex; selected = routes[routeIndex]; switched = true;
        if (requestBudget) requestBudget.switched = true;
        break;
      } finally {
        if (timer) clearTimeout(timer);
        controller.abort();
      }
    }
  }
}
