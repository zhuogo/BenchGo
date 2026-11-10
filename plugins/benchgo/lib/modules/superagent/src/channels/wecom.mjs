import { randomUUID } from 'node:crypto';
import { configFor, createBoundary, createSocketLifecycle, eventFor, fail, deliveryId } from './china-common.mjs';
import { deliveryFailure } from './delivery-outcome.mjs';

export const channelDefinition = {
  id: 'wecom', label: '企业微信', defaults: { enabled: false, ownerIds: [], chatIds: [], botId: '', secretRef: '' },
  fields: [{ key: 'botId', label: '机器人 ID', type: 'text', required: true }, { key: 'secretRef', label: '机器人 Secret 凭据引用', type: 'secretRef', required: true }],
  capabilities: { externalActions: ['external-send'], direct: true, group: true, text: true, attachments: false, realtimeVoice: false, transport: 'websocket', notes: '智能机器人长连接；支持文字及平台已转写语音，附件暂不支持。群聊需 @ 机器人；回复窗口约六分钟，长任务可在工作台查看结果或重新 @ 查询。' },
};
export const wecomConfig = input => configFor(channelDefinition, input);
export function normalizeWecomEvent(frame, config, metadataOnly = false) {
  if (!['aibot_msg_callback', 'aibot_callback'].includes(frame.cmd)) return null;
  const b = frame.body || {}, group = b.chattype === 'group';
  const text = metadataOnly ? '' : b.msgtype === 'mixed' ? (b.mixed?.msg_item || []).map(x => x.text?.content || '').filter(Boolean).join('\n') : b.text?.content || b.voice?.content || '';
  return eventFor('wecom', config, { messageId: b.msgid, actorId: b.from?.userid, chatId: b.chatid || b.from?.userid,
    metadataOnly, text: text || '[此消息包含暂不支持的附件，请发送文字说明或使用 BenchGo 工作台]', group,
    // The authenticated smart-bot group callback is emitted only for bot mentions.
    mentioned: group, extra: { replyRequestId: frame.headers?.req_id, chatType: group ? 'group' : 'direct' } });
}
export function createWecomAdapter(options) {
  const b = createBoundary(channelDefinition, options), acknowledgements = new Map();
  let subscription;
  const uncertain = message => deliveryFailure(message, 'unknown', 502);
  const rejectPending = () => { for (const wait of acknowledgements.values()) { clearTimeout(wait.timer); wait.reject(uncertain('连接关闭，交付状态未知')); } acknowledgements.clear(); };
  const lifecycle = createSocketLifecycle({ boundary: b, WebSocketImpl: options.WebSocketImpl,
    async connect(config) {
      const secret = await b.secret(config.secretRef); subscription = randomUUID();
      return { url: 'wss://openws.work.weixin.qq.com', async open(send, pulse) {
        await send({ cmd: 'aibot_subscribe', headers: { req_id: subscription }, body: { bot_id: config.botId, secret } });
        pulse(() => send({ cmd: 'ping', headers: { req_id: randomUUID() } }), 30_000);
      } };
    },
    async onFrame(frame, config) {
      const requestId = frame.headers?.req_id;
      if (requestId === subscription) {
        if (frame.errcode !== 0) { b.state.authentication = 'failed'; throw fail('企业微信认证失败', 401); }
        b.state.authentication = 'verified'; b.state.connection = { state: 'connected' }; b.state.error = null; return;
      }
      const waiter = acknowledgements.get(requestId);
      if (waiter && !frame.cmd?.includes('callback')) {
        acknowledgements.delete(requestId); clearTimeout(waiter.timer);
        frame.errcode === 0 ? waiter.resolve() : waiter.reject(deliveryFailure('企业微信未接受交付', Number.isInteger(frame.errcode) ? 'not_sent' : 'unknown', 502)); return;
      }
      if (b.state.authentication !== 'verified') return;
      await b.receive(config, normalizeWecomEvent(frame, config, true), () => normalizeWecomEvent(frame, config));
    },
  });
  return {
    start: lifecycle.start, status: b.status,
    async verify() { if (b.state.authentication !== 'verified') await lifecycle.start(); return b.status(); },
    async dispose() { rejectPending(); await lifecycle.dispose(); },
    async send({ source, text, idempotencyKey }) {
      await b.outgoing(source, text, idempotencyKey);
      const reqId = source.chatType === 'group' ? source.replyRequestId : deliveryId(idempotencyKey);
      if (!reqId) throw deliveryFailure('企业微信群回复上下文已失效，请重新 @ 机器人', 'not_sent', 409);
      if (acknowledgements.has(reqId)) throw deliveryFailure('该会话正在交付，请稍后重试', 'not_sent', 409);
      let resolve, reject;
      const receipt = new Promise((yes, no) => { resolve = yes; reject = no; });
      const timer = setTimeout(() => { acknowledgements.delete(reqId); reject(uncertain('企业微信交付回执超时，送达状态未知')); }, options.ackTimeoutMs || 15_000);
      acknowledgements.set(reqId, { resolve, reject, timer });
      try {
        await lifecycle.send(source.chatType === 'group'
          ? { cmd: 'aibot_respond_msg', headers: { req_id: reqId }, body: { msgtype: 'stream', stream: { id: deliveryId(idempotencyKey), finish: true, content: text } } }
          : { cmd: 'aibot_send_msg', headers: { req_id: reqId }, body: { chatid: source.chatId, msgtype: 'markdown', markdown: { content: text } } }, { operation: 'send', source });
      } catch (error) { acknowledgements.delete(reqId); clearTimeout(timer); resolve(); throw error; }
      await receipt; b.state.sending = 'verified'; return { status: 'accepted', messageId: reqId };
    },
  };
}
