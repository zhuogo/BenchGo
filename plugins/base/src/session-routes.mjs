import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, chmod } from 'node:fs/promises';
import { resolve, join, dirname, parse } from 'node:path';
import { modelProtocol, nativeProviderRoute, providerProtocolReason, routerGoModelProtocolReason } from './provider-access.mjs';

const supported = new Set(['codex', 'claude']);
export const sessionRouteSupport = tool => supported.has(tool) ? { supported: true } : { supported: false, reason: '此工具尚未接通隔离 API 会话。' };
const fail = message => { const error = new Error(message); error.code = 'SESSION_ROUTE'; throw error; };
const text = (value, label) => { if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\u0000-\u001f]/u.test(value)) fail('无效的' + label); return value; };
const endpoint = value => { let url; try { url = new URL(value); } catch { fail('供应商地址无效'); } if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('供应商地址无效'); return url.href.replace(/\/$/u, ''); };
const fingerprint = route => createHash('sha256').update(JSON.stringify([route.tool, route.providerId, route.model, route.baseURL, route.protocol, route.sourceProtocol ?? null, route.credentialRef ?? null, route.advancedConfig ?? {}])).digest('hex');
const configArgs = config => {
  const flatten = (value, path = []) => Object.entries(value).flatMap(([key, child]) => child && typeof child === 'object' && !Array.isArray(child) ? flatten(child, [...path, key]) : [[...path, key].join('.') + '=' + JSON.stringify(child)]);
  return flatten(config).flatMap(value => ['-c', value]);
};
async function privateDirectory(directory) {
  const target = resolve(directory); let part = target;
  while (part !== parse(part).root) { try { if ((await lstat(part)).isSymbolicLink()) fail('隔离目录不能经过符号链接'); } catch (error) { if (error.code !== 'ENOENT') throw error; } part = dirname(part); }
  await mkdir(target, { recursive: true, mode: 0o700 }); await chmod(target, 0o700); return target;
}
export function createSessionRoutes({ directory, providers, runtimeSettings } = {}) {
  if (!directory || !providers?.resolve) throw new TypeError('directory and providers.resolve are required');
  const describe = async providerId => { try { return await (providers.describeRoute ? providers.describeRoute(providerId) : providers.resolve(providerId)); } catch { fail('无法读取绑定供应商，请检查供应商配置。'); } };
  const descriptor = (tool, providerId, model, value) => {
    const direct = nativeProviderRoute(tool, value);
    if (!direct) fail(providerProtocolReason(tool));
    return { version: 1, mode: 'managed', tool, providerId, model, baseURL: endpoint(direct.baseURL), protocol: direct.protocol, sourceProtocol: text(direct.sourceProtocol, '供应商协议'), ...(value.credentialRef ? { credentialRef: text(value.credentialRef, '凭据引用') } : {}) };
  };
  const snapshotConfig = async (tool, input) => {
    if (input === undefined && !runtimeSettings) return {};
    if (!runtimeSettings?.validate) fail('Harness 高级配置服务不可用。');
    return runtimeSettings.validate(tool, input ?? await runtimeSettings.get(tool));
  };
  return {
    supports: sessionRouteSupport,
    async capture({ tool, providerId, model, protocol, advancedConfig } = {}) {
      if (!sessionRouteSupport(tool).supported) fail(sessionRouteSupport(tool).reason);
      providerId = text(providerId, '供应商'); model = text(model, '模型');
      const value = await describe(providerId);
      const route = descriptor(tool, providerId, model, value);
      if (protocol !== undefined && modelProtocol(protocol) !== route.protocol) fail('所选协议与供应商配置不一致。');
      if (value.managedRouterGo) {
        let rows;
        try { rows = await providers.routerGoProtocolModels(providerId); } catch { fail('无法读取 RouterGo 账号支持的模型，请重试。'); }
        const reason = routerGoModelProtocolReason(tool, rows.get(model));
        if (reason) fail(reason);
      }
      const settings = await snapshotConfig(tool, advancedConfig);
      if (Object.keys(settings).length) route.advancedConfig = settings;
      return { ...route, revision: randomUUID(), fingerprint: fingerprint(route) };
    },
    async launch({ tool, route, sessionId } = {}) {
      if (!sessionRouteSupport(tool).supported) fail(sessionRouteSupport(tool).reason);
      if (!route || route.tool !== tool || route.mode !== 'managed' || route.version !== 1 || fingerprint(route) !== route.fingerprint || !/^[a-f0-9-]{36}$/iu.test(sessionId || '')) fail('会话绑定无效，拒绝使用其他模型或原生订阅替代。');
      const value = await describe(route.providerId), current = descriptor(tool, route.providerId, route.model, value);
      if (route.advancedConfig) current.advancedConfig = await snapshotConfig(tool, route.advancedConfig);
      if (fingerprint(current) !== route.fingerprint) fail('绑定供应商的地址、协议或凭据引用已更改，请新建会话或恢复原配置。');
      if (typeof value.apiKey !== 'string' || !value.apiKey || /[\r\n\u0000]/u.test(value.apiKey)) fail('绑定供应商没有可用密钥。');
      const root = await privateDirectory(join(directory, 'managed-runs')), run = await privateDirectory(join(root, sessionId));
      const managedProfile = { configured: true, isolated: true, providerId: route.providerId, model: route.model, directory: run };
      if (tool === 'codex') {
        const home = await privateDirectory(join(run, 'codex'));
        const providerId = 'benchgo_' + sessionId.replaceAll('-', '');
        const providerConfig = '{name="BenchGo Session",base_url=' + JSON.stringify(route.baseURL) + ',wire_api="responses",env_key="BENCHGO_SESSION_API_KEY",requires_openai_auth=false}';
        const overrides = { model: route.model, model_provider: providerId };
        const commandArgs = [...configArgs(route.advancedConfig?.config ?? {}), ...configArgs(overrides), '-c', 'model_providers.' + providerId + '=' + providerConfig];
        return { env: { CODEX_HOME: home, BENCHGO_SESSION_API_KEY: value.apiKey }, commandArgs, managedProfile };
      }
      const home = await privateDirectory(join(run, 'claude'));
      const env = { ...route.advancedConfig?.settings?.env, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_USE_BEDROCK: undefined, CLAUDE_CODE_USE_VERTEX: undefined, CLAUDE_CODE_USE_FOUNDRY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CODE_API_KEY_HELPER_TTL_MS: undefined, ANTHROPIC_BASE_URL: route.baseURL, ANTHROPIC_AUTH_TOKEN: value.apiKey, ANTHROPIC_API_KEY: value.apiKey, ANTHROPIC_MODEL: route.model, ANTHROPIC_DEFAULT_SONNET_MODEL: route.model, ANTHROPIC_DEFAULT_OPUS_MODEL: route.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: route.model, CLAUDE_CODE_SUBAGENT_MODEL: route.model };
      const settings = { ...route.advancedConfig?.settings, env, model: route.model };
      return { env, settings, settingSources: [], managedProfile };
    },
  };
}
