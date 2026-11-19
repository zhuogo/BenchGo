import { routerGo } from '../shared/builtin-providers.mjs';
import { isRouterGoAccountReference, routerGoOrigin } from '../shared/routergo-account.mjs';

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

export const isManagedRouterGo = (providerId, baseURL, credentialRef) => providerId === routerGo.id
  && typeof baseURL === 'string' && baseURL.replace(/\/$/u, '') === routerGo.baseURL
  && isRouterGoAccountReference(credentialRef);

export function nativeProviderRoute(tool, provider) {
  const protocol = protocolForTool(tool);
  if (!protocol) return null;
  const configured = provider.modelProtocol ?? modelProtocol(provider.protocol);
  if (provider.managedRouterGo) {
    return protocol === 'responses'
      ? { protocol, sourceProtocol: 'openai-responses', baseURL: routerGo.baseURL }
      : { protocol, sourceProtocol: 'anthropic-messages', baseURL: routerGoOrigin + '/api' };
  }
  if (configured !== protocol) return null;
  return { protocol, sourceProtocol: provider.protocol, baseURL: provider.baseURL };
}

export function providerProtocolReason(tool) {
  return '供应商未配置 ' + (tool === 'codex' ? 'Responses' : 'Anthropic Messages') + ' API';
}

export function routerGoModelProtocolReason(tool, model) {
  if (!model) return 'RouterGo 账号当前未提供此模型';
  const capabilities = model.providerCapabilities ?? model.capabilities ?? [];
  if (tool === 'claude') {
    if (!capabilities.includes('chat') && !capabilities.includes('responses')) return '此模型没有可用的对话接口';
  } else if (!capabilities.includes('responses')) return 'RouterGo 账号未为此模型开放 Responses API';
}

export function assertProviderToolAccess(provider, tool) {
  if (!provider || provider.authMode !== 'api') throw Object.assign(new Error('此会话需要在模型设置中配置 API 凭据。'), { status: 409, code: 'API_CREDENTIAL_REQUIRED' });
  const protocol = protocolForTool(tool);
  if (protocol && !nativeProviderRoute(tool, provider)) throw Object.assign(new Error(providerProtocolReason(tool)), { status: 409, code: 'API_PROTOCOL_MISMATCH' });
}
