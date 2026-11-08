import { orderedModels } from './routing.mjs';

export const workerModelQueueType = 'plugin:benchgo-plugin/worker-model-queue';
export const sameWorkerModel = (model, selection) => model.providerId === selection?.provider && model.modelId === selection?.model
  && model.options?.reasoningEffort === selection?.reasoningEffort;
export const selectWorkerModel = (agent, model) => agent.model?.select?.({ provider: model.providerId, model: model.modelId,
  ...(model.options?.reasoningEffort === undefined ? {} : { reasoningEffort: model.options.reasoningEffort }) });
const fail = message => Object.assign(new Error(message), { code: 'WORKER_MODEL_ROUTE' });

/** Historical Runs keep their actual saved selection, never today's backups. */
export function workerModelRoute({ policy, savedQueue, current, requestConfig = {}, resumed }) {
  let models;
  if (savedQueue) {
    models = structuredClone(savedQueue.models);
    if (!Array.isArray(models) || !models.length || models.some(model => !model?.providerId || !model?.modelId)) throw fail('Saved Worker model route is invalid');
  } else if (resumed) {
    if (!current?.provider || !current?.model) throw fail('Historical Worker has no saved model selection');
    models = [{ providerId: current.provider, modelId: current.model, options: {
      ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort }),
      ...(requestConfig.maxTokens === undefined ? {} : { maxTokens: requestConfig.maxTokens }),
      ...(requestConfig.temperature === undefined ? {} : { temperature: requestConfig.temperature }),
      ...(requestConfig.stop === undefined ? {} : { stop: requestConfig.stop }),
    } }];
  } else models = orderedModels(undefined, policy.workerModels || policy.routingConfig?.workerModels || []);
  if (!models.length) throw fail('Worker model is not configured');
  const index = Number.isSafeInteger(savedQueue?.index) ? savedQueue.index
    : resumed && current ? models.findIndex(model => sameWorkerModel(model, current)) : 0;
  if (index < 0 || !models[index]) throw fail('Saved Worker selection is outside its frozen work role');
  return { models, index };
}

export function workerRequest(inherited, model) {
  const { provider: _provider, model: _model, reasoningEffort: _effort, maxTokens: _maxTokens,
    temperature: _temperature, stop: _stop, ...controls } = inherited;
  return { ...controls, ...(model.options || {}), provider: model.providerId, model: model.modelId };
}

export function installWorkerChildModelRoute(scope, agent, { worker, models, currentModel }) {
  if (!Array.isArray(models) || typeof currentModel !== 'function') throw fail('Child Worker has no parent work route');
  const model = structuredClone(currentModel());
  if (!model || !models.some(item => JSON.stringify(item) === JSON.stringify(model))) throw fail('Child Worker model is outside the frozen work role');
  const selected = agent.model?.current?.();
  if (selected && !sameWorkerModel(model, selected)) throw fail('Child Worker model override is unsupported');
  selectWorkerModel(agent, model);
  scope.on('agent/request', async (_payload, next) => {
    if (!worker?.session) throw fail('Parent Worker is unavailable');
    const inherited = await next();
    if (inherited.provider !== undefined && (inherited.provider !== model.providerId || inherited.model !== model.modelId)) throw fail('Child Worker model override is unsupported');
    return workerRequest(inherited, model);
  }, { prepend: true });
}
