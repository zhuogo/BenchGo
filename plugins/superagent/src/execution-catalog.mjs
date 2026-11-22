import { createHash } from 'node:crypto';
import plugin from '../../base/package.json' with { type: 'json' };
import { compareVersions } from '../../base/shared/update-feed.mjs';

function remoteVersionWarning(version) {
  try {
    if (compareVersions(version, plugin.version) < 0) return `目标设备的 BenchGo 插件版本 ${version} 低于本机的 ${plugin.version}，部分跨设备操作可能不可用。`;
  } catch {
    return `目标设备未报告可识别的 BenchGo 插件版本，本机为 ${plugin.version}。`;
  }
}

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
  const device = await link.resolveDeviceIdentity({ deviceId, signal });
  const catalog = await link.callDevice({ deviceId, expectedHostId: device.hostId, expectedAuthorizationId: device.authorizationId,
    input: { action: 'execution', version: 2, operation: 'catalog' }, signal });
  if (catalog?.version !== 2 || catalog.available !== true || catalog.hostId !== device.hostId
    || !Array.isArray(catalog.models) || !Array.isArray(catalog.projects)) throw Object.assign(new Error('目标设备执行目录不可用或协议不匹配，请更新目标设备'), { code: 'EXECUTION_CATALOG_UNAVAILABLE' });
  const versionWarning = remoteVersionWarning(catalog.pluginVersion);
  return { ...catalog, deviceId, hostId: device.hostId, authorizationId: device.authorizationId, name: device.name, versionWarning };
}

// Without a Worker configured on the target, use the first model the target itself offers (official Harness first):
// the owner should not have to name a model just to send work to their own device.
const defaultExecutionConfig = catalog => {
  const row = catalog.models.find(item => item.harness === 'official') || catalog.models[0];
  return { harness: row.harness, models: [{ providerId: row.providerId, modelId: row.modelId, ...(row.params === undefined ? {} : { params: structuredClone(row.params) }) }] };
};

export function selectRemoteExecution(catalog, input) {
  const preference = catalog.workerPreference;
  if (preference?.error) throw Object.assign(new Error(preference.error.message), { code: 'EXECUTION_WORKER_UNAVAILABLE' });
  if (!catalog.models.length) throw Object.assign(new Error('目标设备没有可用的执行模型，请在目标设备配置供应商和模型'), { code: 'EXECUTION_MODEL_UNAVAILABLE' });
  const config = preference?.config ?? input.executionConfig ?? defaultExecutionConfig(catalog);
  if (!config || Object.keys(config).some(key => !['harness', 'models'].includes(key)) || !['official', 'codex', 'claude'].includes(config.harness)
    || !Array.isArray(config.models) || config.models.length !== 1) throw Object.assign(new Error('远端委派需要从目标执行目录选择一个明确的 Harness、供应商和模型组合'), { code: 'EXECUTION_CONFIG_REQUIRED' });
  for (const model of config.models) {
    if (!model || Object.keys(model).some(key => !['providerId', 'modelId', 'params'].includes(key))
      || typeof model.providerId !== 'string' || !model.providerId || typeof model.modelId !== 'string' || !model.modelId
      || !catalog.models.some(row => row.harness === config.harness && row.providerId === model.providerId && row.modelId === model.modelId
        && (preference?.config || digest(row.params ?? null) === digest(model.params ?? null)))) throw Object.assign(new Error('远端执行模型或参数不属于已核实目录'), { code: 'EXECUTION_MODEL_UNAVAILABLE' });
  }
  const project = input.projectId === undefined ? undefined : catalog.projects.find(row => row.id === input.projectId);
  if (input.projectId !== undefined && (!project || typeof project.path !== 'string' || !project.path)) throw new Error('目标设备项目不存在');
  return { model: structuredClone(config.models[0]), versionWarning: catalog.versionWarning, execution: {
    deviceId: catalog.deviceId, hostId: catalog.hostId, authorizationId: catalog.authorizationId, protocolVersion: 2, config: structuredClone(config),
    ...(config.harness !== 'official' && catalog.nativeContinuation === true ? { nativeContinuation: true } : {}),
  }, ...(project ? { project: { deviceId: catalog.deviceId, hostId: catalog.hostId, id: project.id, path: project.path } } : {}) };
}

const centers = new WeakMap();
/** The owner's device center with each reachable device's own projects: routing context for work from any conversation. */
export async function readDeviceCenter(ctx, signal, { timeoutMs = 4000, ttlMs = 60000, now = Date.now } = {}) {
  const link = ctx.get?.('benchgoLink');
  if (!link?.devices) return [];
  const cached = centers.get(link);
  if (cached && cached.until > now()) return cached.value;
  const directory = await link.devices({ signal });
  const value = await Promise.all((directory?.devices || []).filter(row => row?.id && row.id !== 'local').map(async row => {
    try {
      const catalog = await readRemoteExecutionCatalog(ctx, row.id, AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]));
      return { deviceId: row.id, name: row.name || catalog.name || row.id, online: true, projects: catalog.projects.map(({ id, title }) => ({ id, title: title || id })) };
    } catch { return { deviceId: row.id, name: row.name || row.id, online: false, projects: [] }; }
  }));
  centers.set(link, { value, until: now() + ttlMs });
  return value;
}

