import { ToolInstaller } from './tool-install.mjs';
import { createSessionRoutes } from './session-routes.mjs';
import { createPickerCatalog } from './picker-catalog.mjs';
import { assertProviderToolAccess, routerGoModelProtocolReason } from './provider-access.mjs';
import { createRuntimeSettings } from './runtime-settings.mjs';
import { assertSameOrigin } from '../shared/http.mjs';
import { readLimited } from '../shared/http.mjs';
import { fetchPublicModelProfiles } from './model-providers.mjs';
import { hasTextCapability } from '../shared/model-capabilities.mjs';

/** Owner-only management surface; credentials are resolved only inside adapters. */
export async function mountTooling(ctx, commander, providers, options = {}) {
  const getCommander = options.getCommander ?? (() => commander ?? ctx.get?.('commander'));
  const directory = options.directory ?? commander?.store.directory;
  const busy = tool => {
    const current = getCommander();
    return !!current && [...current.sessions.values()].some(session => session.provider === tool &&
      (current.drivers.has(session.id) || current.connecting.has(session.id) || ['running', 'connecting', 'waiting'].includes(session.status)));
  };
  const installer = options.installer ?? new ToolInstaller({ isRunning: busy });
  const runtimeSettings = options.runtimeSettings ?? createRuntimeSettings({ directory });
  const routeService = createSessionRoutes({ directory, providers, runtimeSettings, async harnessDefaults(tool, providerId, model) {
    if (tool === 'claude') return { settings: { env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } } };
    const config = { features: { multi_agent: true } };
    const subagentSettings = ctx.settings?.describe({ redactSecrets: true }).find(({ ns }) => ns === 'subagent')?.value;
    const maxDepth = subagentSettings?.maxDepth ?? ctx.get?.('subagents')?.resolveMaxDepth?.();
    const maxActive = subagentSettings?.maxActiveSubagents;
    const agents = {};
    if (Number.isSafeInteger(maxDepth) && maxDepth >= 1 && maxDepth <= 8) agents.max_depth = maxDepth;
    if (Number.isSafeInteger(maxActive) && maxActive >= 1 && maxActive <= 32) agents.max_threads = maxActive;
    if (Object.keys(agents).length) config.agents = agents;
    const info = await ctx.llm?.resolveModelInfo?.(providerId, model).catch(() => undefined);
    const contextWindow = info?.context?.contextWindow;
    if (Number.isSafeInteger(contextWindow) && contextWindow >= 1024 && contextWindow <= 10000000) config.model_context_window = contextWindow;
    return { config };
  } });
  const pickerCatalog = createPickerCatalog({ commander, installer, providers, routeService, llm: ctx.llm, isHarnessAvailable: () => !!getCommander() });
  for (const event of ['llm/adapters-updated', 'llm/models-updated', 'credentials/record-updated', 'credentials/reference-updated']) {
    ctx.on?.(event, () => pickerCatalog.invalidate());
  }
  ctx.on?.('settings/document-updated', namespace => {
    if (namespace !== 'agent-default-model') pickerCatalog.invalidate();
  });
  ctx.effect(() => {
    const refreshInstallations = job => {
      if (job.finishedAt) pickerCatalog.invalidate({ installations: true });
    };
    installer.on?.('job', refreshInstallations);
    return () => installer.off?.('job', refreshInstallations);
  });
  const service = { installer, routeService, pickerCatalog, providers, runtimeSettings };
  if (commander) Object.assign(commander, { toolInstaller: installer, routeService, pickerCatalog, runtimeSettings });
  // Configurable model routes use the API credentials from Models settings.
  if (ctx.on && providers.describeAccess) ctx.on('llm/stream', async function* (options, next) {
    if (!options.provider?.startsWith('commander-') && ctx.llm?.listConfigurableProviders?.().some(entry => entry.provider === options.provider)) {
      let access;
      try { access = await providers.describeAccess(options.provider); assertProviderToolAccess(access, 'harness'); }
      catch (error) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: error.code || 'API_CREDENTIAL_REQUIRED', message: '请在模型设置中配置可用的 API 凭据。' } } };
        return;
      }
      if (!access.managedRouterGo && providers.modelCapabilities) {
        let message;
        try {
          const override = (await providers.modelCapabilities(options.provider)).find(row => row.modelId === options.model);
          if (override && !hasTextCapability(override.capabilities)) message = '此模型未启用文本能力。';
        } catch { message = '无法读取模型能力设置，请重试。'; }
        if (message) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_TEXT_UNAVAILABLE', message } } };
          return;
        }
      }
      if (access.managedRouterGo) {
        let reason;
        try { reason = routerGoModelProtocolReason('deepseek', (await providers.routerGoProtocolModels(options.provider)).get(options.model), access.modelProtocol); }
        catch { reason = '无法读取 RouterGo 账号支持的模型，请重试。'; }
        if (reason) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'ROUTERGO_MODEL_UNAVAILABLE', message: reason } } };
          return;
        }
      }
    }
    yield* next();
  });
  const dispatch = async (input, signal) => {
    if (!getCommander() && !['pickerCatalog', 'catalog', 'providers', 'models', 'deepSeekModels', 'modelProfiles', 'modelCapabilities', 'saveModelCapabilities'].includes(input.action)) throw Object.assign(new Error('Harness 聚合未启用或尚未就绪'), { status: 503, code: 'HARNESS_UNAVAILABLE' });
    switch (input.action) {
      case 'pickerCatalog': return pickerCatalog.list();
      case 'catalog': return { tools: (await installer.list()).map(tool => {
        const route = routeService.supports(tool.id);
        return { ...tool, available: !!getCommander() && route.supported && tool.available === true, routeSupported: !!getCommander() && route.supported,
          routeReason: !getCommander() ? 'Harness 聚合未启用或尚未就绪' : route.reason ?? tool.availabilityReason };
      }) };
      case 'toolConfig': return { config: await runtimeSettings.get(input.tool) };
      case 'saveToolConfig': return { config: await runtimeSettings.save(input.tool, input.config, input.changedFields) };
      case 'providers': return { providers: await providers.list() };
      case 'models': return { models: await providers.models(input.providerId, signal) };
      case 'deepSeekModels': {
        const provider = ctx.llm.listConfigurableProviders().find(row => row.settingsNs === 'llm-deepseek' && row.provider === input.providerId);
        if (!provider) throw Object.assign(Error('DeepSeek 连接不可用'), { status: 404 });
        try {
          const rows = await ctx.llm.listModels(provider.provider);
          return { models: rows.map(({ id, name, inputModalities }) => ({ id, name, inputModalities })) };
        } catch {
          throw Object.assign(Error('暂时无法同步 DeepSeek 模型'), { status: 502 });
        }
      }
      case 'modelCapabilities': return { overrides: await providers.modelCapabilities(input.providerId) };
      case 'saveModelCapabilities': {
        const result = await providers.saveModelCapabilities(input.providerId, input.modelId, input.capabilities);
        pickerCatalog.invalidate();
        return result;
      }
      case 'modelProfiles': return fetchPublicModelProfiles(options.fetcher ?? globalThis.fetch, AbortSignal.any([signal, AbortSignal.timeout(15000)]));
      case 'job': return { job: installer.job(input.id) };
      case 'install': return { job: installer.install(input.tool) };
      case 'update': return { job: installer.updateTool(input.tool) };
      case 'uninstall': return { job: installer.uninstall(input.tool, { snapshot: input.snapshot }) };
      case 'uninstallPreview': return { preview: await installer.previewUninstall(input.tool) };
      case 'cancel': return { job: installer.cancel(input.id) };
      default: throw Error('未知工具管理操作');
    }
  };
  const fetch = async request => {
    try {
      assertSameOrigin(request);
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw Object.assign(Error('Expected application/json'), { status: 415 });
      const input = JSON.parse(new TextDecoder().decode(await readLimited(request, 300 * 1024)));
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('请求必须为 JSON 对象');
      return Response.json(await dispatch(input, request.signal), { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      // Provider/installer failures carry controlled messages; never serialize options or resolved secrets.
      return Response.json({ error: error.message }, { status: Number.isInteger(error.status) ? error.status : 400, headers: { 'cache-control': 'no-store' } });
    }
  };
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/commander/tooling', methods: ['POST'], requestBody: 'buffered', fetch }));
  ctx.effect(() => async () => {
    if (commander?.toolInstaller === installer) { commander.toolInstaller = undefined; if (commander.runtimeSettings === runtimeSettings) commander.runtimeSettings = undefined; if (commander.routeService === routeService) commander.routeService = undefined; if (commander.pickerCatalog === pickerCatalog) commander.pickerCatalog = undefined; }
    await installer.close();
  });
  return { ...service, fetch };
}
