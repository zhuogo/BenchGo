import { createHash } from 'node:crypto';

const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new Error(`无效${label}`);
  return value;
};
const digest = value => createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex');
const linkService = ctx => {
  const service = ctx.get?.('benchgoLink');
  if (!service) throw Object.assign(new Error('Link 服务不可用'), { code: 'LINK_UNAVAILABLE' });
  return service;
};

/** Resolve exact execution resources without creating a business Task on the peer. */
export async function readRemoteExecutionCatalog(ctx, deviceId, signal) {
  required(deviceId, '目标设备');
  if (deviceId === 'local') throw new Error('远端执行目录需要明确目标设备');
  const link = linkService(ctx);
  const devices = await link.devices({ signal });
  const device = devices.devices?.find(row => row.id === deviceId);
  if (!device?.hostId || !device.authorizationId) throw Object.assign(new Error('目标设备身份或连接授权尚未核实'), { code: 'EXECUTION_TARGET_UNVERIFIED' });
  const catalog = await link.callDevice({ deviceId, expectedHostId: device.hostId, expectedAuthorizationId: device.authorizationId,
    input: { action: 'execution', version: 2, operation: 'catalog' }, signal });
  if (catalog?.version !== 2 || catalog.available !== true || catalog.hostId !== device.hostId
    || !Array.isArray(catalog.models) || !Array.isArray(catalog.projects)) throw Object.assign(new Error('目标设备执行目录不可用或协议不匹配，请更新目标设备'), { code: 'EXECUTION_CATALOG_UNAVAILABLE' });
  return { ...catalog, deviceId, hostId: device.hostId, authorizationId: device.authorizationId, name: device.name };
}

export function selectRemoteExecution(catalog, input) {
  const config = input.executionConfig;
  if (!config || Object.keys(config).some(key => !['harness', 'models'].includes(key)) || !['official', 'codex', 'claude'].includes(config.harness)
    || !Array.isArray(config.models) || config.models.length !== 1) throw Object.assign(new Error('远端委派需要从目标执行目录选择一个明确的 Harness、供应商和模型组合'), { code: 'EXECUTION_CONFIG_REQUIRED' });
  for (const model of config.models) {
    if (!model || Object.keys(model).some(key => !['providerId', 'modelId', 'params'].includes(key))
      || typeof model.providerId !== 'string' || !model.providerId || typeof model.modelId !== 'string' || !model.modelId
      || !catalog.models.some(row => row.harness === config.harness && row.providerId === model.providerId && row.modelId === model.modelId
        && digest(row.params ?? null) === digest(model.params ?? null))) throw Object.assign(new Error('远端执行模型或参数不属于已核实目录'), { code: 'EXECUTION_MODEL_UNAVAILABLE' });
  }
  const project = input.projectId === undefined ? undefined : catalog.projects.find(row => row.id === input.projectId);
  if (input.projectId !== undefined && (!project || typeof project.path !== 'string' || !project.path)) throw new Error('目标设备项目不存在');
  return { model: structuredClone(config.models[0]), execution: {
    deviceId: catalog.deviceId, hostId: catalog.hostId, authorizationId: catalog.authorizationId, protocolVersion: 2, config: structuredClone(config),
  }, ...(project ? { project: { deviceId: catalog.deviceId, hostId: catalog.hostId, id: project.id, path: project.path } } : {}) };
}

