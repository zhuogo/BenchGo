import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { configFor, createBoundary, eventFor, fail, deliveryId, validId } from '../china-common.mjs';
import { beforeDelivery, deliveryFailure, replyWindowExpired } from '../delivery-outcome.mjs';

const contextLimit = 1000;
const maxStateValueBytes = 65536;
const authError = '微信登录已失效，请重新扫码';
const contextError = '微信回复上下文已失效，等待用户在微信发送新消息';
const stateValue = value => typeof value === 'string' && Buffer.byteLength(value) <= maxStateValueBytes;
const messageId = value => typeof value === 'string' ? value : Number.isSafeInteger(value) && value > 0 ? String(value) : '';
const staleContext = body => (body.ret === -2 || body.errcode === -2)
  && ['unknown error', 'prepare failed'].includes(String(body.errmsg || '').toLowerCase());
const parseResponse = async response => JSON.parse(await response.text(), (key, value, context) =>
  key === 'message_id' && typeof value === 'number' && /^[0-9]+$/.test(context?.source || '') ? context.source : value);

const officialOrigin = value => {
  let url; try { url = new URL(value); } catch { throw fail('微信服务地址无效'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.weixin.qq.com') || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') throw fail('仅支持微信官方 HTTPS 服务地址');
  return url.origin;
};

export const channelDefinition = {
  id: 'weixin', label: '微信', defaults: { enabled: false, ownerIds: [], chatIds: [], accountId: '', tokenRef: '', baseUrl: 'https://ilinkai.weixin.qq.com' },
  fields: [{ key: 'accountId', label: 'iLink 机器人账号 ID', type: 'text', required: true }, { key: 'tokenRef', label: 'iLink Token', type: 'secretRef', required: true }, { key: 'baseUrl', label: '官方服务地址', type: 'text', advanced: true }],
  capabilities: { externalActions: ['external-send'], direct: true, group: false, text: true, attachments: false, realtimeVoice: false, qrLogin: true, transport: 'long-poll', notes: '扫码连接 iLink 机器人私聊，也可在此页面安全录入已有 Token。不支持普通微信群；图片、文件、语音附件暂不支持。' },
};
export const weixinConfig = input => { const config = configFor(channelDefinition, input); officialOrigin(config.baseUrl); return config; };
export function normalizeWeixinEvent(message, config, metadataOnly = false) {
  if (message?.message_type !== 1 || message.group_id || message.room_id || message.chat_room_id || message.from_user_id === config.accountId
    || (message.msg_type === 1 && message.to_user_id && message.to_user_id !== config.accountId)) return null;
  const id = messageId(message.message_id);
  if (!validId(id) || !validId(message.from_user_id)) return null;
  const items = !metadataOnly && Array.isArray(message.item_list) ? message.item_list : [];
  const text = items.filter(x => x?.type === 1 && typeof x.text_item?.text === 'string').map(x => x.text_item.text).join('\n');
  return eventFor('weixin', config, { messageId: id, actorId: message.from_user_id, chatId: message.from_user_id,
    metadataOnly, text: metadataOnly ? '' : text || '[此消息包含暂不支持的附件，请发送文字说明或使用 BenchGo 工作台]', occurredAt: message.create_time_ms });
}
export function createWeixinAdapter(options) {
  const b = createBoundary(channelDefinition, options), contexts = new Map();
  let generation = 0, cursor = '', checkpoint, restoring, restored = false, task, timer, wake, starting;
  let login, disposed = false;
  const now = options.now || Date.now;
  const clearLogin = () => { if (login) { clearTimeout(login.timer); login.controller.abort(); login = undefined; } };
  const loginRequest = async (session, path) => {
    if (disposed || login !== session || now() >= session.expiresAt) throw fail('扫码会话已失效，请重新开始', 410);
    let response, body;
    options.assertCurrent?.();
    try {
      response = await (options.fetcher || fetch)(session.origin + path, { method: 'GET', redirect: 'error', headers: { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '131584' }, signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout(35_000)]) });
      body = await response.json();
    } catch { throw fail('微信扫码请求失败，请重试', 502); }
    if (disposed || login !== session || now() >= session.expiresAt) throw fail('扫码会话已失效，请重新开始', 410);
    options.assertCurrent?.();
    if (!response.ok || !body || typeof body !== 'object' || (body.ret !== undefined && body.ret !== 0) || (body.errcode !== undefined && body.errcode !== 0)) throw fail('微信扫码请求未成功', 502);
    return body;
  };
  const request = async (config, endpoint, payload, timeout = 15_000, source) => {
    const token = await beforeDelivery(() => b.secret(config.tokenRef));
    const body = await b.request(config, `${officialOrigin(config.baseUrl)}/ilink/bot/${endpoint}`, { method: 'POST',
      headers: { 'content-type': 'application/json', AuthorizationType: 'ilink_bot_token', authorization: `Bearer ${token}`,
        'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'), 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '131584' },
      body: JSON.stringify({ ...payload, base_info: { channel_version: '2.2.0' } }) }, timeout, { parseResponse, ...(source ? { operation: 'send', source } : {}) });
    if (body.ret === -14 || body.errcode === -14) {
      b.state.authentication = 'failed';
      b.state.connection = { state: 'failed' };
      b.state.error = authError;
      throw deliveryFailure(authError, 'not_sent', 401);
    }
    if (source && staleContext(body)) throw replyWindowExpired(contextError);
    if ([body.ret, body.errcode].some(code => Number.isInteger(code) && code !== 0)) throw deliveryFailure('微信拒绝本次请求', 'not_sent', 502);
    if ([body.ret, body.errcode].some(code => code !== undefined && code !== 0)) throw deliveryFailure('微信返回无效回执');
    return body;
  };
  const checkScope = (config, event) => options.isSourceAllowed
    ? options.isSourceAllowed(event.source, event.actor)
    : !config.chatIds.length || config.chatIds.includes(event.source.chatId);
  const restore = config => {
    if (restored) return;
    restoring ||= (async () => {
      if (options.runtimeState) {
        const secret = await b.secret(config.tokenRef);
        checkpoint = options.runtimeState({ accountId: config.accountId,
          credentialIdentity: createHash('sha256').update(JSON.stringify([config.tokenRef, secret, config.baseUrl])).digest('hex') });
        const saved = await checkpoint.read();
        await b.current(config);
        if (stateValue(saved?.cursor)) cursor = saved.cursor;
        if (Array.isArray(saved?.contexts)) {
          for (const row of saved.contexts.slice(-contextLimit)) {
            if (!Array.isArray(row)) continue;
            const [chatId, token] = row;
            if (validId(chatId) && stateValue(token) && token && config.ownerIds.includes(chatId)
              && (!config.chatIds.length || config.chatIds.includes(chatId))) contexts.set(chatId, token);
          }
        }
      }
      restored = true;
    })().finally(() => { restoring = undefined; });
    return restoring;
  };
  const saveProgress = async (config, nextCursor) => {
    if (!checkpoint) return;
    await b.current(config);
    options.assertCurrent?.();
    await checkpoint.write({ cursor: nextCursor, contexts: [...contexts] });
  };
  const rememberContext = async (config, event, token) => {
    if (!stateValue(token) || !token || contexts.get(event.source.chatId) === token) return;
    if (!config.ownerIds.includes(event.actor.id) && !(options.allowUnboundAuthorization && !config.ownerIds.length)) return;
    const chatId = event.source.chatId, previous = new Map(contexts);
    contexts.delete(chatId);
    contexts.set(chatId, token);
    if (contexts.size > contextLimit) contexts.delete(contexts.keys().next().value);
    try { await saveProgress(config, cursor); }
    catch (error) {
      contexts.clear();
      for (const entry of previous) contexts.set(...entry);
      throw error;
    }
  };
  const poll = async (config, gen) => {
    let timeout = 40000;
    while (generation === gen) {
      try {
        if (!restored) await restore(config);
        if (gen !== generation) break;
        const body = await request(config, 'getupdates', { get_updates_buf: cursor }, timeout);
        if (gen !== generation) break;
        if ((body.msgs !== undefined && !Array.isArray(body.msgs))
          || (body.get_updates_buf !== undefined && !stateValue(body.get_updates_buf))
          || (body.ret !== 0 && body.errcode !== 0 && !Array.isArray(body.msgs) && !stateValue(body.get_updates_buf))) throw fail('微信轮询回执无效', 502);
        if (Number.isSafeInteger(body.longpolling_timeout_ms) && body.longpolling_timeout_ms > 0) timeout = Math.min(120000, body.longpolling_timeout_ms + 3000);
        b.state.authentication = 'verified';
        for (const message of body.msgs || []) {
          if (gen !== generation) break;
          const event = normalizeWeixinEvent(message, config, true);
          if (!event) continue;
          if (!checkScope(config, event)) {
            options.observeSource?.(event.source, event.actor);
            continue;
          }
          await b.current(config);
          await b.authorize('receive', event.source, event.actor);
          await rememberContext(config, event, message.context_token);
          const result = await options.ingest({ ...event, normalize: () => normalizeWeixinEvent(message, config) });
          if (!result?.ignored) b.state.events = 'verified';
        }
        if (gen !== generation) break;
        if (body.get_updates_buf !== undefined && body.get_updates_buf !== cursor) {
          await saveProgress(config, body.get_updates_buf);
          cursor = body.get_updates_buf;
        }
        b.state.connection = { state: 'connected' }; b.state.error = null;
      } catch (error) {
        if (gen !== generation) break;
        if (error.status === 401 || /HTTP 40[13]/.test(error.message)) {
          b.state.authentication = 'failed'; b.state.connection = { state: 'failed' }; b.state.error = authError;
          return;
        }
        b.state.connection = { state: 'reconnecting' }; b.state.error = '微信轮询失败，请检查凭据或网络';
      }
      // Prevent tight loops when the upstream returns immediately; stop wakes this timer.
      await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, b.state.error ? 5000 : (options.pollDelayMs ?? 500)); timer.unref?.(); });
    }
  };
  const stop = async () => { generation++; b.stop(); clearTimeout(timer); wake?.(); await task; task = undefined; };
  return { status: b.status,
    async start() {
      starting ||= (async () => {
        await stop();
        if (disposed) return;
        b.reset(); contexts.clear(); cursor = ''; checkpoint = undefined; restored = false;
        const config = await b.read();
        if (!config.enabled || disposed) return;
        b.state.connection = { state: 'connecting' };
        task = poll(config, generation);
      })().finally(() => { starting = undefined; });
      return starting;
    },
    async dispose() { disposed = true; clearLogin(); await stop(); await starting; },
    async action({ operation, loginId, ownerAuthenticated } = {}) {
      if (!ownerAuthenticated) throw fail('扫码登录仅允许已认证主人操作', 403);
      if (disposed) throw fail('渠道已关闭', 409);
      const saveCredential = options.saveCredential || options.credentials?.save?.bind(options.credentials);
      if (typeof saveCredential !== 'function') throw fail('安全凭据服务不可用，无法扫码连接', 503);
      if (operation === 'cancelLogin') { if (login && loginId !== login.id) throw fail('扫码会话无效', 404); clearLogin(); return { status: 'cancelled' }; }
      if (operation === 'startLogin') {
        clearLogin();
        const session = { id: randomUUID(), expiresAt: now() + 480_000, origin: 'https://ilinkai.weixin.qq.com', controller: new AbortController() };
        login = session;
        session.timer = setTimeout(() => { if (login === session) clearLogin(); }, 480_000); session.timer.unref?.();
        try {
          const body = await loginRequest(session, '/ilink/bot/get_bot_qrcode?bot_type=3');
          if (!validId(body.qrcode) || typeof body.qrcode_img_content !== 'string' || body.qrcode_img_content.length > 8192) throw fail('微信二维码回执无效', 502);
          let qr; try { qr = new URL(body.qrcode_img_content); } catch { throw fail('微信二维码地址无效', 502); }
          if (qr.protocol !== 'https:' || !qr.hostname.endsWith('.weixin.qq.com') || qr.username || qr.password) throw fail('微信二维码来源无效', 502);
          session.qrcode = body.qrcode;
          return { status: 'wait', loginId: session.id, qrContent: body.qrcode_img_content, expiresAt: session.expiresAt };
        } catch (error) { if (login === session) clearLogin(); throw error; }
      }
      if (operation !== 'pollLogin') throw fail('不支持的微信操作');
      const session = login;
      if (!session || loginId !== session.id || now() >= session.expiresAt) { if (session && now() >= session.expiresAt) clearLogin(); throw fail('扫码会话已失效，请重新开始', 410); }
      if (session.pending) return session.pending;
      session.pending = (async () => {
        const body = await loginRequest(session, `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qrcode)}`);
        if (body.status === 'expired') { clearLogin(); return { status: 'expired' }; }
        if (body.status === 'binded_redirect') { clearLogin(); throw fail('此微信已绑定机器人，请核对当前连接或在微信解除绑定后重新扫码', 409); }
        if (body.status === 'blocked') { clearLogin(); throw fail('微信暂未允许本次授权，请重新获取二维码', 409); }
        if (body.status === 'scaned_but_redirect') {
          if (body.redirect_host) session.origin = officialOrigin(`https://${body.redirect_host}`);
          return { status: 'scanned' };
        }
        if (body.status !== 'confirmed') return { status: body.status === 'scaned' ? 'scanned' : 'wait' };
        if (!validId(body.ilink_bot_id) || typeof body.bot_token !== 'string' || !body.bot_token || body.bot_token.length > 65536) throw fail('微信登录回执缺少账号或凭据', 502);
        const baseUrl = officialOrigin(body.baseurl || session.origin);
        const saved = await saveCredential({ channel: 'weixin', field: 'tokenRef', secret: body.bot_token });
        if (!validId(saved?.ref)) throw fail('微信凭据保存失败', 503);
        if (login !== session || disposed) throw fail('扫码会话已取消', 410);
        options.assertCurrent?.();
        clearLogin();
        return { status: 'confirmed', config: { accountId: body.ilink_bot_id, tokenRef: saved.ref, baseUrl,
          ...(validId(body.ilink_user_id) ? { ownerIds: [body.ilink_user_id] } : {}) } };
      })();
      try { return await session.pending; } finally { session.pending = undefined; }
    },
    async verify() {
      // getupdates is a consuming endpoint: verification starts the actual durable intake loop.
      if (!task || b.state.authentication === 'failed') await this.start();
      return b.status();
    },
    async send({ source, text, idempotencyKey }) {
      const config = await b.outgoing(source, text, idempotencyKey);
      await beforeDelivery(() => restore(config));
      const context = contexts.get(source.chatId);
      if (!context) throw replyWindowExpired(contextError);
      const clientId = deliveryId(idempotencyKey);
      const body = await request(config, 'sendmessage', { msg: { from_user_id: '', to_user_id: source.chatId, client_id: clientId, message_type: 2, message_state: 2, context_token: context, item_list: [{ type: 1, text_item: { text } }] } }, 15_000, source);
      const receipt = messageId(body.message_id);
      if (!validId(receipt) && body.ret !== 0 && body.errcode !== 0) throw deliveryFailure('微信缺少确定发送回执', 'unknown', 502);
      b.state.sending = 'verified'; return { status: 'accepted', messageId: validId(receipt) ? receipt : clientId };
    },
  };
}
