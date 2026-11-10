import { authorizeChannel } from '../connection-authorization.mjs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { beforeDelivery, deliveryFailure, httpRejected } from '../delivery-outcome.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/u.test(value);
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function whatsappConfig(input = {}) {
  const defaults = { enabled: false, phoneNumberId: '', apiVersion: 'v23.0', accessTokenRef: '', appSecretRef: '', verificationTokenRef: '', ownerIds: [], chatIds: [], admissionMode: 'manual', machineIds: [], enabledRuleIds: [] };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !(key in defaults))) throw fail('WhatsApp 配置包含无效字段');
  const config = { ...defaults, ...structuredClone(input) };
  if (typeof config.enabled !== 'boolean' || !['manual', 'auto'].includes(config.admissionMode)) throw fail('WhatsApp 启用或准入设置无效');
  for (const key of ['phoneNumberId', 'accessTokenRef', 'appSecretRef', 'verificationTokenRef']) if (config[key] !== '' && !id(config[key])) throw fail(`WhatsApp ${key} 无效`);
  if (!/^v\d+\.\d+$/u.test(config.apiVersion)) throw fail('WhatsApp API 版本无效');
  for (const key of ['ownerIds', 'chatIds', 'machineIds', 'enabledRuleIds']) {
    if (!Array.isArray(config[key]) || config[key].length > 1000 || !config[key].every(id)) throw fail(`WhatsApp ${key} 无效`);
    config[key] = [...new Set(config[key])];
  }
  if (config.enabled && ['phoneNumberId', 'accessTokenRef', 'appSecretRef', 'verificationTokenRef'].some(key => !config[key])) throw fail('启用 WhatsApp 前请填写号码 ID 和凭据引用');
  return config;
}

export function normalizeWhatsAppEvents(body, config, metadataOnly = false) {
  if (body?.object !== 'whatsapp_business_account') return [];
  const events = [];
  for (const entry of body.entry || []) for (const change of entry.changes || []) {
    const value = change.value;
    if (change.field !== 'messages' || value?.metadata?.phone_number_id !== config.phoneNumberId) continue;
    for (const message of value.messages || []) {
      if (!id(message.id) || !id(message.from) || !id(message.type)) throw fail('WhatsApp 消息元数据无效');
      const time = Number(message.timestamp) * 1000;
      if (!Number.isSafeInteger(time) || time <= 0 || Number.isNaN(new Date(time).getTime())) throw fail('WhatsApp 消息时间无效');
      const text = metadataOnly ? '' : message.text?.body ?? message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? message.button?.text ?? message[message.type]?.caption ?? `[WhatsApp ${message.type} 消息；当前连接不支持读取媒体正文，请发送文字描述]`;
      if (typeof text !== 'string') throw fail('WhatsApp 正文无效');
      const threadId = `whatsapp:${config.phoneNumberId}:${message.from}:direct`;
      events.push({ sourceKey: `whatsapp:${config.phoneNumberId}:${message.id}`, channel: 'whatsapp', threadId, messageId: message.id,
        actor: { id: message.from, kind: 'human', owner: false }, sourceType: 'direct', kind: 'direct', mentioned: false, occurredAt: new Date(time).toISOString(), text,
        source: { channel: 'whatsapp', appId: config.phoneNumberId, accountId: config.phoneNumberId, sourceType: 'direct', conversationId: message.from, topicId: null, chatId: message.from, messageId: message.id, threadId, ...(id(message.context?.id) ? { parentMessageId: message.context.id } : {}) },
        raw: metadataOnly ? {} : { message: structuredClone(message) } });
    }
  }
  return events;
}

export function createWhatsAppAdapter({ getConfig, credentials, ingest, authorizeConnection, allowUnboundAuthorization = false, fetcher = fetch, now = Date.now, requestTimeoutMs = 15_000 } = {}) {
  if (typeof getConfig !== 'function' || typeof ingest !== 'function') throw fail('WhatsApp 缺少配置或统一入口');
  const shutdown = new AbortController();
  let state = { authentication: 'unverified', events: 'unverified', sending: 'unverified', lastEventAt: null, lastSendAt: null, error: null }, configKey;
  const read = async () => {
    shutdown.signal.throwIfAborted();
    const config = whatsappConfig(await getConfig()), key = JSON.stringify(config);
    if (configKey !== key) { configKey = key; state = { authentication: 'unverified', events: 'unverified', sending: 'unverified', lastEventAt: null, lastSendAt: null, error: null }; }
    return config;
  };
  const connectionSource = config => ({ channel: 'whatsapp', accountId: config.phoneNumberId, appId: config.phoneNumberId, sourceType: 'system', conversationId: null, chatId: null, topicId: null });
  const authorize = (operation, source, actor) => authorizeChannel({ authorizeConnection, allowUnboundAuthorization }, operation, source, actor);
  const enabled = config => { if (!config.enabled) throw fail('WhatsApp 链接未启用', 409); };
  const secret = async ref => { const value = (await credentials?.resolve(ref))?.value; if (typeof value !== 'string' || !value) throw fail('WhatsApp 凭据不可用', 503); return value; };
  const current = async config => { const latest = await read(); enabled(latest); if (JSON.stringify(config) !== JSON.stringify(latest)) throw fail('WhatsApp 配置已更改', 409); };
  const api = async (config, path = '', payload, source) => {
    const token = await beforeDelivery(async () => { const value = await secret(config.accessTokenRef); await current(config); await authorize(payload ? 'send' : 'receive', source || connectionSource(config)); return value; });
    let response, body;
    try { response = await fetcher(`https://graph.facebook.com/${config.apiVersion}/${encodeURIComponent(config.phoneNumberId)}${path}`, { method: payload ? 'POST' : 'GET', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(requestTimeoutMs)]) }); body = await response.json(); }
    catch { throw deliveryFailure('WhatsApp 请求未取得确定回执', 'unknown', 502); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw deliveryFailure('WhatsApp 返回无效回执', 'unknown', 502);
    if (!response.ok || body.error) throw deliveryFailure(`WhatsApp 接口失败（HTTP ${response.status}，code ${Number.isInteger(body.error?.code) ? body.error.code : 'unknown'}）；请检查权限及客服会话窗口`, Number.isInteger(body.error?.code) || httpRejected(response.status) ? 'not_sent' : 'unknown', 502);
    return body;
  };
  return {
    async status() { const config = await read(); return { enabled: config.enabled, configured: Boolean(config.phoneNumberId && config.accessTokenRef && config.appSecretRef && config.verificationTokenRef), transport: 'webhook', ...structuredClone(state), connection: { state: !config.enabled ? 'stopped' : state.events === 'verified' ? 'connected' : 'listening' } }; },
    async verify() { const config = await read(); enabled(config); try { const body = await api(config); if (body.id !== config.phoneNumberId) throw fail('WhatsApp 返回的号码身份不一致', 502); state.authentication = 'verified'; state.error = null; return this.status(); } catch (error) { state.authentication = 'failed'; state.error = error.message; throw error; } },
    async handle(request) {
      try {
        const config = await read(); enabled(config); await authorize('receive', connectionSource(config));
        if (request.method === 'GET') {
          const query = new URL(request.url).searchParams;
          if (query.get('hub.mode') !== 'subscribe' || !equal(query.get('hub.verify_token'), await secret(config.verificationTokenRef))) throw fail('WhatsApp 验证失败', 401);
          const challenge = query.get('hub.challenge'); if (!id(challenge)) throw fail('WhatsApp 验证挑战无效');
          await current(config); return new Response(challenge);
        }
        if (request.method !== 'POST') throw fail('Method not allowed', 405);
        const reader = request.body?.getReader(); if (!reader) throw fail('WhatsApp 请求体为空');
        const chunks = []; let size = 0;
        try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1024 * 1024) { await reader.cancel(); throw fail('WhatsApp 事件过大', 413); } chunks.push(value); } } finally { reader.releaseLock(); }
        const raw = Buffer.concat(chunks);
        const signature = 'sha256=' + createHmac('sha256', await secret(config.appSecretRef)).update(raw).digest('hex');
        if (!equal(signature, request.headers.get('x-hub-signature-256'))) throw fail('WhatsApp 签名无效', 401);
        let body; try { body = JSON.parse(raw.toString('utf8')); } catch { throw fail('WhatsApp JSON 无效'); }
        const events = normalizeWhatsAppEvents(body, config, true);
        await current(config);
        for (const event of events) { await authorize('receive', event.source, event.actor); await ingest({ ...event, normalize: () => normalizeWhatsAppEvents(body, config).find(item => item.messageId === event.messageId) || null }); }
        state.events = 'verified'; state.lastEventAt = now(); state.error = null;
        return Response.json({ ok: true });
      } catch (error) { return Response.json({ error: error.status >= 500 || !error.status ? 'WhatsApp 事件暂未持久接收，请重试' : 'WhatsApp 事件校验失败' }, { status: error.status || 503 }); }
    },
    async send({ source, text, idempotencyKey }) {
      const config = await beforeDelivery(async () => {
        const current = await read(); enabled(current);
        if (source?.channel !== 'whatsapp' || source.appId !== current.phoneNumberId || !id(source.chatId) || !id(source.messageId)) throw fail('WhatsApp 交付来源不在当前链接范围', 403);
        if (typeof text !== 'string' || !text.trim() || text.length > 4096 || !id(idempotencyKey)) throw fail('WhatsApp 交付正文或幂等键无效');
        return current;
      });
      try {
        const body = await api(config, '/messages', { messaging_product: 'whatsapp', recipient_type: 'individual', to: source.chatId, type: 'text', text: { body: text }, context: { message_id: source.messageId } }, source);
        if (!id(body.messages?.[0]?.id)) throw deliveryFailure('WhatsApp 回执缺少消息标识', 'unknown', 502);
        state.sending = 'verified'; state.lastSendAt = now(); state.error = null;
        return { status: 'accepted', messageId: body.messages[0].id, idempotencyKey };
      } catch (error) { state.sending = 'failed'; state.error = error.message; throw error; }
    },
    dispose() { shutdown.abort(); },
  };
}

export const channelDefinition = { id: 'whatsapp', label: 'WhatsApp', defaults: { phoneNumberId: '', apiVersion: 'v23.0', accessTokenRef: '', appSecretRef: '', verificationTokenRef: '' }, capabilities: { externalActions: ['external-send'], direct: true, text: true, groups: false, attachments: false }, fields: [
  { key: 'phoneNumberId', label: '电话号码 ID', required: true },
  { key: 'accessTokenRef', label: 'Access Token 凭据', type: 'secretRef', required: true },
  { key: 'appSecretRef', label: 'App Secret 凭据', type: 'secretRef', required: true },
  { key: 'verificationTokenRef', label: '回调验证凭据', type: 'secretRef', required: true },
  { key: 'apiVersion', label: 'Graph API 版本', advanced: true },
] };
