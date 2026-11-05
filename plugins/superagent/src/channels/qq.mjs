import { configFor, createBoundary, createSocketLifecycle, eventFor, fail, deliveryId } from './china-common.mjs';

export const channelDefinition = {
  id: 'qq', label: 'QQ', defaults: { enabled: false, ownerIds: [], chatIds: [], appId: '', appSecretRef: '' },
  fields: [{ key: 'appId', label: 'App ID', type: 'text', required: true }, { key: 'appSecretRef', label: 'App Secret 凭据引用', type: 'secretRef', required: true }],
  capabilities: { direct: true, group: true, text: true, attachments: false, realtimeVoice: false, transport: 'websocket', notes: 'QQ 官方机器人 API；私聊与群 @ 需平台授予对应权限。附件暂不支持。' },
};
export const qqConfig = input => configFor(channelDefinition, input);
export function normalizeQqEvent(frame, config) {
  if (!['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'AT_MESSAGE_CREATE', 'DIRECT_MESSAGE_CREATE'].includes(frame.t)) return null;
  const d = frame.d || {}, group = ['GROUP_AT_MESSAGE_CREATE', 'AT_MESSAGE_CREATE'].includes(frame.t);
  const kind = frame.t === 'GROUP_AT_MESSAGE_CREATE' ? 'groups' : frame.t === 'C2C_MESSAGE_CREATE' ? 'users' : frame.t === 'DIRECT_MESSAGE_CREATE' ? 'dms' : 'channels';
  const actorId = d.author?.user_openid || d.author?.member_openid || d.author?.id;
  const chatId = kind === 'groups' ? d.group_openid : kind === 'users' ? actorId : kind === 'dms' ? d.guild_id : d.channel_id;
  return eventFor('qq', config, { messageId: d.id, actorId, chatId, text: d.content?.trim() || '[此消息包含暂不支持的附件，请发送文字说明或使用 BenchGo 工作台]', group, mentioned: group, occurredAt: d.timestamp, extra: { targetType: kind } });
}
export function createQqAdapter(options) {
  const b = createBoundary(channelDefinition, options); let token, sequence = null, sessionId;
  const accessToken = async config => {
    const secret = await b.secret(config.appSecretRef), key = config.appId + '\0' + secret;
    if (token?.key === key && token.expiresAt > Date.now()) return token.value;
    const body = await b.request(config, 'https://bots.qq.com/app/getAppAccessToken', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId: config.appId, clientSecret: secret }) });
    if (typeof body.access_token !== 'string' || !Number.isFinite(Number(body.expires_in))) throw fail('QQ 认证回执无效', 502);
    token = { key, value: body.access_token, expiresAt: Date.now() + Math.max(0, Number(body.expires_in) - 60) * 1000 }; b.state.authentication = 'verified'; return token.value;
  };
  const api = async (config, path, options = {}) => {
    const bearer = await accessToken(config);
    const body = await b.request(config, 'https://api.sgroup.qq.com' + path, { ...options, headers: { 'content-type': 'application/json', authorization: `QQBot ${bearer}` } });
    if (body.code) throw fail('QQ 接口未接受请求', 502); return body;
  };
  const lifecycle = createSocketLifecycle({ boundary: b, WebSocketImpl: options.WebSocketImpl,
    async connect(config) {
      const body = await api(config, '/gateway');
      const url = new URL(body.url);
      if (url.protocol !== 'wss:' || !(url.hostname === 'sgroup.qq.com' || url.hostname.endsWith('.sgroup.qq.com'))) throw fail('QQ 网关地址无效', 502);
      return { url: url.href };
    },
    async onFrame(frame, config, { send, pulse, close }) {
      if (frame.op === 10) {
        const bearer = await accessToken(config);
        await send(sessionId ? { op: 6, d: { token: `QQBot ${bearer}`, session_id: sessionId, seq: sequence } } : { op: 2, d: { token: `QQBot ${bearer}`, intents: (1 << 25) | (1 << 30) | (1 << 12), shard: [0, 1] } });
        pulse(() => send({ op: 1, d: sequence }), Math.max(1000, Number(frame.d?.heartbeat_interval || 30_000) * 0.8));
      } else if (frame.op === 7 || frame.op === 9) { if (frame.op === 9 && !frame.d) { sessionId = undefined; sequence = null; } close(); }
      else if (frame.op === 0) {
        if (frame.t === 'READY' || frame.t === 'RESUMED') { sessionId = frame.d?.session_id || sessionId; b.state.connection = { state: 'connected' }; b.state.error = null; }
        else await b.receive(config, normalizeQqEvent(frame, config));
        // Advance only after durable intake so a reconnect can replay a failed event.
        if (Number.isSafeInteger(frame.s)) sequence = frame.s;
      }
    },
  });
  return { async start() { token = undefined; sessionId = undefined; sequence = null; await lifecycle.start(); }, dispose: lifecycle.dispose, status: b.status,
    async verify() { const config = await b.read(); try { await api(config, '/gateway'); return b.status(); } catch (error) { b.state.authentication = 'failed'; throw error; } },
    async send({ source, text, idempotencyKey }) {
      const config = await b.outgoing(source, text, idempotencyKey), kind = source.targetType;
      if (!['users', 'groups', 'channels', 'dms'].includes(kind)) throw fail('QQ 交付目标类型无效');
      const msgSeq = Number.parseInt(deliveryId(idempotencyKey).slice(0, 7), 16) + 1;
      const body = await api(config, `${['users', 'groups'].includes(kind) ? '/v2' : ''}/${kind}/${encodeURIComponent(source.chatId)}/messages`, { method: 'POST', body: JSON.stringify({ content: text, msg_id: source.messageId, ...(['users', 'groups'].includes(kind) ? { msg_type: 0, msg_seq: msgSeq } : {}) }) });
      if (typeof body.id !== 'string') throw Object.assign(fail('QQ 未返回消息回执，送达状态未知', 502), { code: 'DELIVERY_UNCERTAIN', deliveryUncertain: true });
      b.state.sending = 'verified'; return { status: 'accepted', messageId: body.id };
    },
  };
}
