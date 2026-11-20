import { authorizeChannel } from './connection-authorization.mjs';
import { createHash } from 'node:crypto';
import { beforeDelivery, deliveryFailure, httpRejected } from './delivery-outcome.mjs';

export const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/u.test(value);
export function configFor(definition, input = {}) {
  const defaults = { enabled: false, ownerIds: [], chatIds: [], ...definition.defaults };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !(key in defaults))) throw fail('渠道配置包含未知字段');
  const config = { ...defaults, ...structuredClone(input) };
  if (typeof config.enabled !== 'boolean') throw fail('启用状态无效');
  for (const key of ['ownerIds', 'chatIds']) {
    if (!Array.isArray(config[key]) || config[key].length > 1000 || !config[key].every(validId)) throw fail(`${key} 无效`);
    config[key] = [...new Set(config[key])];
  }
  for (const field of definition.fields) {
    if (typeof config[field.key] !== 'string' || (config[field.key] && !validId(config[field.key]))
      || (field.type === 'select' && !field.options.some(option => option.value === config[field.key]))) throw fail(`${field.label} 无效`);
    if (config.enabled && field.required && !config[field.key]) throw fail(`请配置 ${field.label}`);
  }
  return config;
}
export const account = config => config.accountId || config.botId || config.appId;
export function protocolTimestamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
export function eventFor(channel, config, { messageId, actorId, chatId, text, group = false, mentioned = false, occurredAt, extra = {}, metadataOnly = false }) {
  if (![messageId, actorId, chatId].every(validId) || (!metadataOnly && typeof text !== 'string')) throw fail('渠道消息标识或内容无效');
  const sourceType = extra.topicId ? 'topic' : group ? 'group' : 'direct';
  const threadId = `${channel}:${account(config)}:${group ? 'group' : 'direct'}:${chatId}`;
  return { sourceKey: `${channel}:${account(config)}:${messageId}`, channel, threadId, messageId,
    actor: { id: actorId, kind: 'human', owner: false }, sourceType, kind: sourceType,
    ...(!metadataOnly ? { occurredAt: occurredAt && Number.isFinite(new Date(occurredAt).getTime()) ? new Date(occurredAt).toISOString() : new Date().toISOString(), text, mentioned } : {}),
    source: { channel, accountId: account(config), chatId, conversationId: chatId, topicId: null, sourceType, messageId, threadId, ...extra }, raw: { messageId } };
}
export function createBoundary(definition, { getConfig, credentials, ingest, authorizeConnection, allowUnboundAuthorization = false, fetcher = fetch }) {
  let controller = new AbortController();
  const state = { authentication: 'unverified', events: 'unverified', sending: 'unverified', connection: { state: 'stopped' }, error: null };
  const read = async () => configFor(definition, await getConfig());
  const current = async config => {
    controller.signal.throwIfAborted();
    const latest = await read();
    if (!latest.enabled || JSON.stringify(latest) !== JSON.stringify(config)) throw fail('渠道已停用或配置已改变', 409);
  };
  const secret = async ref => {
    const value = (await credentials?.resolve(ref))?.value;
    if (typeof value !== 'string' || !value) throw fail('渠道凭据不可用，请在资源 → 链接中重新录入', 503);
    return value;
  };
  const connectionSource = config => ({ channel: definition.id, accountId: account(config), sourceType: 'system', conversationId: null, chatId: null, topicId: null });
  const authorize = (operation, source, actor) => authorizeChannel({ authorizeConnection, allowUnboundAuthorization }, operation, source, actor);
  return { state, read, current, secret, authorize, connectionSource,
    reset() { controller.abort(); controller = new AbortController(); Object.assign(state, { authentication: 'unverified', events: 'unverified', sending: 'unverified', error: null }); },
    stop() { controller.abort(); state.connection = { state: 'stopped' }; },
    async request(config, url, options = {}, timeout = 15_000, authorization = {}) {
      await beforeDelivery(async () => { await current(config); await authorize(authorization.operation || 'receive', authorization.source || connectionSource(config), authorization.actor); });
      let response, body;
      try {
        response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]) });
        body = authorization.parseResponse ? await authorization.parseResponse(response) : await response.json();
      }
      catch { throw deliveryFailure('渠道请求未获得确定回执', 'unknown', 502); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw deliveryFailure('渠道返回无效回执', 'unknown', 502);
      if (!response.ok) {
        const error = deliveryFailure(`渠道请求失败（HTTP ${response.status}）`, httpRejected(response.status) ? 'not_sent' : 'unknown', 502);
        Object.defineProperty(error, 'platformMessage', { value: typeof body.message === 'string' ? body.message.slice(0, 512) : undefined });
        throw error;
      }
      return body;
    },
    async receive(config, event, normalize) {
      await current(config);
      if (!event) return;
      try { await authorize('receive', event.source, event.actor); }
      catch (error) {
        if (error?.status === 403) return { ignored: true };
        throw error;
      }
      const result = await ingest(normalize ? { ...event, normalize } : event);
      if (!result?.ignored) state.events = 'verified';
      return result;
    },
    async status() { const c = await read(); return { enabled: c.enabled, configured: definition.fields.filter(f => f.required).every(f => Boolean(c[f.key])), ...structuredClone(state) }; },
    async outgoing(source, text, key) {
      return beforeDelivery(async () => {
        const c = await read(); await current(c);
        if (source?.channel !== definition.id || source.accountId !== account(c) || !validId(source.chatId) || !validId(source.messageId)) throw fail('交付来源不在当前渠道范围', 403);
        await authorize('send', source);
        if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 4000 || !validId(key)) throw fail('交付内容或幂等键无效，文本最多 4000 字节');
        return c;
      });
    },
  };
}
export const deliveryId = key => createHash('sha256').update(key).digest('hex').slice(0, 32);

/** Socket framing/lifecycle only. Reconnect never retries outgoing business messages. */
export function createSocketLifecycle({ boundary, connect, onFrame, onClose, reconnectMs = 5000, WebSocketImpl = globalThis.WebSocket }) {
  let socket, heartbeat, reconnect, generation = 0, pending = Promise.resolve();
  let activeConfig;
  const clear = () => { clearInterval(heartbeat); clearTimeout(reconnect); heartbeat = reconnect = undefined; };
  const stop = () => { generation++; clear(); socket?.close(); socket = undefined; boundary.stop(); };
  const send = async (frame, authorization, target = socket) => {
    await beforeDelivery(async () => {
      const config = activeConfig;
      await boundary.current(config);
      await boundary.authorize(authorization?.operation || 'receive', authorization?.source || boundary.connectionSource(config), authorization?.actor);
      if (target !== socket || target?.readyState !== 1 || (authorization?.operation === 'send' && boundary.state.connection.state !== 'connected')) throw fail('渠道连接不可用', 503);
    });
    try { target.send(JSON.stringify(frame)); } catch { throw deliveryFailure('渠道发送未取得确定回执', 'unknown', 502); }
  };
  const schedule = gen => {
    clearTimeout(reconnect);
    reconnect = setTimeout(() => { void open(gen); }, reconnectMs);
    reconnect.unref?.();
  };
  const open = async gen => {
    const config = await boundary.read(); if (!config.enabled || gen !== generation) return;
    activeConfig = config;
    boundary.state.connection = { state: 'connecting' };
    try {
      await boundary.authorize('receive', boundary.connectionSource(config));
      const connection = await connect(config);
      await boundary.current(config); if (gen !== generation) return;
      const target = socket = new WebSocketImpl(connection.url);
      const current = () => gen === generation && target === socket;
      const sendFrame = (frame, authorization) => send(frame, authorization, target);
      const close = () => { if (current()) target.close(); };
      const pulse = (callback, milliseconds) => {
        if (!current()) return;
        clearInterval(heartbeat);
        heartbeat = setInterval(() => Promise.resolve().then(callback).catch(close), milliseconds);
        heartbeat.unref?.();
      };
      const enqueue = action => {
        pending = pending.then(() => current() && action()).catch(() => { if (current()) failed(); });
      };
      target.addEventListener('open', () => { if (connection.open) enqueue(() => connection.open(sendFrame, pulse)); });
      target.addEventListener('message', event => {
        enqueue(async () => {
          await boundary.current(config);
          await boundary.authorize('receive', boundary.connectionSource(config));
          if (!current()) return;
          const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString();
          if (Buffer.byteLength(raw) > 1_048_576) throw fail('渠道消息过大');
          await onFrame(JSON.parse(raw), config, { send: sendFrame, pulse, close });
        });
      });
      target.addEventListener('error', () => { if (current()) failed(); });
      target.addEventListener('close', event => {
        if (!current()) return;
        socket = undefined;
        clear(); boundary.state.connection = { state: 'reconnecting' };
        if (onClose?.(event) === false) boundary.state.connection = { state: 'failed' };
        else schedule(gen);
      });
    } catch { if (gen === generation) { failed(); schedule(gen); } }
  };
  const failed = () => { boundary.state.error ||= '渠道连接或消息处理失败，请检查配置与权限'; boundary.state.connection = { state: 'failed' }; socket?.close(); };
  return { send, stop, disconnect: () => socket?.close(), async start() { stop(); boundary.reset(); await open(generation); }, async dispose() { stop(); await pending; } };
}
