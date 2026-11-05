import { socialConfig, socialEvent, sourceAllowed } from './social-common.mjs';
import { beforeDelivery, deliveryFailure, httpRejected } from './delivery-outcome.mjs';
export const channelDefinition = { id: 'telegram', label: 'Telegram', defaults: { botTokenRef: '' }, capabilities: { text: true, groups: true, topics: true, attachments: false }, fields: [{ key: 'botTokenRef', label: 'Bot Token 凭据', type: 'secretRef', required: true }] };
export function normalizeTelegramEvent(update, bot, config) {
  const m = update.message;
  if (!m || m.from?.is_bot || !m.from || !m.chat) return null;
  const text = m.text || m.caption || '[Telegram 附件暂不支持读取，请发送文字描述]';
  const mention = (m.entities || m.caption_entities || []).some(e => e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${bot.username}`.toLowerCase()) || String(m.reply_to_message?.from?.id) === String(bot.id);
  return socialEvent('telegram', String(bot.id), { chatId: String(m.chat.id), messageId: `${m.chat.id}:${m.message_id}`, actorId: String(m.from.id), text, group: m.chat.type !== 'private', mentioned: mention, parentMessageId: m.reply_to_message?.message_id ? `${m.chat.id}:${m.reply_to_message.message_id}` : undefined, topic: m.message_thread_id ? String(m.message_thread_id) : undefined, timestamp: m.date * 1000 }, config);
}
export function createTelegramAdapter({ getConfig, credentials, ingest, fetcher = fetch, retryMs = 2000 } = {}) {
  let bot, running = false, loop, offset = 0, error = null, events = 'unverified', sending = 'unverified';
  const stop = new AbortController();
  const read = () => socialConfig(getConfig(), channelDefinition.defaults);
  async function api(method, payload, config = read()) {
    const token = await beforeDelivery(async () => {
      if (!config.enabled || stop.signal.aborted) throw new Error('Telegram 链接未启用');
      const value = (await credentials.resolve(config.botTokenRef))?.value;
      if (!value) throw new Error('Telegram 凭据不可用');
      if (JSON.stringify(config) !== JSON.stringify(read())) throw new Error('Telegram 配置已更改');
      return value;
    });
    let response, body;
    try {
      response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}), signal: AbortSignal.any([stop.signal, AbortSignal.timeout(40_000)]) });
      body = await response.json();
    } catch { throw deliveryFailure('Telegram 请求未取得确定回执'); }
    if (!response.ok || !body?.ok) throw deliveryFailure('Telegram API 拒绝请求', body?.ok === false || httpRejected(response.status) ? 'not_sent' : 'unknown');
    return body.result;
  }
  async function verify() { bot = await api('getMe'); if (!bot?.id || !bot?.is_bot) throw new Error('Telegram 机器人身份无效'); error = null; return status(); }
  function status() { const c = read(); return { enabled: c.enabled, configured: !!c.botTokenRef, authentication: bot ? 'verified' : 'unverified', events, sending, error, connection: { state: !c.enabled ? 'disabled' : error ? 'error' : running ? 'connected' : 'idle' } }; }
  return { status, verify,
    async start() {
      if (running || !read().enabled) return;
      await verify(); running = true;
      loop = (async () => { while (running && !stop.signal.aborted) {
        try {
          const updates = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
          for (const update of updates) {
            if (!running || !read().enabled) break;
            const event = normalizeTelegramEvent(update, bot, read());
            if (event) await ingest(event);
            offset = update.update_id + 1;
          }
          events = 'verified'; error = null;
        } catch { if (stop.signal.aborted) break; error = 'Telegram 接收失败，正在重试'; await new Promise(resolve => { const timer = setTimeout(done, retryMs); function done() { clearTimeout(timer); stop.signal.removeEventListener('abort', done); resolve(); } stop.signal.addEventListener('abort', done, { once: true }); }); }
      } })();
    },
    async send({ source, text }) {
      const c = await beforeDelivery(async () => {
        if (!bot) await verify(); const config = read(); sourceAllowed(source, 'telegram', String(bot.id), config);
        if (typeof text !== 'string' || !text.trim() || text.length > 4096) throw new Error('Telegram 正文需为 1–4096 字符');
        return config;
      });
      const result = await api('sendMessage', { chat_id: source.chatId, text, ...(source.topicId ? { message_thread_id: Number(source.topicId) } : {}) }, c);
      if (!result?.message_id) throw deliveryFailure('Telegram 缺少发送回执'); sending = 'verified'; return { status: 'accepted', messageId: `${source.chatId}:${result.message_id}` };
    },
    async dispose() { running = false; stop.abort(); await loop; },
  };
}
