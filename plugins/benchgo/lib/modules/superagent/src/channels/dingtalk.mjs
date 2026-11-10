import { configFor, createBoundary, createSocketLifecycle, eventFor, fail, validId } from './china-common.mjs';
import { beforeDelivery, deliveryFailure } from './delivery-outcome.mjs';

export const channelDefinition = {
  id: 'dingtalk', label: '钉钉', defaults: { appId: '', appSecretRef: '', robotCode: '' },
  fields: [
    { key: 'appId', label: 'Client ID / AppKey', required: true },
    { key: 'appSecretRef', label: 'Client Secret 凭据', type: 'secretRef', required: true },
    { key: 'robotCode', label: 'Robot Code', required: true },
  ],
  capabilities: { externalActions: ['external-send'], text: true, direct: true, groups: true, attachments: false, transport: 'websocket', notes: '企业内部应用机器人使用 Stream 模式，无需公网回调。开启机器人接收消息及发送消息权限，群聊需 @；允许使用的人员填写 senderStaffId。附件暂不读取。' },
};
export const dingtalkConfig = input => configFor(channelDefinition, input);

export function normalizeDingtalkEvent(message, config, metadataOnly = false) {
  if (!['1', '2'].includes(message?.conversationType) || message.robotCode !== config.robotCode || !validId(message.senderStaffId)) return null;
  const group = message.conversationType === '2';
  const text = metadataOnly ? '' : message.msgtype === 'text' ? message.text?.content?.trim() : '[钉钉附件暂不支持读取，请发送文字描述或使用 BenchGo 工作台]';
  if (!metadataOnly && !text) return null;
  return eventFor('dingtalk', config, { messageId: message.msgId, actorId: message.senderStaffId, chatId: message.conversationId, text, metadataOnly,
    group, mentioned: message.isInAtList === true, occurredAt: message.createAt,
    extra: { targetType: group ? 'group' : 'direct', recipientId: message.senderStaffId },
  });
}

/** Official Stream transport; intake, authorization and delivery remain owned by SuperAgent. */
export function createDingtalkAdapter(options) {
  const b = createBoundary(channelDefinition, options);
  let token;
  async function accessToken(config) {
    const secret = await b.secret(config.appSecretRef), key = config.appId + '\0' + secret;
    await b.current(config);
    if (token?.key === key && token.expiresAt > Date.now()) return token.value;
    const body = await b.request(config, 'https://api.dingtalk.com/v1.0/oauth2/accessToken', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appKey: config.appId, appSecret: secret }) });
    if (!validId(body.accessToken) || !Number.isFinite(Number(body.expireIn)) || Number(body.expireIn) <= 0) throw fail('钉钉认证回执无效', 502);
    token = { key, value: body.accessToken, expiresAt: Date.now() + Math.max(0, Number(body.expireIn) - 60) * 1000 };
    b.state.authentication = 'verified'; return token.value;
  }
  const lifecycle = createSocketLifecycle({ boundary: b, WebSocketImpl: options.WebSocketImpl,
    async connect(config) {
      const secret = await b.secret(config.appSecretRef);
      const body = await b.request(config, 'https://api.dingtalk.com/v1.0/gateway/connections/open', {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ clientId: config.appId, clientSecret: secret, ua: 'BenchGo', subscriptions: [{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }] }),
      });
      const url = new URL(body.endpoint);
      if (url.protocol !== 'wss:' || !(url.hostname === 'dingtalk.com' || url.hostname.endsWith('.dingtalk.com')) || !validId(body.ticket)) throw fail('钉钉 Stream 地址无效', 502);
      url.searchParams.set('ticket', body.ticket);
      return { url: url.href };
    },
    async onFrame(frame, config, { send, close }) {
      if (frame.type === 'SYSTEM') {
        if (['CONNECTED', 'REGISTERED'].includes(frame.headers?.topic)) { b.state.authentication = 'verified'; b.state.connection = { state: 'connected' }; b.state.error = null; }
        if (frame.headers?.topic === 'ping') await send({ code: 200, headers: frame.headers, message: 'OK', data: frame.data });
        if (frame.headers?.topic === 'disconnect') close();
        return;
      }
      if (frame.type !== 'CALLBACK' || frame.headers?.topic !== '/v1.0/im/bot/messages/get') return;
      if (typeof frame.data !== 'string' || !validId(frame.headers?.messageId)) throw fail('钉钉消息格式无效');
      const message = JSON.parse(frame.data);
      await b.receive(config, normalizeDingtalkEvent(message, config, true), () => normalizeDingtalkEvent(message, config));
      // Stream messageId is an ACK token; business msgId is the durable dedupe key.
      await send({ code: 200, headers: { contentType: 'application/json', messageId: frame.headers.messageId }, message: 'OK', data: JSON.stringify({ response: { success: true } }) });
    },
  });
  return {
    async start() { token = undefined; await lifecycle.start(); },
    async dispose() { token = undefined; await lifecycle.dispose(); },
    status: b.status,
    async verify() {
      try { token = undefined; await accessToken(await b.read()); b.state.error = null; return b.status(); }
      catch (error) { b.state.authentication = 'failed'; throw error; }
    },
    async send({ source, text, idempotencyKey }) {
      const config = await b.outgoing(source, text, idempotencyKey);
      if (!['group', 'direct'].includes(source.targetType) || (source.targetType === 'direct' && !validId(source.recipientId))) throw deliveryFailure('钉钉交付目标无效', 'not_sent');
      const bearer = await beforeDelivery(() => accessToken(config));
      const group = source.targetType === 'group';
      const body = await b.request(config, `https://api.dingtalk.com/v1.0/robot/${group ? 'groupMessages/send' : 'oToMessages/batchSend'}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': bearer },
        body: JSON.stringify({ robotCode: config.robotCode, msgKey: 'sampleText', msgParam: JSON.stringify({ content: text }), ...(group ? { openConversationId: source.chatId } : { userIds: [source.recipientId] }) }),
      }, 15_000, { operation: 'send', source });
      if ((body.code && body.code !== 'OK' && body.code !== '0') || (body.errcode !== undefined && body.errcode !== 0)) throw deliveryFailure('钉钉接口拒绝发送', 'not_sent');
      if (!validId(body.processQueryKey)) throw deliveryFailure('钉钉缺少确定发送回执');
      b.state.sending = 'verified'; return { status: 'accepted', messageId: body.processQueryKey };
    },
  };
}
