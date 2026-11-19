const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
const credentialStatuses = new Set([401, 402, 404]);
const networkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);
const credentialCodes = new Set(['AUTHENTICATION', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL']);
const refusalCodes = new Set(['CONTENT_FILTER', 'CONTENT_POLICY_VIOLATION', 'POLICY_DENIED', 'REFUSAL', 'PERMISSION_DENIED']);
const statusOf = error => Number(error?.status ?? error?.statusCode ?? error?.response?.status);

export function isTransientFailure(error) {
  // Mirrors the official retryable codes (dsh-llm retry-policy, session-controller continuation).
  return transientStatuses.has(statusOf(error)) || ['TIMEOUT', 'RATE_LIMIT', 'SERVER', 'TRANSPORT', 'EMPTY_RESPONSE', 'STREAM_CLOSED'].includes(error?.code)
    || error?.name === 'TimeoutError' || networkCodes.has(error?.code) || networkCodes.has(error?.cause?.code);
}

export function canFallback(error) {
  if (error?.name === 'AbortError' || error?.refusal || refusalCodes.has(error?.code) || ['CONTEXT_LENGTH_EXCEEDED', 'CONTEXT_WINDOW_EXCEEDED', 'IMAGE_OFFLOAD_REQUIRED'].includes(error?.code)) return false;
  const status = statusOf(error);
  // Bare 403 is ambiguous. Only an adapter's structured authentication class
  // permits failover; never infer permission to bypass a refusal from prose.
  if (status === 403) return credentialCodes.has(error?.code);
  if (status === 400) return false;
  return isTransientFailure(error) || credentialStatuses.has(status) || credentialCodes.has(error?.code) || error?.code === 'QUOTA';
}


/** Preserve opaque IDs and explicit selection, then use configured models in order. */
export function orderedModels(primary, models = []) {
  return structuredClone([primary, ...models].filter((model, index, all) => model?.providerId && model?.modelId
    && all.findIndex(other => other?.providerId === model.providerId && other?.modelId === model.modelId) === index));
}

export function roleModels(primary, config = {}, role = 'router') {
  const main = config.models ?? config.routingConfig?.models ?? [config.model];
  if (role === 'router') return orderedModels(primary, main);
  if (role !== 'worker') throw new Error('Unknown model role');
  const workers = config.workerModels ?? config.routingConfig?.workerModels ?? [];
  const harness = primary?.harness ?? config.workerHarness ?? config.routingConfig?.workerHarness ?? 'official';
  return orderedModels(primary, workers.length || harness !== 'official' ? workers : main);
}

/** Share capability routing without changing each caller's tool permissions. */
export function auxiliaryRoute(primary, config = {}, capability, routePolicy = 'router-fallback') {
  if (!['router-fallback', 'auxiliary-only'].includes(routePolicy)) throw new Error('Unknown auxiliary route policy');
  const configured = config.auxiliary?.capabilities?.includes(capability) ? config.auxiliary.models : [];
  const selected = (configured || []).filter(model => model?.providerId && model?.modelId);
  const auxiliary = selected.length > 0;
  if (auxiliary && routePolicy === 'auxiliary-only') return { models: orderedModels(undefined, selected), auxiliary };
  const preferred = selected.map(model => primary?.providerId === model.providerId && primary?.modelId === model.modelId ? primary : model);
  const [first, ...rest] = [...preferred, ...roleModels(primary, config, 'router')];
  return { models: orderedModels(first, rest), auxiliary };
}

export const auxiliaryModels = (...args) => auxiliaryRoute(...args).models;
