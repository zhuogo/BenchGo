import { isRouterGo, routerGo } from '../shared/builtin-providers.mjs';
import { isRouterGoAccountReference, routerGoOrigin } from '../shared/routergo-account.mjs';
import { hasTextCapability } from '../shared/model-capabilities.mjs';

const protocols = {
  'openai-completions': 'openai',
  'openai-compatible': 'openai',
  openai: 'openai',
  responses: 'responses',
  'openai-responses': 'responses',
  anthropic: 'anthropic',
  'anthropic-messages': 'anthropic',
};

export const modelProtocol = value => Object.hasOwn(protocols, value) ? protocols[value] : null;
export const protocolForTool = tool => tool === 'codex' ? 'responses' : tool === 'claude' ? 'anthropic' : null;
export const supportsNativeImages = tool => ['codex', 'claude', 'pi', 'opencode'].includes(tool);

export const isManagedRouterGo = (providerId, baseURL, credentialRef) => isRouterGo(providerId)
  && typeof baseURL === 'string' && baseURL.replace(/\/$/u, '') === routerGo.baseURL
  && isRouterGoAccountReference(credentialRef);

export function nativeProviderRoute(tool, provider) {
  const configured = provider.modelProtocol ?? modelProtocol(provider.protocol);
  const protocol = protocolForTool(tool) ?? (['pi', 'opencode'].includes(tool) ? configured : null);
  if (!protocol) return null;
  if (provider.managedRouterGo) {
    if (protocol === 'anthropic') return { protocol, sourceProtocol: 'anthropic-messages', baseURL: routerGoOrigin + '/api' };
    return { protocol, sourceProtocol: protocol === 'responses' ? 'openai-responses' : 'openai-completions', baseURL: routerGo.baseURL };
  }
  if (configured !== protocol) return null;
  return { protocol, sourceProtocol: provider.protocol, baseURL: provider.baseURL };
}

export function providerProtocolReason(tool) {
  if (!protocolForTool(tool)) return '供应商未配置可用的对话 API';
  return '供应商未配置 ' + (tool === 'codex' ? 'Responses' : 'Anthropic Messages') + ' API';
}

const routerGoProtocolCapabilities = {
  responses: 'responses',
  openai: 'chat',
  anthropic: 'anthropic-messages',
};
const protocolLabels = { responses: 'Responses', openai: 'Chat Completions', anthropic: 'Anthropic Messages' };

export function routerGoModelProtocolReason(tool, model, protocol = protocolForTool(tool) ?? 'responses') {
  if (!model) return 'RouterGo 账号当前未提供此模型';
  if (!hasTextCapability(model.capabilities)) return '此模型未启用文本能力。';
  const capabilities = model.providerCapabilities ?? model.capabilities;
  if (tool === 'claude') {
    // RouterGo's existing Claude Code integration bridges its declared text routes.
    if (!Object.values(routerGoProtocolCapabilities).some(capability => capabilities.includes(capability))) return '此模型没有可用的对话接口';
  } else if (!Object.hasOwn(routerGoProtocolCapabilities, protocol)) {
    return '当前 RouterGo 配置未指定可用的对话协议';
  } else if (!capabilities.includes(routerGoProtocolCapabilities[protocol])) {
    return 'RouterGo 账号未为此模型开放 ' + protocolLabels[protocol] + ' API';
  }
}

export function assertProviderToolAccess(provider, tool) {
  if (!provider || provider.authMode !== 'api') throw Object.assign(new Error('此会话需要在模型设置中配置 API 凭据。'), { status: 409, code: 'API_CREDENTIAL_REQUIRED' });
  const protocol = protocolForTool(tool);
  if (protocol && !nativeProviderRoute(tool, provider)) throw Object.assign(new Error(providerProtocolReason(tool)), { status: 409, code: 'API_PROTOCOL_MISMATCH' });
}
