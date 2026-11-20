import { configFor, createBoundary, createSocketLifecycle, eventFor, fail, deliveryId, protocolTimestamp, validId } from '../china-common.mjs';
import { beforeDelivery, deliveryFailure, knownNotSent, replyWindowExpired } from '../delivery-outcome.mjs';

const PERSONAL_INTENTS = 1 << 25;
const LEGACY_INTENTS = PERSONAL_INTENTS | (1 << 30) | (1 << 12);
const replyWindowsMs = { users: 60 * 60_000, groups: 5 * 60_000, channels: 5 * 60_000 };
const targets = { C2C_MESSAGE_CREATE: 'users', GROUP_AT_MESSAGE_CREATE: 'groups', AT_MESSAGE_CREATE: 'channels', DIRECT_MESSAGE_CREATE: 'dms' };
const expiredReply = () => replyWindowExpired('QQ 被动回复窗口已关闭，等待你在原会话再次发送消息');
const expiredReplyReason = /(?:msg_id|message id|passive reply|reply window).{0,28}(?:expired|timed out)|(?:消息 ID|被动回复|回复窗口).{0,12}(?:过期|超时)/i;

export const channelDefinition = { setupUrl: 'https://q.qq.com/',
  id: 'qq', label: 'QQ', defaults: { enabled: false, ownerIds: [], chatIds: [], appId: '', appSecretRef: '', eventScope: 'personal' },
  fields: [
    { key: 'appId', label: 'App ID', type: 'text', required: true },
    { key: 'appSecretRef', label: 'App Secret 凭据引用', type: 'secretRef', required: true },
    { key: 'eventScope', label: '事件范围', type: 'select', advanced: true, options: [
      { value: 'personal', label: 'QQ 私聊与群 @' }, { value: 'legacy', label: '同时接收频道消息' },
    ] },
  ],
  capabilities: { externalActions: ['external-send'], direct: true, group: true, text: true, attachments: false, realtimeVoice: false, transport: 'websocket', notes: '使用 QQ 开放平台机器人。私聊与群 @ 需要平台授予对应权限。被动回复窗口关闭后，下一次有效消息会触发补发。' },
};
export const qqConfig = input => configFor(channelDefinition, input);
export function normalizeQqEvent(frame, config, metadataOnly = false) {
  if (!Object.hasOwn(targets, frame.t)) return null;
  const kind = targets[frame.t], personal = kind === 'users' || kind === 'groups';
  if (!personal && config.eventScope !== 'legacy') return null;
  const d = frame.d || {}, group = kind === 'groups' || kind === 'channels';
  const actorId = kind === 'users' ? d.author?.user_openid : kind === 'groups' ? d.author?.member_openid : d.author?.id;
  const chatId = kind === 'groups' ? d.group_openid : kind === 'users' ? actorId : kind === 'dms' ? d.guild_id : d.channel_id;
  if (d.author?.bot === true || ![d.id, actorId, chatId].every(validId)) return null;
  const text = !metadataOnly && typeof d.content === 'string' ? d.content.trim() : '';
  const messageOccurredAt = protocolTimestamp(d.timestamp);
  return eventFor('qq', config, { messageId: d.id, actorId, chatId, metadataOnly,
    text: text || '[此消息包含暂不支持的附件，请发送文字说明或使用 BenchGo 工作台]',
    group, mentioned: group, occurredAt: messageOccurredAt,
    extra: { targetType: kind, ...(messageOccurredAt ? { messageOccurredAt } : {}) } });
}
export function createQqAdapter(options) {
  const b = createBoundary(channelDefinition, options), now = options.now || Date.now;
  let token, sequence = null, sessionId, awaitingHeartbeat, handshakeTimer, resuming;
  const accessToken = async config => {
    const secret = await b.secret(config.appSecretRef), key = config.appId + '\0' + secret;
    if (token?.key === key && token.expiresAt > now()) return token.value;
    const body = await b.request(config, 'https://bots.qq.com/app/getAppAccessToken', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId: config.appId, clientSecret: secret }) });
    const expiresIn = Number(body.expires_in);
    if (typeof body.access_token !== 'string' || !body.access_token || !Number.isFinite(expiresIn) || expiresIn <= 0) throw fail('QQ 认证回执无效', 502);
    token = { key, value: body.access_token, expiresAt: now() + Math.max(1, expiresIn - 60) * 1000 };
    b.state.authentication = 'verified'; return token.value;
  };
  const api = async (config, path, options = {}, source) => {
    const bearer = await beforeDelivery(() => accessToken(config));
    let body;
    try {
      body = await b.request(config, 'https://api.sgroup.qq.com' + path, { ...options, headers: { 'content-type': 'application/json', authorization: `QQBot ${bearer}` } }, 15_000, source ? { operation: 'send', source } : {});
    } catch (error) {
      if (source && knownNotSent(error) && expiredReplyReason.test(error.platformMessage || '')) throw expiredReply();
      throw error;
    }
    if (body.code) {
      if (source && expiredReplyReason.test(body.message || '')) throw expiredReply();
      throw deliveryFailure('QQ 接口未接受请求', 'not_sent', 502);
    }
    return body;
  };
  const resetSession = () => { sessionId = undefined; sequence = null; };
  const lifecycle = createSocketLifecycle({ boundary: b, WebSocketImpl: options.WebSocketImpl, reconnectMs: options.reconnectMs,
    onClose(event) {
      clearTimeout(handshakeTimer);
      if ([4007, 4009].includes(event.code)) resetSession();
      if (event.code === 4004) { token = undefined; resetSession(); b.state.authentication = 'unverified'; }
      if ([4013, 4014, 4914, 4915].includes(event.code)) {
        b.state.error = event.code === 4914 ? 'QQ 机器人尚未上线，请检查沙箱与正式环境设置' : 'QQ 网关拒绝连接，请核对机器人状态与事件订阅权限';
        return false;
      }
    },
    async connect(config) {
      const body = await api(config, '/gateway');
      const url = new URL(body.url);
      if (url.protocol !== 'wss:' || url.username || url.password || !(url.hostname === 'sgroup.qq.com' || url.hostname.endsWith('.sgroup.qq.com'))) throw fail('QQ 网关地址无效', 502);
      awaitingHeartbeat = false; resuming = false;
      return { url: url.href, open() {
        handshakeTimer = setTimeout(() => {
          b.state.error = 'QQ 网关未完成握手';
          lifecycle.disconnect();
        }, options.handshakeTimeoutMs || 20_000);
        handshakeTimer.unref?.();
      } };
    },
    async onFrame(frame, config, { send, pulse, close }) {
      if (frame.op === 10) {
        const bearer = await accessToken(config);
        const intents = config.eventScope === 'legacy' ? LEGACY_INTENTS : PERSONAL_INTENTS;
        resuming = Boolean(sessionId && sequence !== null);
        await send(resuming
          ? { op: 6, d: { token: `QQBot ${bearer}`, session_id: sessionId, seq: sequence } }
          : { op: 2, d: { token: `QQBot ${bearer}`, intents, shard: [0, 1] } });
        const interval = frame.d?.heartbeat_interval;
        pulse(() => {
          if (awaitingHeartbeat) { close(); return; }
          awaitingHeartbeat = true;
          return send({ op: 1, d: sequence });
        }, Number.isFinite(interval) && interval > 0 ? Math.max(1, interval * 0.8) : 30_000);
      } else if (frame.op === 11) awaitingHeartbeat = false;
      else if (frame.op === 1) await send({ op: 1, d: sequence });
      else if (frame.op === 7 || frame.op === 9) { if (frame.op === 9 && frame.d !== true) resetSession(); close(); }
      else if (frame.op === 0) {
        if (frame.t === 'READY' || frame.t === 'RESUMED') {
          clearTimeout(handshakeTimer);
          resuming = false;
          sessionId = frame.d?.session_id || sessionId;
          b.state.connection = { state: 'connected' }; b.state.error = null;
        } else if (resuming || b.state.connection.state === 'connected') {
          await b.receive(config, normalizeQqEvent(frame, config, true), () => normalizeQqEvent(frame, config));
        } else return;
        // Advance only after durable intake so a reconnect can replay a failed event.
        if (Number.isSafeInteger(frame.s) && (sequence === null || frame.s > sequence)) sequence = frame.s;
      }
    },
  });
  return {
    async start() { clearTimeout(handshakeTimer); token = undefined; resetSession(); await lifecycle.start(); },
    async dispose() { clearTimeout(handshakeTimer); await lifecycle.dispose(); },
    status: b.status,
    async verify() {
      if (b.state.connection.state === 'failed') { await this.start(); return b.status(); }
      const config = await b.read();
      try { await api(config, '/gateway'); return b.status(); }
      catch (error) { b.state.authentication = 'failed'; throw error; }
    },
    async send({ source, text, idempotencyKey }) {
      const config = await b.outgoing(source, text, idempotencyKey), kind = source.targetType;
      if (!['users', 'groups', 'channels', 'dms'].includes(kind)) throw deliveryFailure('QQ 交付目标类型无效', 'not_sent', 400);
      const windowMs = replyWindowsMs[kind];
      if (windowMs && now() - Date.parse(source.messageOccurredAt) >= windowMs) throw expiredReply();
      const msgSeq = Number.parseInt(deliveryId(idempotencyKey).slice(0, 7), 16) + 1;
      const body = await api(config, `${['users', 'groups'].includes(kind) ? '/v2' : ''}/${kind}/${encodeURIComponent(source.chatId)}/messages`, { method: 'POST', body: JSON.stringify({ content: text, msg_id: source.messageId, ...(['users', 'groups'].includes(kind) ? { msg_type: 0, msg_seq: msgSeq } : {}) }) }, source);
      if (typeof body.id !== 'string' || !body.id) throw deliveryFailure('QQ 未返回消息回执，送达状态未知', 'unknown', 502);
      b.state.sending = 'verified'; return { status: 'accepted', messageId: body.id };
    },
  };
}
