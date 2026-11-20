import { randomUUID } from 'node:crypto';
import { configFor, createBoundary, createSocketLifecycle, eventFor, fail, deliveryId, protocolTimestamp, validId } from '../china-common.mjs';
import { deliveryFailure, replyWindowExpired } from '../delivery-outcome.mjs';

const GROUP_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const expiredGroupReply = () => replyWindowExpired('企业微信群回复窗口已关闭，等待你在原群再次 @ 机器人');
const expiredReplyReason = /(?:reply|respond|req_id|request id).{0,28}(?:expired|timed out)|(?:回复|请求 ID|req_id).{0,12}(?:过期|超时)/i;

export const channelDefinition = { setupUrl: 'https://developer.work.weixin.qq.com/document/path/101463',
  id: 'wecom', label: '企业微信', defaults: { enabled: false, ownerIds: [], chatIds: [], botId: '', secretRef: '' },
  fields: [{ key: 'botId', label: '机器人 ID', type: 'text', required: true }, { key: 'secretRef', label: '机器人 Secret 凭据引用', type: 'secretRef', required: true }],
  capabilities: { externalActions: ['external-send'], direct: true, group: true, text: true, attachments: false, realtimeVoice: false, transport: 'websocket', notes: '智能机器人长连接，支持文字及平台已转写语音。指定群内需 @ 机器人。群回复窗口关闭后，下一次有效 @ 会触发补发。' },
};
export const wecomConfig = input => configFor(channelDefinition, input);
export function normalizeWecomEvent(frame, config, metadataOnly = false) {
  if (frame.cmd !== 'aibot_msg_callback') return null;
  const b = frame.body || {}, group = b.chattype === 'group';
  if (b.aibotid && b.aibotid !== config.botId || b.chattype && !['single', 'group'].includes(b.chattype)) return null;
  const actorId = b.from?.userid, chatId = group ? b.chatid : b.chatid || actorId;
  if (![b.msgid, actorId, chatId].every(validId)) return null;
  const text = metadataOnly ? '' : b.msgtype === 'mixed' && Array.isArray(b.mixed?.msg_item)
    ? b.mixed.msg_item.map(item => item?.text?.content).filter(item => typeof item === 'string').join('\n')
    : b.text?.content || b.voice?.content || '';
  const messageOccurredAt = typeof b.create_time === 'number' ? protocolTimestamp(b.create_time * 1000) : undefined;
  const replyRequestId = validId(frame.headers?.req_id) ? frame.headers.req_id : undefined;
  return eventFor('wecom', config, { messageId: b.msgid, actorId, chatId,
    metadataOnly, text: typeof text === 'string' && text ? text : '[此消息包含暂不支持的附件，请发送文字说明或使用 BenchGo 工作台]', group, occurredAt: messageOccurredAt,
    // The authenticated smart-bot group callback is emitted only for bot mentions.
    mentioned: group, extra: { chatType: group ? 'group' : 'direct', ...(replyRequestId ? { replyRequestId } : {}), ...(messageOccurredAt ? { messageOccurredAt } : {}) } });
}
export function createWecomAdapter(options) {
  const b = createBoundary(channelDefinition, options), acknowledgements = new Map();
  let subscription, heartbeatId, missedPongs, duplicateConnection, authenticationTimer;
  const now = options.now || Date.now;
  const uncertain = message => deliveryFailure(message, 'unknown', 502);
  const rejectPending = () => { for (const wait of acknowledgements.values()) { clearTimeout(wait.timer); wait.reject(uncertain('连接关闭，交付状态未知')); } acknowledgements.clear(); };
  const lifecycle = createSocketLifecycle({ boundary: b, WebSocketImpl: options.WebSocketImpl, reconnectMs: options.reconnectMs,
    onClose() {
      clearTimeout(authenticationTimer);
      rejectPending();
      if (duplicateConnection || b.state.authentication === 'failed') return false;
      b.state.authentication = 'unverified';
    },
    async connect(config) {
      const secret = await b.secret(config.secretRef);
      subscription = randomUUID(); heartbeatId = undefined; missedPongs = 0;
      return { url: 'wss://openws.work.weixin.qq.com', async open(send) {
        await send({ cmd: 'aibot_subscribe', headers: { req_id: subscription }, body: { bot_id: config.botId, secret } });
        authenticationTimer = setTimeout(() => {
          b.state.error = '企业微信未返回订阅回执';
          lifecycle.disconnect();
        }, options.handshakeTimeoutMs || 15000);
        authenticationTimer.unref?.();
      } };
    },
    async onFrame(frame, config, { send, pulse, close }) {
      const requestId = frame.headers?.req_id;
      if (subscription && requestId === subscription && !frame.cmd?.includes('callback')) {
        subscription = undefined;
        clearTimeout(authenticationTimer);
        if (frame.errcode !== 0) {
          b.state.authentication = 'failed';
          b.state.error = '企业微信认证失败，请核对机器人 ID 和 Secret';
          close(); return;
        }
        b.state.authentication = 'verified'; b.state.connection = { state: 'connected' }; b.state.error = null;
        pulse(() => {
          if (missedPongs >= 2) { close(); return; }
          heartbeatId = randomUUID(); missedPongs++;
          return send({ cmd: 'ping', headers: { req_id: heartbeatId } });
        }, options.heartbeatMs || 30_000);
        return;
      }
      if (heartbeatId && requestId === heartbeatId) { if (frame.errcode === 0) missedPongs = 0; return; }
      const waiter = acknowledgements.get(requestId);
      if (waiter && !frame.cmd?.includes('callback')) {
        acknowledgements.delete(requestId); clearTimeout(waiter.timer);
        if (frame.errcode === 0) waiter.resolve();
        else if (waiter.group && Number.isInteger(frame.errcode) && expiredReplyReason.test(frame.errmsg || '')) waiter.reject(expiredGroupReply());
        else waiter.reject(deliveryFailure('企业微信未接受交付', Number.isInteger(frame.errcode) ? 'not_sent' : 'unknown', 502));
        return;
      }
      if (b.state.authentication !== 'verified') return;
      if (frame.cmd === 'aibot_event_callback' && frame.body?.event?.eventtype === 'disconnected_event') {
        duplicateConnection = true;
        b.state.authentication = 'unverified';
        b.state.error = '企业微信机器人已由另一运行实例连接';
        close(); return;
      }
      await b.receive(config, normalizeWecomEvent(frame, config, true), () => normalizeWecomEvent(frame, config));
    },
  });
  return {
    async start() { duplicateConnection = false; clearTimeout(authenticationTimer); rejectPending(); await lifecycle.start(); },
    status: b.status,
    async verify() { if (['stopped', 'failed'].includes(b.state.connection.state)) await this.start(); return b.status(); },
    async dispose() { clearTimeout(authenticationTimer); rejectPending(); await lifecycle.dispose(); },
    async send({ source, text, idempotencyKey }) {
      await b.outgoing(source, text, idempotencyKey);
      const group = source.sourceType === 'group' || source.chatType === 'group';
      if (group && (!validId(source.replyRequestId) || now() - Date.parse(source.messageOccurredAt) >= GROUP_REPLY_WINDOW_MS)) throw expiredGroupReply();
      const reqId = group ? source.replyRequestId : deliveryId(idempotencyKey);
      if (acknowledgements.has(reqId)) throw deliveryFailure('该会话正在交付，请稍后重试', 'not_sent', 409);
      let resolve, reject;
      const receipt = new Promise((yes, no) => { resolve = yes; reject = no; });
      void receipt.catch(() => {});
      const timer = setTimeout(() => { acknowledgements.delete(reqId); reject(uncertain('企业微信交付回执超时，送达状态未知')); }, options.ackTimeoutMs || 15_000);
      acknowledgements.set(reqId, { resolve, reject, timer, group });
      try {
        await lifecycle.send(group
          ? { cmd: 'aibot_respond_msg', headers: { req_id: reqId }, body: { msgtype: 'stream', stream: { id: deliveryId(idempotencyKey), finish: true, content: text } } }
          : { cmd: 'aibot_send_msg', headers: { req_id: reqId }, body: { chatid: source.chatId, chat_type: 1, msgtype: 'markdown', markdown: { content: text } } }, { operation: 'send', source });
      } catch (error) { acknowledgements.delete(reqId); clearTimeout(timer); resolve(); throw error; }
      await receipt; b.state.sending = 'verified'; return { status: 'accepted', messageId: group ? deliveryId(idempotencyKey) : reqId };
    },
  };
}
