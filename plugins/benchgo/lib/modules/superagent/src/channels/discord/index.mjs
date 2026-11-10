import { createRequire } from 'node:module';
import { socialConfig, socialEvent, socialFacts, authorizeSocial, sourceAllowed } from '../social-common.mjs';
import { beforeDelivery, deliveryFailure, httpRejected } from '../delivery-outcome.mjs';
const require = createRequire(import.meta.url);
function discordSdk() {
  try { return require('discord.js'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return createRequire(new URL('../../../../../../package.json', import.meta.url))('discord.js');
  }
}
export const channelDefinition = { setupUrl: 'https://discord.com/developers/applications', id: 'discord', label: 'Discord', defaults: { botTokenRef: '', voiceEnabled: false }, capabilities: { externalActions: ['external-send'], direct: true, text: true, groups: true, topics: true, attachments: false, voice: true }, fields: [{ key: 'botTokenRef', label: 'Bot Token 凭据', type: 'secretRef', required: true }, { key: 'voiceEnabled', label: '启用语音频道', type: 'boolean', advanced: true }] };
export function normalizeDiscordEvent(message, botId, config) {
  if (!message.author?.id || !message.channelId || !message.id) return null;
  const text = message.content || '[Discord 附件暂不支持读取，请发送文字描述]';
  return socialEvent('discord', botId, { chatId: message.channelId, messageId: message.id, actorId: message.author.id, actorKind: message.author.bot ? 'machine' : 'human', conversationId: message.channel?.isThread?.() ? message.channel.parentId || message.channelId : message.channelId, text, group: !!message.guildId, mentioned: !!message.mentions?.users?.has(botId), parentMessageId: message.reference?.messageId, topic: message.channel?.isThread?.() ? message.channelId : undefined, timestamp: message.createdTimestamp }, config);
}
export function createDiscordAdapter({ getConfig, credentials, ingest, authorizeConnection, allowUnboundAuthorization = false, clientFactory, voice } = {}) {
  let client, botId, error = null, disposed = false, pending = Promise.resolve(), sending = 'unverified', events = 'unverified';
  const authorize = (operation, source, actor) => authorizeSocial(authorizeConnection, operation, source, actor, allowUnboundAuthorization);
  const read = () => socialConfig(getConfig(), channelDefinition.defaults);
  const status = () => { const c = read(); return { enabled: c.enabled, configured: !!c.botTokenRef, authentication: botId ? 'verified' : 'unverified', events, sending, error, connection: { state: !c.enabled ? 'disabled' : error ? 'error' : client?.isReady?.() ? 'connected' : 'idle' }, voice: voice?.status ? { ...voice.status(), available: !!(c.voiceEnabled && client?.isReady?.() && voice.status().available) } : { available: false, reason: '语音服务尚未连接' } }; };
  async function start() {
    if (client || !read().enabled || disposed) return;
    await authorize('receive', { channel: 'discord', accountId: '', sourceType: 'system', conversationId: '', chatId: '', topicId: '' });
    const config = read(), token = (await credentials.resolve(config.botTokenRef))?.value;
    if (!token || JSON.stringify(config) !== JSON.stringify(read())) throw new Error('Discord 凭据不可用或配置已更改');
    if (clientFactory) client = await clientFactory();
    else {
      const { Client, GatewayIntentBits: I, Partials } = discordSdk();
      client = new Client({ intents: [I.Guilds, I.GuildMessages, I.DirectMessages, I.MessageContent, ...(config.voiceEnabled ? [I.GuildVoiceStates] : [])], partials: [Partials.Channel] });
    }
    client.on('error', () => { error = 'Discord 连接错误'; });
    client.on('messageCreate', message => {
      pending = pending.then(async () => {
        if (disposed || !read().enabled || !botId) return;
        const c = read();
        const facts = socialFacts('discord', botId, { chatId: message.channelId, messageId: message.id, actorId: message.author?.id, actorKind: message.author?.bot ? 'machine' : 'human', group: !!message.guildId, conversationId: message.channel?.isThread?.() ? message.channel.parentId || message.channelId : message.channelId, topic: message.channel?.isThread?.() ? message.channelId : undefined, parentMessageId: message.reference?.messageId });
        if (!facts) return;
        await authorize('receive', facts.source, facts.actor);
        await ingest({ ...facts, normalize: async () => {
          if (!message.author?.bot && c.voiceEnabled && voice?.handleMessage && await voice.handleMessage(message, { client, config: c })) return null;
          return normalizeDiscordEvent(message, botId, c);
        } }); events = 'verified'; error = null;
      }).catch(() => { error = 'Discord 消息接收失败'; });
    });
    try { await client.login(token); botId = client.user?.id; if (!botId) throw new Error(); error = null; }
    catch { await client.destroy(); client = undefined; throw new Error('Discord 登录失败，请检查凭据与 Message Content Intent'); }
  }
  return { start, status, async verify() { await start(); if (!client?.isReady?.()) throw new Error('Discord 尚未连接'); return status(); },
    async action(input) { if (!read().voiceEnabled || !voice?.action) throw new Error('Discord 实时语音不可用'); return voice.action({ ...input, client }); },
    async send({ source, text, idempotencyKey, voiceText = text }) {
      const channel = await beforeDelivery(async () => {
        const c = read(); sourceAllowed(source, 'discord', botId, c); await authorize('send', source);
        if (!client?.isReady?.()) throw new Error('Discord 尚未连接');
        if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('Discord 正文需为 1–2000 字符');
        await authorize('history', source);
        const target = await client.channels.fetch(source.chatId);
        sourceAllowed(source, 'discord', botId, read()); await authorize('send', source);
        if (!target?.isTextBased?.() || typeof target.send !== 'function') throw new Error('Discord 目标不可发送');
        return target;
      });
      let result;
      try { result = await channel.send({ content: text, allowedMentions: { parse: [], repliedUser: false }, ...(idempotencyKey ? { nonce: String(idempotencyKey).slice(-25), enforceNonce: true } : {}) }); }
      catch (failure) { throw deliveryFailure('Discord 发送失败', httpRejected(failure?.status) ? 'not_sent' : 'unknown'); }
      if (!result?.id) throw deliveryFailure('Discord 缺少发送回执');
      sending = 'verified';
      if (source.voiceChannelId && voice?.speak) { try { await voice.speak({ source, text: voiceText }); } catch { error = '文字已送达，但语音播放失败，请检查 Voice 配置'; } }
      return { status: 'accepted', messageId: result.id };
    },
    async dispose() { disposed = true; await voice?.dispose?.(); await client?.destroy(); await pending; client = undefined; },
  };
}



