import { orderedModels, roleModels } from './routing.mjs';

export const selectWorkerModel = (agent, model) => agent.model?.select?.({ provider: model.providerId, model: model.modelId,
  ...(model.options?.reasoningEffort === undefined ? {} : { reasoningEffort: model.options.reasoningEffort }) });
const fail = message => Object.assign(new Error(message), { code: 'WORKER_MODEL_ROUTE' });

/** A Run keeps the route frozen at its creation, never today's configuration. */
export function workerModelRoute({ policy, assignment, savedQueue, resumed }) {
  // A continued Run without its frozen route must not silently adopt current settings.
  if (resumed && !savedQueue) throw fail('Saved Worker model route is missing');
  const admitted = assignment?.model?.harness ? assignment.model : undefined;
  const harness = savedQueue?.models?.[0]?.harness
    || (resumed ? 'official' : admitted?.harness || policy.workerHarness || policy.routingConfig?.workerHarness || 'official');
  if (!['official', 'codex', 'claude'].includes(harness)) throw fail('Saved Worker Harness is invalid');
  const models = savedQueue ? structuredClone(savedQueue.models)
    : admitted && harness !== 'official' ? orderedModels(admitted)
      : roleModels(admitted, policy, 'worker').map(model => ({ ...model, ...(harness !== 'official' ? { harness } : {}) }));
  if (savedQueue && (!Array.isArray(models) || !models.length || models.some(model => !model?.providerId || !model?.modelId))) throw fail('Saved Worker model route is invalid');
  if (!models.length) throw fail(harness === 'official' ? 'Worker model is not configured' : '外部 Worker 必须先配置一个兼容的 API 模型');
  const index = savedQueue?.index ?? 0;
  if (!Number.isSafeInteger(index) || index < 0 || !models[index]) throw fail('Saved Worker selection is outside its frozen work role');
  if (models.some(model => (model.harness || harness) !== harness)) throw fail('Worker model queue mixes Harness routes');
  return { models, index, harness };
}

export function workerRequest(inherited, model) {
  const { provider: _provider, model: _model, reasoningEffort: _effort, maxTokens: _maxTokens,
    temperature: _temperature, stop: _stop, ...controls } = inherited;
  return { ...controls, ...(model.options || {}), provider: model.providerId, model: model.modelId };
}
