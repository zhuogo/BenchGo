import { ToolInstaller } from './tool-install.mjs';
import { createToolProfiles } from './tool-profiles.mjs';
import { createSessionRoutes } from './session-routes.mjs';
import { createPickerCatalog } from './picker-catalog.mjs';
import { assertProviderToolAccess } from './provider-access.mjs';
import { createNativeAuth } from './native-auth.mjs';
import { assertSameOrigin } from '../shared/http.mjs';
import { readLimited } from '../shared/http.mjs';

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
  providers.setNativeAuth?.(createNativeAuth({ installer }));
  const profiles = options.profiles ?? createToolProfiles({ directory, providers });
  const routeService = createSessionRoutes({ directory, providers, profiles });
  const pickerCatalog = createPickerCatalog({ commander, installer, profiles, providers, routeService, llm: ctx.llm, isHarnessAvailable: () => !!getCommander() });
  const service = { installer, profiles, routeService, pickerCatalog, providers };
  if (commander) Object.assign(commander, { toolInstaller: installer, toolProfiles: profiles, routeService, pickerCatalog });
  // Direct official provider selections must obey the same subscription boundary
  // as opaque native routes, including auxiliary requests and stored selections.
  if (ctx.on && providers.describeAccess) ctx.on('llm/stream', async function* (options, next) {
    if (!options.provider?.startsWith('commander-') && ctx.llm?.listConfigurableProviders?.().some(entry => entry.provider === options.provider)) {
      const access = await providers.describeAccess(options.provider);
      try { assertProviderToolAccess(access, 'harness'); }
      catch (error) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: error.code, message: error.message + ' 请在模型菜单中选择对应的 Harness 工具。' } } };
        return;
      }
    }
    yield* next();
  });
  const dispatch = async (input, signal) => {
    if (!getCommander() && !['pickerCatalog', 'catalog', 'profiles', 'providers', 'models', 'modelProfiles', 'setBindings'].includes(input.action)) throw Object.assign(new Error('Harness 聚合未启用或尚未就绪'), { status: 503, code: 'HARNESS_UNAVAILABLE' });
    switch (input.action) {
      case 'pickerCatalog': return pickerCatalog.list();
      case 'catalog': return { tools: (await installer.list()).map(tool => ({ ...tool, routeSupported: !!getCommander() && routeService.supports(tool.id).supported, routeReason: !getCommander() ? 'Harness 聚合未启用或尚未就绪' : routeService.supports(tool.id).reason })), ...await profiles.list(), providerAccess: await providers.accessList?.() ?? [] };
      case 'profiles': return profiles.list();
      case 'providers': return { providers: await providers.list() };
      case 'models': return { models: await providers.models(input.providerId, signal) };
      case 'modelProfiles': {
        const timeout = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
        const response = await (options.fetcher ?? globalThis.fetch)('https://routergo.cn/api/x/public/models', { headers: { accept: 'application/json' }, redirect: 'error', signal: timeout });
        if (!response.ok) { await response.body?.cancel(); throw Error('模型参数目录暂不可用'); }
        const body = JSON.parse(new TextDecoder().decode(await readLimited(response, 4 * 1024 * 1024, timeout)));
        if (body?.success !== true || !Array.isArray(body.data)) throw Error('模型参数目录格式无效');
        return { success: true, data: body.data };
      }
      case 'job': return { job: installer.job(input.id) };
      case 'install': return { job: installer.install(input.tool) };
      case 'update': return { job: installer.updateTool(input.tool) };
      case 'reinstall': return { job: installer.reinstall(input.tool) };
      case 'uninstall': return { job: installer.uninstall(input.tool, { snapshot: input.snapshot }) };
      case 'uninstallPreview': return { preview: await installer.previewUninstall(input.tool) };
      case 'cancel': return { job: installer.cancel(input.id) };
      case 'setDefault': {
        const profile = (await profiles.list()).profiles?.find(item => item.tool === input.tool);
        if (!profile || profile.revision !== input.revision) throw Object.assign(Error('工具方案已变更，请刷新'), { status: 409 });
        await routeService.capture({ ...profile, tool: input.tool });
        return profiles.setDefault(input);
      }
      case 'saveProfile': return { profile: await profiles.save(input) };
      case 'setBindings': return profiles.setBindings(input);
      case 'preview': return { preview: await profiles.preview(input) };
      case 'apply': {
        if (input.confirmNativeWrite !== true) throw Object.assign(Error('同步本机配置需要显式确认；设置新会话默认不会修改本机配置'), { status: 409 });
        if (busy(input.tool)) throw Object.assign(Error('工具仍有连接中的会话，请先断开再应用配置'), { status: 409 });
        if (!input.revision || !input.checksums || typeof input.checksums !== 'object' || Array.isArray(input.checksums)) throw Error('请先预览并确认配置文件版本');
        return { result: await profiles.apply(input) };
      }
      case 'restore': {
        if (input.confirmNativeWrite !== true) throw Object.assign(Error('恢复本机配置需要显式确认'), { status: 409 });
        const { backups } = await profiles.list(), backup = backups.find(row => row.id === input.backupId);
        if (backup && busy(backup.tool)) throw Object.assign(Error('工具仍有连接中的会话，请先断开再恢复'), { status: 409 });
        return { result: await profiles.restore(input) };
      }
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
    if (commander?.toolInstaller === installer) { commander.toolInstaller = undefined; commander.toolProfiles = undefined; if (commander.routeService === routeService) commander.routeService = undefined; if (commander.pickerCatalog === pickerCatalog) commander.pickerCatalog = undefined; }
    await installer.close();
  });
  return { ...service, fetch };
}
