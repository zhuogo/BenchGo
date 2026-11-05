import { randomBytes, randomUUID } from 'node:crypto';
import { configFor, createBoundary, eventFor, fail, deliveryId, validId } from './china-common.mjs';
import { beforeDelivery, deliveryFailure } from './delivery-outcome.mjs';

const officialOrigin = value => {
  let url; try { url = new URL(value); } catch { throw fail('微信服务地址无效'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.weixin.qq.com') || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') throw fail('仅支持微信官方 HTTPS 服务地址');
  return url.origin;
};

export const channelDefinition = {
  id: 'weixin', label: '微信', defaults: { enabled: false, ownerIds: [], chatIds: [], accountId: '', tokenRef: '', baseUrl: 'https://ilinkai.weixin.qq.com' },
  fields: [{ key: 'accountId', label: 'iLink 机器人账号 ID', type: 'text', required: true }, { key: 'tokenRef', label: 'iLink Token', type: 'secretRef', required: true }, { key: 'baseUrl', label: '官方服务地址', type: 'text', advanced: true }],
  capabilities: { direct: true, group: false, text: true, attachments: false, realtimeVoice: false, qrLogin: true, transport: 'long-poll', notes: '扫码连接 iLink 机器人私聊，也可在此页面安全录入已有 Token。不支持普通微信群；图片、文件、语音附件暂不支持。' },
};
export const weixinConfig = input => { const config = configFor(channelDefinition, input); officialOrigin(config.baseUrl); return config; };
export function normalizeWeixinEvent(message, config) {
  if (message.message_type !== 1 || message.group_id || message.room_id || message.chat_room_id || (message.msg_type === 1 && message.to_user_id && message.to_user_id !== config.accountId)) return null;
  const items = Array.isArray(message.item_list) ? message.item_list : [];
  const text = items.filter(x => x.type === 1).map(x => x.text_item?.text || '').join('\n');
  return eventFor('weixin', config, { messageId: String(message.message_id || ''), actorId: message.from_user_id, chatId: message.from_user_id,
    text: text || '[此消息包含暂不支持的附件，请发送文字说明或使用 BenchGo 工作台]', occurredAt: message.create_time_ms });
}
export function createWeixinAdapter(options) {
  const b = createBoundary(channelDefinition, options), contexts = new Map();
  let generation = 0, cursor = '', task, timer, wake;
  let login, disposed = false;
  const now = options.now || Date.now;
  const clearLogin = () => { if (login) { clearTimeout(login.timer); login.controller.abort(); login = undefined; } };
  const loginRequest = async (session, path) => {
    if (disposed || login !== session || now() >= session.expiresAt) throw fail('扫码会话已失效，请重新开始', 410);
    let response, body;
    try {
      response = await (options.fetcher || fetch)(session.origin + path, { method: 'GET', redirect: 'error', headers: { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '131584' }, signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout(35_000)]) });
      body = await response.json();
    } catch { throw fail('微信扫码请求失败，请重试', 502); }
    if (disposed || login !== session || now() >= session.expiresAt) throw fail('扫码会话已失效，请重新开始', 410);
    if (!response.ok || (body.ret !== undefined && body.ret !== 0) || (body.errcode !== undefined && body.errcode !== 0)) throw fail('微信扫码请求未成功', 502);
    return body;
  };
  const request = async (config, endpoint, payload, timeout = 15_000) => {
    const token = await beforeDelivery(() => b.secret(config.tokenRef));
    const body = await b.request(config, `${officialOrigin(config.baseUrl)}/ilink/bot/${endpoint}`, { method: 'POST',
      headers: { 'content-type': 'application/json', AuthorizationType: 'ilink_bot_token', authorization: `Bearer ${token}`,
        'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'), 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '131584' },
      body: JSON.stringify({ ...payload, base_info: { channel_version: '2.2.0' } }) }, timeout);
    if ((body.ret !== undefined && body.ret !== 0) || (body.errcode !== undefined && body.errcode !== 0)) throw deliveryFailure('微信 iLink 请求失败，请检查登录是否过期', 'not_sent', 502);
    b.state.authentication = 'verified'; return body;
  };
  const poll = async (config, gen) => {
    while (generation === gen) {
      try {
        const body = await request(config, 'getupdates', { get_updates_buf: cursor }, 40_000);
        if (gen !== generation) break;
        if (!Array.isArray(body.msgs)) throw fail('微信轮询回执无效', 502);
        for (const message of body.msgs) {
          const event = normalizeWeixinEvent(message, config);
          if (event && typeof message.context_token === 'string' && message.context_token) {
            contexts.set(event.source.chatId, message.context_token);
            if (contexts.size > 1000) contexts.delete(contexts.keys().next().value);
          }
          await b.receive(config, event);
        }
        if (typeof body.get_updates_buf === 'string') cursor = body.get_updates_buf;
        b.state.connection = { state: 'connected' }; b.state.error = null;
      } catch {
        if (gen !== generation) break;
        b.state.connection = { state: 'reconnecting' }; b.state.error = '微信轮询失败，请检查凭据或网络';
      }
      // Prevent tight loops when the upstream returns immediately; stop wakes this timer.
      await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, b.state.error ? 5000 : (options.pollDelayMs ?? 500)); timer.unref?.(); });
    }
  };
  const stop = async () => { generation++; b.stop(); clearTimeout(timer); wake?.(); await task; task = undefined; };
  return { status: b.status,
    async start() { await stop(); b.reset(); contexts.clear(); cursor = ''; const config = await b.read(); if (!config.enabled) return; b.state.connection = { state: 'connecting' }; task = poll(config, generation); },
    async dispose() { disposed = true; clearLogin(); await stop(); },
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
        if (body.status === 'scaned_but_redirect') { session.origin = officialOrigin(`https://${body.redirect_host}`); return { status: 'scanned' }; }
        if (body.status !== 'confirmed') return { status: body.status === 'scaned' ? 'scanned' : 'wait' };
        if (!validId(body.ilink_bot_id) || typeof body.bot_token !== 'string' || !body.bot_token || body.bot_token.length > 65536) throw fail('微信登录回执缺少账号或凭据', 502);
        const baseUrl = officialOrigin(body.baseurl || session.origin);
        const saved = await saveCredential({ channel: 'weixin', field: 'tokenRef', secret: body.bot_token });
        if (!validId(saved?.ref)) throw fail('微信凭据保存失败', 503);
        if (login !== session || disposed) throw fail('扫码会话已取消', 410);
        clearLogin();
        return { status: 'confirmed', config: { accountId: body.ilink_bot_id, tokenRef: saved.ref, baseUrl, ...(validId(body.ilink_user_id) ? { ownerIds: [body.ilink_user_id] } : {}) } };
      })();
      try { return await session.pending; } finally { session.pending = undefined; }
    },
    async verify() {
      // getupdates is a consuming endpoint: verification starts the actual durable intake loop.
      if (!task) await this.start();
      return b.status();
    },
    async send({ source, text, idempotencyKey }) {
      const config = await b.outgoing(source, text, idempotencyKey), context = contexts.get(source.chatId);
      if (!context) throw deliveryFailure('微信回复上下文不可用，请在微信重新发送一条消息', 'not_sent', 409);
      const clientId = deliveryId(idempotencyKey);
      const body = await request(config, 'sendmessage', { msg: { from_user_id: '', to_user_id: source.chatId, client_id: clientId, message_type: 2, message_state: 2, context_token: context, item_list: [{ type: 1, text_item: { text } }] } });
      if (body.ret !== 0 && body.errcode !== 0) throw deliveryFailure('微信缺少确定发送回执', 'unknown', 502);
      b.state.sending = 'verified'; return { status: 'accepted', messageId: clientId };
    },
  };
}
