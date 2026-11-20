import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { socialConfig, socialFacts, authorizeSocial, sourceAllowed } from '../social-common.mjs';
import { beforeDelivery, deliveryFailure, httpRejected } from '../delivery-outcome.mjs';

export const channelDefinition = {
  setupUrl: 'https://t.me/BotFather', id: 'telegram', label: 'Telegram', defaults: { botTokenRef: '' },
  capabilities: { externalActions: ['external-send'], direct: true, text: true, groups: true, topics: true, attachments: false, transport: 'long-poll' },
  fields: [{ key: 'botTokenRef', label: 'Bot Token 凭据', type: 'secretRef', required: true }],
};

const id = value => typeof value === 'string' ? value.trim().length > 0 : Number.isSafeInteger(value) && value !== 0;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const chatTypes = new Set(['private', 'group', 'supergroup']);
const idleResetMs = 6 * 24 * 60 * 60 * 1000;

function telegramFacts(m, bot) {
  if (!m || !chatTypes.has(m.chat?.type) || !id(m.chat.id) || !id(m.from?.id) || !positiveInteger(m.message_id) || m.sender_chat
    || !positiveInteger(m.date) || m.date > 8_640_000_000_000) return null;
  const topic = m.chat.type === 'supergroup' && positiveInteger(m.message_thread_id) ? String(m.message_thread_id) : undefined;
  return socialFacts('telegram', String(bot.id), {
    chatId: String(m.chat.id), messageId: `${m.chat.id}:${m.message_id}`, actorId: String(m.from.id), actorKind: m.from.is_bot ? 'machine' : 'human',
    group: m.chat.type !== 'private', topic, parentMessageId: positiveInteger(m.reply_to_message?.message_id)
      ? `${m.chat.id}:${m.reply_to_message.message_id}` : undefined,
  });
}

export function normalizeTelegramEvent(update, bot) {
  const m = update?.message, facts = telegramFacts(m, bot);
  if (!facts) return null;
  const [body, entities] = typeof m.text === 'string' ? [m.text, m.entities] : [m.caption, m.caption_entities];
  const text = typeof body === 'string' && body.trim() ? body : '[Telegram 附件暂不支持读取，请发送文字描述]';
  const mentioned = typeof bot.username === 'string' && Array.isArray(entities) && entities.some(entity => entity?.type === 'mention'
    && Number.isSafeInteger(entity.offset) && entity.offset >= 0 && positiveInteger(entity.length)
    && text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${bot.username.toLowerCase()}`);
  return { ...facts, text, mentioned, occurredAt: new Date(m.date * 1000).toISOString(), raw: {} };
}

function apiError(body, status) {
  const code = Number.isInteger(body?.error_code) ? body.error_code : status;
  const description = typeof body?.description === 'string' ? body.description : '';
  let reason = 'Telegram API 拒绝请求';
  if (code === 401 || code === 404) reason = 'Telegram Bot Token 无效，请在 BotFather 核对后更新';
  else if (code === 409) reason = /webhook/i.test(description)
    ? 'Telegram 已配置 Webhook，请在原集成解除后再使用长轮询'
    : 'Telegram 长轮询冲突，请停止使用同一 Token 的其他实例';
  else if (code === 429) reason = 'Telegram 请求限流，稍后重试';
  else if (code >= 500) reason = 'Telegram 服务暂不可用，稍后重试';
  const rejected = (body?.ok === false && code < 500 && code !== 408) || httpRejected(status);
  const error = deliveryFailure(reason, rejected ? 'not_sent' : 'unknown', code);
  if (code === 429 && positiveInteger(body?.parameters?.retry_after)) error.retryAfter = Math.min(300000, body.parameters.retry_after * 1000);
  return error;
}

export function createTelegramAdapter({ getConfig, credentials, ingest, authorizeConnection, allowUnboundAuthorization = false,
  fetcher = fetch, runtimeState, assertCurrent, isSourceAllowed, observeSource, retryMs = 2000, now = Date.now } = {}) {
  let bot, botCredential, starting, verification, loop, authentication = 'unverified', state = 'idle', events = 'unverified', sending = 'unverified', error = null;
  const stop = new AbortController();
  const authorize = (operation, source, actor) => authorizeSocial(authorizeConnection, operation, source, actor, allowUnboundAuthorization);
  const read = () => socialConfig(getConfig(), channelDefinition.defaults);
  const systemSource = () => ({ channel: 'telegram', accountId: bot ? String(bot.id) : '', sourceType: 'system', conversationId: '', chatId: '', topicId: '' });
  const active = config => {
    stop.signal.throwIfAborted();
    assertCurrent?.();
    if (!config.enabled || JSON.stringify(config) !== JSON.stringify(read())) throw new Error('Telegram 链接已停用或配置已更改');
  };

  async function api(method, payload, config = read(), source = systemSource()) {
    const { token, credentialIdentity } = await beforeDelivery(async () => {
      active(config);
      let token;
      try { token = (await credentials.resolve(config.botTokenRef))?.value; } catch { /* Present the same credential error for unreadable values. */ }
      if (typeof token !== 'string' || !/^[\w:-]+$/.test(token)) throw Object.assign(new Error('Telegram 凭据不可用，请重新录入 Bot Token'), { status: 401 });
      const credentialIdentity = createHash('sha256').update(JSON.stringify([config.botTokenRef, token])).digest('hex');
      if (method !== 'getMe' && botCredential !== credentialIdentity)
        throw Object.assign(new Error('Telegram 凭据已变更，请重新验证连接'), { status: 401 });
      active(config);
      await authorize(method === 'sendMessage' ? 'send' : 'receive', source);
      active(config);
      return { token, credentialIdentity };
    });
    let response, body;
    try {
      response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}), signal: AbortSignal.any([stop.signal, AbortSignal.timeout(40000)]),
      });
      body = await response.json();
    } catch {
      if (response && !response.ok) throw apiError(undefined, response.status);
      throw deliveryFailure('Telegram 网络请求未取得有效回执，请检查当前宿主能否访问 Bot API');
    }
    if (!response.ok || body?.ok !== true) throw apiError(body, response.status);
    return { result: body.result, credentialIdentity };
  }

  function status() {
    const c = read();
    return { enabled: c.enabled, configured: !!c.botTokenRef, authentication, events, sending, error,
      connection: { state: !c.enabled ? 'disabled' : state } };
  }

  function verifyIdentity(config) {
    verification ||= (async () => {
      const { result, credentialIdentity } = await api('getMe', {}, config);
      active(config);
      if (!positiveInteger(result?.id) || result.is_bot !== true) throw deliveryFailure('Telegram 机器人身份无效', 'not_sent', 401);
      if (bot && bot.id !== result.id) throw deliveryFailure('Telegram 机器人身份已变更，请重新配置连接', 'not_sent', 401);
      bot = result;
      if (botCredential && botCredential !== credentialIdentity && loop)
        throw deliveryFailure('Telegram 凭据已变更，等待原接收连接停止后重新验证', 'not_sent', 401);
      botCredential = credentialIdentity;
      authentication = 'verified';
      return credentialIdentity;
    })().finally(() => { verification = undefined; });
    return verification;
  }

  function report(failure) {
    if ([401, 404].includes(failure.status)) authentication = 'failed';
    state = [401, 404, 409].includes(failure.status) ? 'failed' : 'reconnecting';
    error = failure.message;
  }

  async function wait(ms) {
    try { await delay(ms, undefined, { signal: stop.signal, ref: false }); }
    catch (failure) { if (!stop.signal.aborted) throw failure; }
  }

  async function poll(config, firstIdentity) {
    let checkpoint, offset = 0, receivedAt = 0, restored = false, failures = 0;
    while (!stop.signal.aborted) {
      try {
        active(config);
        if (!restored) {
          const credentialIdentity = firstIdentity || await verifyIdentity(config);
          firstIdentity = undefined;
          checkpoint = runtimeState?.({ accountId: String(bot.id), credentialIdentity });
          const saved = await checkpoint?.read();
          active(config);
          if (Number.isSafeInteger(saved?.offset) && saved.offset >= 0 && positiveInteger(saved?.receivedAt)) {
            offset = saved.offset;
            receivedAt = saved.receivedAt;
          }
          restored = true;
        }
        // Telegram can randomize update IDs after a week without new updates.
        if (offset && now() - receivedAt >= idleResetMs) offset = 0;
        const previousOffset = offset;
        const { result: updates } = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, config);
        active(config);
        if (!Array.isArray(updates)) throw new Error('Telegram 轮询回执无效');
        for (const update of updates) {
          active(config);
          if (!Number.isSafeInteger(update?.update_id) || update.update_id < offset || update.update_id < 0 || update.update_id === Number.MAX_SAFE_INTEGER) continue;
          const facts = telegramFacts(update.message, bot);
          if (facts) {
            const allowed = isSourceAllowed ? isSourceAllowed(facts.source, facts.actor)
              : !config.chatIds.length || config.chatIds.includes(facts.source.chatId);
            if (allowed) {
              await authorize('receive', facts.source, facts.actor);
              active(config);
              const outcome = await ingest({ ...facts, normalize: () => normalizeTelegramEvent(update, bot) });
              if (!outcome?.ignored) events = 'verified';
            } else {
              observeSource?.(facts.source, facts.actor);
            }
          }
          const next = update.update_id + 1, at = now();
          active(config);
          await checkpoint?.write({ offset: next, receivedAt: at });
          offset = next;
          receivedAt = at;
        }
        active(config);
        state = 'connected'; error = null; failures = 0;
        if (offset === previousOffset) await wait(100);
      } catch (failure) {
        if (stop.signal.aborted) return;
        try { active(config); } catch { return; }
        report(failure);
        if ([401, 404].includes(failure.status)) return;
        failures++;
        await wait(failure.retryAfter || Math.min(30000, retryMs * 2 ** Math.min(failures - 1, 5)));
      }
    }
  }

  async function start() {
    if (loop || starting || !read().enabled || stop.signal.aborted) return starting;
    const config = read();
    state = 'connecting';
    starting = (async () => {
      let credentialIdentity;
      try { credentialIdentity = await verifyIdentity(config); }
      catch (failure) {
        if (stop.signal.aborted) return;
        report(failure);
        if ([401, 404].includes(failure.status)) return;
      }
      loop = poll(config, credentialIdentity).finally(() => { loop = undefined; });
    })().finally(() => { starting = undefined; });
    return starting;
  }

  return { status, start,
    async verify() {
      if (!loop) await start();
      else {
        try { await verifyIdentity(read()); }
        catch (failure) { if (!stop.signal.aborted) report(failure); }
      }
      return status();
    },
    async send({ source, text }) {
      const config = await beforeDelivery(async () => {
        const current = read();
        if (!bot) await verifyIdentity(current);
        sourceAllowed(source, 'telegram', String(bot.id), current);
        if (typeof text !== 'string' || !text.trim() || text.length > 4096) throw new Error('Telegram 正文需为 1–4096 字符');
        if (source.topicId && (!/^[1-9][0-9]*$/.test(source.topicId) || !positiveInteger(Number(source.topicId)))) throw new Error('Telegram 话题标识无效');
        return current;
      });
      const { result } = await api('sendMessage', { chat_id: source.chatId, text,
        ...(source.topicId ? { message_thread_id: Number(source.topicId) } : {}) }, config, source);
      if (!positiveInteger(result?.message_id)) throw deliveryFailure('Telegram 缺少发送回执');
      sending = 'verified';
      return { status: 'accepted', messageId: `${source.chatId}:${result.message_id}` };
    },
    async dispose() { stop.abort(); await starting; await loop; },
  };
}
