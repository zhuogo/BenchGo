import { orderedModels } from './routing.mjs';

export const selectWorkerModel = (agent, model) => agent.model?.select?.({ provider: model.providerId, model: model.modelId,
  ...(model.options?.reasoningEffort === undefined ? {} : { reasoningEffort: model.options.reasoningEffort }) });
const fail = message => Object.assign(new Error(message), { code: 'WORKER_MODEL_ROUTE' });

/** A Run keeps the route frozen at its creation, never today's configuration. */
export function workerModelRoute({ policy, savedQueue, resumed }) {
  // A continued Run without its frozen route must not silently adopt current settings.
  if (resumed && !savedQueue) throw fail('Saved Worker model route is missing');
  const models = savedQueue ? structuredClone(savedQueue.models)
    : orderedModels(undefined, policy.workerModels || policy.routingConfig?.workerModels || []);
  if (savedQueue && (!Array.isArray(models) || !models.length || models.some(model => !model?.providerId || !model?.modelId))) throw fail('Saved Worker model route is invalid');
  if (!models.length) throw fail('Worker model is not configured');
  const index = savedQueue?.index ?? 0;
  if (!Number.isSafeInteger(index) || index < 0 || !models[index]) throw fail('Saved Worker selection is outside its frozen work role');
  return { models, index };
}

export function workerRequest(inherited, model) {
  const { provider: _provider, model: _model, reasoningEffort: _effort, maxTokens: _maxTokens,
    temperature: _temperature, stop: _stop, ...controls } = inherited;
  return { ...controls, ...(model.options || {}), provider: model.providerId, model: model.modelId };
}
