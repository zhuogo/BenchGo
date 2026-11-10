/** Public requests cannot choose a per-Ticket model. IDs remain opaque. */
export function rejectModelOverride(input) {
  if (input && ['provider', 'model', 'providerId', 'modelId', 'workerModel'].some(key => Object.hasOwn(input, key))) {
    throw Object.assign(new Error('单工单模型覆盖已移除，请在系统工作模型角色中配置'), { code: 'MODEL_OVERRIDE_UNSUPPORTED' });
  }
}

export function configuredWorkModel(policy) {
  const model = (policy.workerModels || policy.routingConfig?.workerModels || [])[0];
  if (!model?.providerId || !model?.modelId) throw Object.assign(new Error('尚未配置可用的 Worker 工作角色模型'), { code: 'WORKER_MODEL_NOT_CONFIGURED' });
  return structuredClone(model);
}
