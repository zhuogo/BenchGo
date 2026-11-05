import { createHash } from 'node:crypto';

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
    if (typeof config[field.key] !== 'string' || (config[field.key] && !validId(config[field.key]))) throw fail(`${field.label} 无效`);
    if (config.enabled && field.required && !config[field.key]) throw fail(`请配置 ${field.label}`);
  }
  return config;
}
export const account = config => config.accountId || config.botId || config.appId;
export const allowed = (config, chatId) => !config.chatIds.length || config.chatIds.includes(chatId);
export function eventFor(channel, config, { messageId, actorId, chatId, text, group = false, mentioned = false, occurredAt, extra = {} }) {
  if (![messageId, actorId, chatId].every(validId) || typeof text !== 'string') throw fail('渠道消息标识或内容无效');
  if (!allowed(config, chatId) || actorId === account(config)) return null;
  if (group && !mentioned) return null;
  const threadId = `${channel}:${account(config)}:${group ? 'group' : 'direct'}:${chatId}`;
  return { sourceKey: `${channel}:${account(config)}:${messageId}`, channel, threadId, messageId,
    actor: { id: actorId, kind: 'human', owner: config.ownerIds.includes(actorId) }, kind: group ? 'group' : 'direct',
    occurredAt: occurredAt && Number.isFinite(new Date(occurredAt).getTime()) ? new Date(occurredAt).toISOString() : new Date().toISOString(), text, mentioned,
    source: { channel, accountId: account(config), chatId, messageId, threadId, ...extra }, raw: { messageId } };
}
export function createBoundary(definition, { getConfig, credentials, ingest, fetcher = fetch }) {
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
  return { state, read, current, secret,
    reset() { controller.abort(); controller = new AbortController(); Object.assign(state, { authentication: 'unverified', events: 'unverified', sending: 'unverified', error: null }); },
    stop() { controller.abort(); state.connection = { state: 'stopped' }; },
    async request(config, url, options = {}, timeout = 15_000) {
      await current(config);
      let response, body;
      try { response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]) }); body = await response.json(); }
      catch { throw Object.assign(fail('渠道请求未获得确定回执', 502), { code: 'DELIVERY_UNCERTAIN', deliveryUncertain: true }); }
      if (!response.ok) throw fail(`渠道请求失败（HTTP ${response.status}）`, 502);
      return body;
    },
    async receive(config, event) { await current(config); if (event) { await ingest(event); state.events = 'verified'; } },
    async status() { const c = await read(); return { enabled: c.enabled, configured: definition.fields.filter(f => f.required).every(f => Boolean(c[f.key])), ...structuredClone(state) }; },
    async outgoing(source, text, key) {
      const c = await read(); await current(c);
      if (source?.channel !== definition.id || source.accountId !== account(c) || !validId(source.chatId) || !validId(source.messageId) || !allowed(c, source.chatId)) throw fail('交付来源不在当前渠道范围', 403);
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 4000 || !validId(key)) throw fail('交付内容或幂等键无效，文本最多 4000 字节');
      return c;
    },
  };
}
export const deliveryId = key => createHash('sha256').update(key).digest('hex').slice(0, 32);

/** Socket framing/lifecycle only. Reconnect never retries outgoing business messages. */
export function createSocketLifecycle({ boundary, connect, onFrame, WebSocketImpl = globalThis.WebSocket }) {
  let socket, heartbeat, reconnect, generation = 0, pending = Promise.resolve();
  let activeConfig;
  const clear = () => { clearInterval(heartbeat); clearTimeout(reconnect); heartbeat = reconnect = undefined; };
  const stop = () => { generation++; clear(); socket?.close(); socket = undefined; boundary.stop(); };
  const send = async frame => { await boundary.current(activeConfig); if (socket?.readyState !== 1) throw fail('渠道连接不可用', 503); socket.send(JSON.stringify(frame)); };
  const pulse = (callback, milliseconds) => { clearInterval(heartbeat); heartbeat = setInterval(() => Promise.resolve(callback()).catch(() => socket?.close()), milliseconds); heartbeat.unref?.(); };
  const open = async gen => {
    const config = await boundary.read(); if (!config.enabled || gen !== generation) return;
    activeConfig = config;
    boundary.state.connection = { state: 'connecting' };
    try {
      const connection = await connect(config);
      await boundary.current(config); if (gen !== generation) return;
      socket = new WebSocketImpl(connection.url);
      socket.addEventListener('open', () => { if (gen === generation && connection.open) pending = pending.then(() => gen === generation && connection.open(send, pulse)).catch(() => { if (gen === generation) failed(); }); });
      socket.addEventListener('message', event => {
        if (gen !== generation) return;
        pending = pending.then(async () => { if (gen !== generation) return; await boundary.current(config); if (gen !== generation) return; const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString(); if (Buffer.byteLength(raw) > 1_048_576) throw fail('渠道消息过大'); await onFrame(JSON.parse(raw), config, { send, pulse, close: () => socket?.close() }); }).catch(() => { if (gen === generation) failed(); });
      });
      socket.addEventListener('error', () => { if (gen === generation) failed(); });
      socket.addEventListener('close', () => {
        if (gen !== generation) return;
        clear(); boundary.state.connection = { state: 'reconnecting' };
        reconnect = setTimeout(() => { void open(gen); }, 5000); reconnect.unref?.();
      });
    } catch { if (gen === generation) { failed(); reconnect = setTimeout(() => { void open(gen); }, 5000); reconnect.unref?.(); } }
  };
  const failed = () => { boundary.state.error = '渠道连接或消息处理失败，请检查配置与权限'; boundary.state.connection = { state: 'failed' }; socket?.close(); };
  return { send, stop, async start() { stop(); boundary.reset(); await open(generation); }, async dispose() { stop(); await pending; } };
}
