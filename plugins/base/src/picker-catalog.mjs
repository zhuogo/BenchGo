import { nativeProviderRoute, providerProtocolReason, routerGoModelProtocolReason, supportsNativeImages } from './provider-access.mjs';
import { hasTextCapability } from '../shared/model-capabilities.mjs';
import { nativeModelReasoning } from '../shared/runtime-setting-fields.mjs';

/** Credential-free catalog shared by the official picker and native adapters. */
const PREFIX = 'dsh-route-v1:';
const cleanId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/u.test(value);
export function encodeRouteModelId(providerId, nativeModelId) {
  if (!cleanId(providerId) || !cleanId(nativeModelId)) throw new Error('Invalid provider/model route');
  return PREFIX + Buffer.from(JSON.stringify([providerId, nativeModelId]), 'utf8').toString('base64url');
}
export function decodeRouteModelId(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return null;
  if (value.length > 8192) throw new Error('Invalid provider/model route');
  try {
    const pair = JSON.parse(Buffer.from(value.slice(PREFIX.length), 'base64url').toString('utf8'));
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(cleanId) || encodeRouteModelId(...pair) !== value) throw Error();
    return { providerId: pair[0], model: pair[1] };
  } catch { throw new Error('Invalid provider/model route'); }
}
const positive = value => Number.isSafeInteger(value) && value > 0;
function safeReasoning(value) {
  if (!Array.isArray(value?.efforts)) return undefined;
  const efforts = value.efforts.filter(item => cleanId(item?.id)).map(item => ({ id: item.id, name: cleanId(item.name) ? item.name : item.id, ...(cleanId(item.description) ? { description: item.description } : {}) }));
  return efforts.length ? { efforts, ...(efforts.some(item => item.id === value.defaultEffort) ? { defaultEffort: value.defaultEffort } : {}) } : undefined;
}
export async function resolveCatalogModel(llm, providerId, row) {
  if (!llm?.resolveModelInfo) return row;
  try { return { ...row, ...await llm.resolveModelInfo(providerId, row.id) }; }
  catch { return row; }
}
export function createPickerCatalog({ commander, installer, providers, routeService, llm, isHarnessAvailable = () => true, cacheMs = 5000, modelCacheMs = 30_000 } = {}) {
  let installCache, installAt = 0, installationJob, catalogJob, modelSnapshot;
  const installations = async () => {
    if (installCache && Date.now() - installAt < cacheMs) return installCache;
    // Model selection needs executable availability, not CLI versions or package-manager provenance.
    if (!installationJob) {
      const job = Promise.resolve(installer?.list?.({ includeDetails: false }) ?? []).then(rows => {
        if (installationJob === job) { installCache = rows; installAt = Date.now(); }
        return rows;
      }).finally(() => { if (installationJob === job) installationJob = undefined; });
      installationJob = job;
    }
    return installationJob;
  };
  const capability = tool => { const value = (routeService ?? commander?.routeService)?.supports?.(tool); return tool === 'deepseek' ? { supported: true } : value === true ? { supported: true } : value && typeof value === 'object' ? value : { supported: false }; };
  const supports = tool => isHarnessAvailable() && capability(tool).supported === true;
  const providerModels = async providerId => {
    const rows = llm?.listModels ? await llm.listModels(providerId) : await providers.models(providerId);
    return Promise.all(rows.filter(row => cleanId(row?.id) && !row.kinds?.length && (!row.inputModalities?.length || row.inputModalities.includes('text'))).map(async row => {
      const resolved = await resolveCatalogModel(llm, providerId, row);
      const contextWindow = resolved.context?.contextWindow ?? resolved.contextWindow, reasoning = safeReasoning(resolved.reasoning);
      return { id: row.id, name: cleanId(row.name) ? row.name : row.id,
        inputModalities: resolved.inputModalities?.includes('image') ? ['text', 'image'] : ['text'],
        ...(positive(contextWindow) ? { context: { contextWindow } } : {}), ...(reasoning ? { reasoning } : {}) };
    }));
  };
  const build = async () => {
    const [installed, configured] = await Promise.all([installations(), providers?.list?.() ?? []]);
    const tools = [
      { id: 'deepseek', name: 'DeepSeek', installed: true, available: true, chatSupported: true, routeSupported: true },
      ...installed.map(tool => {
        const routeSupported = tool.chatSupported === true && supports(tool.id);
        const available = tool.installed === true && tool.available !== false && routeSupported;
        return {
          id: tool.id, name: tool.name || tool.id, installed: tool.installed === true, available,
          chatSupported: tool.chatSupported === true, routeSupported,
          ...(!tool.chatSupported ? { routeReason: '此工具暂未接入会话' }
            : !routeSupported ? { routeReason: !isHarnessAvailable() ? 'Harness 聚合未启用或尚未就绪' : capability(tool.id).reason || '此工具暂不支持 API 会话路由' }
            : !available ? { routeReason: tool.availabilityReason || '此 Harness 工具不可启动，请检查安装' } : {}),
        };
      }),
    ];
    const providerRows = configured.filter(provider => cleanId(provider.id) && provider.authMode === 'api' && provider.configured === true);
    const routes = [];
    const visibleProviders = await Promise.all(providerRows.map(async source => {
      const provider = {
        id: source.id, name: cleanId(source.name) ? source.name : source.id,
        ...(source.declared === true ? { declared: true } : {}),
        protocol: source.protocol ?? null, modelProtocol: source.modelProtocol ?? null,
        tools: [], unavailableTools: {},
      };
      let rows, accountModels;
      try {
        const [models, account, overrides] = await Promise.all([
          providerModels(provider.id), source.managedRouterGo ? providers.routerGoProtocolModels(provider.id) : undefined,
          source.managedRouterGo ? undefined : providers.modelCapabilities?.(provider.id),
        ]);
        const byId = new Map(overrides?.map(({ modelId, capabilities }) => [modelId, capabilities]));
        rows = models.filter(row => !byId.has(row.id) || hasTextCapability(byId.get(row.id)));
        accountModels = account;
      } catch { provider.unavailableReason = '无法读取供应商模型目录'; return provider; }
      if (accountModels) provider.accountManaged = true;
      for (const tool of tools) {
        if (!tool.available) {
          provider.unavailableTools[tool.id] = tool.routeReason;
          continue;
        }
        const direct = tool.id === 'deepseek' ? null : nativeProviderRoute(tool.id, source);
        if (tool.id !== 'deepseek' && !direct) {
          provider.unavailableTools[tool.id] = providerProtocolReason(tool.id);
          continue;
        }
        const configuredProtocol = direct?.protocol ?? source.modelProtocol;
        const available = accountModels ? rows.filter(model => !routerGoModelProtocolReason(tool.id, accountModels.get(model.id), configuredProtocol)) : rows;
        if (accountModels && !available.length) {
          provider.unavailableTools[tool.id] = 'RouterGo 账号暂无兼容此协议的文本模型';
          continue;
        }
        provider.tools.push(tool.id);
        for (const model of available) {
          const reasoning = tool.id === 'deepseek' ? model.reasoning : nativeModelReasoning(tool.id, model.reasoning);
          routes.push({
            tool: tool.id, providerId: provider.id, providerName: provider.name,
            modelId: tool.id === 'deepseek' ? model.id : encodeRouteModelId(provider.id, model.id),
            nativeModelId: model.id, name: model.name, protocol: direct?.protocol ?? provider.protocol,
            inputModalities: tool.id === 'deepseek' || supportsNativeImages(tool.id) ? model.inputModalities : ['text'],
            ...(model.context ? { context: model.context } : {}),
            ...(reasoning ? { reasoning } : {}),
          });
        }
      }
      provider.tools.sort();
      return provider;
    }));
    routes.sort((a, b) => a.tool.localeCompare(b.tool) || a.providerId.localeCompare(b.providerId) || a.nativeModelId.localeCompare(b.nativeModelId));
    return { tools, providers: visibleProviders, routes };
  };
  // Official selection asks native adapters to list models again, even for a
  // known route. Reuse route metadata when the underlying inputs are unchanged.
  const read = (reuse = false) => {
    const available = isHarnessAvailable();
    if (catalogJob?.available !== available) catalogJob = undefined;
    if (reuse && !catalogJob && modelSnapshot?.available === available && Date.now() < modelSnapshot.expires) return Promise.resolve(modelSnapshot.value);
    if (!catalogJob) {
      const operation = { available };
      operation.promise = build().then(value => {
        if (catalogJob === operation) {
          modelSnapshot = value.providers.some(provider => provider.unavailableReason)
            ? undefined : { available, value, expires: Date.now() + modelCacheMs };
        }
        return value;
      }).catch(error => {
        if (catalogJob === operation) modelSnapshot = undefined;
        throw error;
      }).finally(() => { if (catalogJob === operation) catalogJob = undefined; });
      catalogJob = operation;
    }
    const active = catalogJob;
    return active.promise.then(value => {
      if (active.available !== isHarnessAvailable() || active.invalidated) return read(reuse);
      return value;
    });
  };
  return {
    list: async () => structuredClone(await read()),
    decodeModelId: decodeRouteModelId,
    invalidate({ installations = false } = {}) {
      if (installations) { installCache = undefined; installationJob = undefined; }
      if (catalogJob) catalogJob.invalidated = true;
      catalogJob = modelSnapshot = undefined;
    },
    async models(tool, { fresh = false } = {}) {
      const catalog = await read(!fresh);
      return catalog.routes.filter(row => row.tool === tool).map(row => ({ provider: 'commander-' + tool, id: row.modelId, name: row.name, inputModalities: [...row.inputModalities], providerId: row.providerId, providerName: row.providerName, nativeModelId: row.nativeModelId, ...(row.context ? { context: structuredClone(row.context) } : {}), ...(row.reasoning ? { reasoning: structuredClone(row.reasoning) } : {}) }));
    },
  };
}
