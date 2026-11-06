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

/** An empty Worker queue explicitly inherits Router; explicit selections stay first. */
export function roleModels(primary, config = {}, role = 'router') {
  if (!['router', 'worker'].includes(role)) throw new Error('Unknown model role');
  const models = role === 'worker' && config.workerModels?.length ? config.workerModels : config.models;
  return orderedModels(primary, models || []);
}

/** Share capability routing without changing each caller's tool permissions. */
export function auxiliaryModels(primary, config = {}, capability) {
  const auxiliary = config.auxiliary?.capabilities?.includes(capability) ? config.auxiliary : null;
  const selected = (auxiliary?.models || []).map(model => primary?.providerId === model.providerId && primary?.modelId === model.modelId ? primary : model);
  const models = [...selected, ...roleModels(primary, config, 'router')];
  return orderedModels(models[0], models.slice(1));
}
