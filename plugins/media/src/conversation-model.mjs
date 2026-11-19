import { VoiceError } from './config.mjs';

const modelFailures = Object.freeze({
  AUTH: '通话模型认证失败，请检查所选供应商的凭据与权限',
  MISSING_CREDENTIAL: '通话模型缺少凭据，请检查所选供应商的密钥',
  INVALID_CREDENTIAL: '通话模型凭据无效，请检查所选供应商的密钥',
  QUOTA: '通话模型额度不足，请检查所选供应商的余额或配额',
  ACCOUNT_QUOTA: '通话模型账户额度不足，请检查账户配额',
  RATE_LIMIT: '通话模型请求过于频繁，请稍后再试',
  SERVER: '通话模型服务暂时异常，请稍后再试',
  TIMEOUT: '通话模型响应超时，请稍后再试',
  TRANSPORT: '通话模型连接中断，请检查网络后重试',
  INVALID_REQUEST: '通话模型拒绝了请求，请检查模型与协议设置',
  CONTEXT_WINDOW_EXCEEDED: '通话上下文超过模型限制，请重新开始通话或选择更大上下文的模型',
  EMPTY_RESPONSE: '通话模型返回了空回复，请稍后再试',
  NO_ADAPTER: '通话模型供应商尚未就绪，请检查模型设置',
  MODEL_NOT_FOUND: '通话模型不可用，请检查所选模型',
  UNSUPPORTED_REASONING_EFFORT: '通话模型不支持关闭思考，请检查模型设置',
  ABORTED: '通话模型中止了回复，请重试表达',
  BLOCKED: '通话模型拒绝生成本次回复，请调整表达',
  MAX_TOKENS: '通话模型回复达到长度限制，请缩小问题后再试',
});

/** Preserve safe provider failure facts without publishing raw response bodies. */
export function conversationModelFailure(reason, route) {
  const kind = ['error', 'blocked', 'aborted', 'max-tokens'].includes(reason?.kind) ? reason.kind : 'error';
  const source = reason?.failure || {};
  const chosen = kind === 'max-tokens' ? 'MAX_TOKENS' : kind === 'blocked' ? 'BLOCKED' : kind === 'aborted' ? 'ABORTED' : source.code;
  const code = Object.hasOwn(modelFailures, chosen) ? chosen : 'MODEL_ERROR';
  const text = typeof source.message === 'string' ? source.message : '';
  const prefixStatus = /^(?:HTTP\s+)?([45]\d{2})(?:\s|:|$)/iu.exec(text)?.[1];
  const status = Number.isInteger(source.status) && source.status >= 400 && source.status <= 599 ? source.status : prefixStatus ? Number(prefixStatus) : undefined;
  const requestId = typeof source.requestId === 'string' ? source.requestId
    : /["']request_id["']\s*:\s*["']([a-zA-Z0-9._:-]{1,128})["']/u.exec(text)?.[1];
  const safeRequestId = typeof requestId === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/u.test(requestId) ? requestId : undefined;
  const failure = { kind, code, ...(status ? { status } : {}), ...(safeRequestId ? { requestId: safeRequestId } : {}),
    providerId: route.providerId, model: route.model };
  const label = modelFailures[code] || '通话模型请求失败，请检查所选供应商与模型';
  return Object.assign(new VoiceError(`${label}（${code}${status ? '，HTTP ' + status : ''}）`, status || 502), { code, failure });
}

/** Select controls from exact-model metadata and dispatch through that same handle. */
export async function prepareConversationCall(llm, route, signal) {
  if (typeof llm?.prepareCall !== 'function') throw new VoiceError('通话交互模型适配不可用，请检查语音设置', 409);
  let prepared;
  try { prepared = await llm.prepareCall({ provider: route.providerId, model: route.model, reasoningEffort: 'off', maxTokens: 1200 }, signal); }
  catch (error) {
    if (error?.code === 'UNSUPPORTED_REASONING_EFFORT') throw new VoiceError('所选交互模型未声明或不支持关闭思考，请检查模型的思考档位与协议设置', 409);
    if (error?.code && Object.hasOwn(modelFailures, error.code)) throw conversationModelFailure({ kind: 'error', failure: error.failure || { code: error.code, status: error.status } }, route);
    throw error;
  }
  if (!prepared?.config || prepared.config.reasoningEffort !== 'off') throw new VoiceError('所选交互模型未实际关闭思考，请检查模型的思考档位与协议设置', 409);
  return prepared;
}
