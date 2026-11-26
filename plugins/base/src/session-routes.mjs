import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, chmod, writeFile } from 'node:fs/promises';
import { resolve, join, dirname, parse } from 'node:path';
import { modelProtocol, nativeProviderRoute, providerProtocolReason, routerGoModelProtocolReason } from './provider-access.mjs';

const supported = new Set(['codex', 'claude', 'pi', 'opencode']);
const piApis = { openai: 'openai-completions', responses: 'openai-responses', anthropic: 'anthropic-messages' };
const openCodePackages = { openai: '@ai-sdk/openai-compatible', responses: '@ai-sdk/openai', anthropic: '@ai-sdk/anthropic' };
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
export function createSessionRoutes({ directory, providers, runtimeSettings, harnessDefaults, resolveModel } = {}) {
  if (!directory || !providers?.resolve) throw new TypeError('directory and providers.resolve are required');
  const describe = async providerId => { try { return await (providers.describeRoute ? providers.describeRoute(providerId) : providers.resolve(providerId)); } catch { fail('无法读取绑定供应商，请检查供应商配置。'); } };
  const descriptor = (tool, providerId, model, value) => {
    const direct = nativeProviderRoute(tool, value);
    if (!direct) fail(providerProtocolReason(tool));
    return { version: 1, mode: 'managed', tool, providerId, model, baseURL: endpoint(direct.baseURL), protocol: direct.protocol, sourceProtocol: text(direct.sourceProtocol, '供应商协议'), ...(value.credentialRef ? { credentialRef: text(value.credentialRef, '凭据引用') } : {}) };
  };
  const snapshotConfig = async (tool, input) => {
    if (tool === 'pi' || tool === 'opencode') {
      if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)) fail('此 Harness 尚无高级配置项。');
      return {};
    }
    if (input === undefined && !runtimeSettings) return {};
    if (!runtimeSettings?.validate) fail('Harness 高级配置服务不可用。');
    return runtimeSettings.validate(tool, input ?? await runtimeSettings.get(tool));
  };
  const defaultConfig = async (tool, providerId, model) => {
    if (tool === 'pi' || tool === 'opencode') return {};
    return harnessDefaults ? harnessDefaults(tool, providerId, model) : await runtimeSettings?.get(tool) ?? {};
  };
  return {
    supports: sessionRouteSupport,
    defaultConfig,
    async capture({ tool, providerId, model, protocol, advancedConfig } = {}) {
      if (!sessionRouteSupport(tool).supported) fail(sessionRouteSupport(tool).reason);
      providerId = text(providerId, '供应商'); model = text(model, '模型');
      const value = await describe(providerId);
      const route = descriptor(tool, providerId, model, value);
      if (protocol !== undefined && modelProtocol(protocol) !== route.protocol) fail('所选协议与供应商配置不一致。');
      if (value.managedRouterGo) {
        let rows;
        try { rows = await providers.routerGoProtocolModels(providerId); } catch { fail('无法读取 RouterGo 账号支持的模型，请重试。'); }
        const reason = routerGoModelProtocolReason(tool, rows.get(model), route.protocol);
        if (reason) fail(reason);
      }
      const settings = await snapshotConfig(tool, advancedConfig ?? (harnessDefaults ? await defaultConfig(tool, providerId, model) : undefined));
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
      if (tool === 'pi' || tool === 'opencode') {
        const info = await resolveModel?.(route.providerId, route.model);
        const vision = info?.inputModalities?.includes('image') === true;
        const provider = 'benchgo-session';
        Object.assign(managedProfile, { provider, vision });
        const env = { BENCHGO_SESSION_API_KEY: value.apiKey };
        if (tool === 'pi') {
          const agentDir = await privateDirectory(join(run, 'pi'));
          await writeFile(join(agentDir, 'models.json'), JSON.stringify({
            providers: { [provider]: { baseUrl: route.baseURL, api: piApis[route.protocol], apiKey: '$BENCHGO_SESSION_API_KEY',
              models: [{ id: route.model, input: vision ? ['text', 'image'] : ['text'] }],
            } },
          }), { mode: 0o600 });
          return { env: { ...env, PI_CODING_AGENT_DIR: agentDir }, managedProfile };
        }
        const config = {
          model: provider + '/' + route.model,
          enabled_providers: [provider],
          provider: { [provider]: { npm: openCodePackages[route.protocol], name: 'BenchGo Session',
            options: { baseURL: route.baseURL, apiKey: '{env:BENCHGO_SESSION_API_KEY}' },
            models: { [route.model]: { name: route.model, attachment: vision, modalities: { input: vision ? ['text', 'image'] : ['text'], output: ['text'] } } },
          } },
        };
        const [configHome, dataHome, cacheHome, stateHome] = await Promise.all(
          ['config', 'data', 'cache', 'state'].map(name => privateDirectory(join(run, 'opencode', name))),
        );
        return { env: { ...env, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome, XDG_CACHE_HOME: cacheHome, XDG_STATE_HOME: stateHome,
          OPENCODE_CONFIG: undefined, OPENCODE_CONFIG_DIR: undefined, OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
          OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true',
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        }, managedProfile };
      }
      const home = await privateDirectory(join(run, 'claude'));
      const env = { ...route.advancedConfig?.settings?.env, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_USE_BEDROCK: undefined, CLAUDE_CODE_USE_VERTEX: undefined, CLAUDE_CODE_USE_FOUNDRY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CODE_API_KEY_HELPER_TTL_MS: undefined, ANTHROPIC_BASE_URL: route.baseURL, ANTHROPIC_AUTH_TOKEN: value.apiKey, ANTHROPIC_API_KEY: value.apiKey, ANTHROPIC_MODEL: route.model, ANTHROPIC_DEFAULT_SONNET_MODEL: route.model, ANTHROPIC_DEFAULT_OPUS_MODEL: route.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: route.model, CLAUDE_CODE_SUBAGENT_MODEL: route.model };
      const settings = { ...route.advancedConfig?.settings, env, model: route.model };
      return { env, settings, settingSources: [], managedProfile };
    },
  };
}
