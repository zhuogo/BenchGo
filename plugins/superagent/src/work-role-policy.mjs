import { roleModels } from './routing.mjs';

/** Top-level model overrides are invalid; remote executionConfig has its own catalog contract. */
export function rejectModelOverride(input) {
  if (input && ['provider', 'model', 'providerId', 'modelId', 'workerModel'].some(key => Object.hasOwn(input, key))) {
    throw Object.assign(new Error('单任务模型覆盖已移除，请在系统工作模型角色中配置'), { code: 'MODEL_OVERRIDE_UNSUPPORTED' });
  }
}

export function configuredWorkModel(policy) {
  const [model] = roleModels(undefined, policy, 'worker');
  if (!model) throw Object.assign(new Error('尚未配置可用的 Worker 工作角色模型'), { code: 'WORKER_MODEL_NOT_CONFIGURED' });
  const harness = policy.workerHarness ?? policy.routingConfig?.workerHarness;
  return { ...model, ...(harness ? { harness } : {}) };
}
