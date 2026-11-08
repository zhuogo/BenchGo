import { configFor, createBoundary, createSocketLifecycle, fail, deliveryId, validId } from './china-common.mjs';
import { socialEvent } from './social-common.mjs';
import { beforeDelivery, deliveryFailure } from './delivery-outcome.mjs';

export const channelDefinition = {
  id: 'slack', label: 'Slack',
  defaults: { accountId: '', botTokenRef: '', appTokenRef: '' },
  fields: [
    { key: 'accountId', label: '工作区 ID', required: true, help: '填写 Slack 工作区的原始 Team ID。' },
    { key: 'botTokenRef', label: 'Bot Token 凭据', type: 'secretRef', required: true },
    { key: 'appTokenRef', label: 'App Token 凭据', type: 'secretRef', required: true },
  ],
  capabilities: { text: true, direct: true, groups: true, topics: true, attachments: false, transport: 'websocket', notes: '启用 Socket Mode，App Token 需要 connections:write；Bot 需要 chat:write，并订阅 app_mention、message.im。群聊需 @；接收群内问题回复时还需对应消息事件权限。附件暂不读取。' },
};
export const slackConfig = input => configFor(channelDefinition, input);

/** Slack timestamps and user IDs remain opaque, including their case. */
export function normalizeSlackEvent(payload, bot, config) {
  const e = payload?.event;
  if (payload?.team_id !== config.accountId || !e || !validId(e.channel) || !validId(e.user) || !validId(e.ts)) return null;
  if (e.bot_id || e.app_id || e.user === bot.userId || (e.subtype && e.subtype !== 'file_share')) return null;
  const direct = e.type === 'message' && e.channel_type === 'im';
  if (!direct && e.type !== 'app_mention' && !(e.type === 'message' && ['channel', 'group'].includes(e.channel_type))) return null;
  const original = typeof e.text === 'string' ? e.text : '';
  const mentioned = e.type === 'app_mention' || original.includes(`<@${bot.userId}>`);
  const text = original.split(`<@${bot.userId}>`).join('').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').trim()
    || (e.files?.length ? '[Slack 附件暂不支持读取，请发送文字描述或使用 BenchGo 工作台]' : '');
  const timestamp = Number(e.ts) * 1000;
  if (!Number.isFinite(timestamp)) return null;
  return socialEvent('slack', config.accountId, {
    chatId: e.channel, messageId: `${e.channel}:${e.ts}`, actorId: e.user, text, group: !direct, mentioned,
    topic: e.thread_ts || (!direct ? e.ts : undefined),
    parentMessageId: e.thread_ts && e.thread_ts !== e.ts ? `${e.channel}:${e.thread_ts}` : undefined, timestamp,
  }, config);
}

export function createSlackAdapter(options) {
  const b = createBoundary(channelDefinition, options); let bot;
  async function api(config, method, payload = {}, appToken = false) {
    const token = await beforeDelivery(() => b.secret(config[appToken ? 'appTokenRef' : 'botTokenRef']));
    const body = await b.request(config, `https://slack.com/api/${method}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload),
    });
    if (body.ok !== true) throw deliveryFailure('Slack 接口未接受请求，请检查权限和凭据', body.ok === false ? 'not_sent' : 'unknown', 502);
    return body;
  }
  async function authenticate(config) {
    const result = await api(config, 'auth.test');
    if (!validId(result.user_id) || result.team_id !== config.accountId || !result.bot_id) throw fail('Slack 机器人凭据与工作区不匹配', 403);
    bot = { userId: result.user_id }; b.state.authentication = 'verified';
  }
  const lifecycle = createSocketLifecycle({ boundary: b, WebSocketImpl: options.WebSocketImpl,
    async connect(config) {
      await authenticate(config);
      const result = await api(config, 'apps.connections.open', {}, true), url = new URL(result.url);
      if (url.protocol !== 'wss:' || !(url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'))) throw fail('Slack Socket Mode 地址无效', 502);
      return { url: url.href };
    },
    async onFrame(frame, config, { send, close }) {
      if (frame.type === 'hello') { b.state.connection = { state: 'connected' }; b.state.error = null; return; }
      if (frame.type === 'disconnect') { close(); return; }
      if (!validId(frame.envelope_id)) return;
      if (frame.type === 'events_api') await b.receive(config, normalizeSlackEvent(frame.payload, bot, config));
      // Acknowledge only after durable intake. Failed intake remains replayable.
      await send({ envelope_id: frame.envelope_id });
    },
  });
  return {
    start: lifecycle.start, dispose: lifecycle.dispose, status: b.status,
    async verify() {
      try { await authenticate(await b.read()); b.state.error = null; return b.status(); }
      catch (error) { b.state.authentication = 'failed'; throw error; }
    },
    async send({ source, text, idempotencyKey }) {
      const config = await b.outgoing(source, text, idempotencyKey);
      if (source.topicId !== undefined && !validId(source.topicId)) throw deliveryFailure('Slack 线程标识无效', 'not_sent');
      await beforeDelivery(() => authenticate(config));
      const hash = deliveryId(idempotencyKey), clientMsgId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20)}`;
      const body = await api(config, 'chat.postMessage', { channel: source.chatId, text, mrkdwn: false, link_names: false, unfurl_links: false, unfurl_media: false, client_msg_id: clientMsgId, ...(source.topicId ? { thread_ts: source.topicId } : {}) });
      if (!validId(body.ts) || body.channel !== source.chatId) throw deliveryFailure('Slack 缺少确定发送回执');
      b.state.sending = 'verified'; return { status: 'accepted', messageId: `${body.channel}:${body.ts}` };
    },
  };
}
