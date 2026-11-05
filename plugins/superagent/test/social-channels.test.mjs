import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTelegramAdapter, normalizeTelegramEvent } from '../src/channels/telegram.mjs';
import { createDiscordAdapter, normalizeDiscordEvent } from '../src/channels/discord.mjs';
const config = () => ({ enabled: true, botTokenRef: 'ref', ownerIds: ['owner'], chatIds: [] });
test('Telegram scopes group mentions, owners, topics and ignores bots', () => {
  const update = { message: { message_id: 2, from: { id: 'owner' }, chat: { id: -2, type: 'supergroup' }, text: '@bot hello', entities: [{ type: 'mention', offset: 0, length: 4 }], message_thread_id: 3, date: 1700000000 } };
  const event = normalizeTelegramEvent(update, { id: 1, username: 'bot' }, config());
  assert.equal(event.actor.owner, true); assert.equal(event.source.topicId, '3');
  update.message.entities = []; assert.equal(normalizeTelegramEvent(update, { id: 1, username: 'bot' }, config()), null);
});
test('Telegram sends topic and refuses revoked destinations', async () => {
  const c = config(), calls = [];
  const adapter = createTelegramAdapter({ getConfig: () => c, credentials: { resolve: async () => ({ value: 'token' }) }, ingest: async () => {}, fetcher: async (url, options) => { calls.push(JSON.parse(options.body)); return Response.json({ ok: true, result: url.endsWith('getMe') ? { id: 1, is_bot: true } : { message_id: 2 } }); } });
  const source = { channel: 'telegram', accountId: '1', chatId: 'chat', topicId: '8' };
  await adapter.send({ source, text: 'hello' }); assert.equal(calls[1].message_thread_id, 8);
  c.chatIds = ['other']; await assert.rejects(adapter.send({ source, text: 'hello' }), /撤销/); await adapter.dispose();
});
test('Discord filters group mentions and bots', () => {
  const m = { id: 'm', channelId: 'c', guildId: 'g', author: { id: 'owner' }, content: 'hello', createdTimestamp: 1700000000000, mentions: { users: new Set() } };
  assert.equal(normalizeDiscordEvent(m, 'bot', config()), null);
  m.mentions.users.add('bot'); assert.equal(normalizeDiscordEvent(m, 'bot', config()).actor.owner, true);
  m.author.bot = true; assert.equal(normalizeDiscordEvent(m, 'bot', config()), null);
});
test('Discord SDK lifecycle ingests and prevents output mention escalation', async () => {
  const client = new EventEmitter(), c = config(), received = [], sent = [];
  client.login = async () => { client.user = { id: 'bot' }; }; client.isReady = () => !!client.user;
  client.destroy = async () => { client.user = null; }; client.channels = { fetch: async () => ({ isTextBased: () => true, send: async x => { sent.push(x); return { id: 'sent' }; } }) };
  const adapter = createDiscordAdapter({ getConfig: () => c, credentials: { resolve: async () => ({ value: 'secret' }) }, ingest: async event => received.push(event), clientFactory: async () => client });
  await adapter.start(); client.emit('messageCreate', { id: 'm', channelId: 'c', author: { id: 'owner' }, content: 'hello', createdTimestamp: 1700000000000 });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(received.length, 1);
  await adapter.send({ source: received[0].source, text: '@everyone' }); assert.deepEqual(sent[0].allowedMentions.parse, []);
  c.enabled = false; await assert.rejects(adapter.send({ source: received[0].source, text: 'no' }), /撤销/); await adapter.dispose();
});
test('Discord voice commands bypass mention requirement and TTS failure never retries sent text', async () => {
  const client = new EventEmitter(), c = { ...config(), voiceEnabled: true }; let commands = 0, sends = 0;
  client.login = async () => { client.user = { id: 'bot' }; }; client.isReady = () => true; client.destroy = async () => {};
  client.channels = { fetch: async () => ({ isTextBased: () => true, send: async () => { sends++; return { id: 'delivered' }; } }) };
  const voice = { status: () => ({ available: true }), handleMessage: async () => { commands++; return true; }, speak: async () => { throw Error('tts'); }, dispose: async () => {} };
  const adapter = createDiscordAdapter({ getConfig: () => c, credentials: { resolve: async () => ({ value: 'secret' }) }, ingest: async () => { throw Error('command must not ingest'); }, clientFactory: async () => client, voice });
  await adapter.start(); client.emit('messageCreate', { id: 'm', channelId: 'c', guildId: 'g', author: { id: 'owner' }, content: '/join', mentions: { users: new Set() } }); await new Promise(resolve => setImmediate(resolve)); assert.equal(commands, 1);
  const result = await adapter.send({ source: { channel: 'discord', accountId: 'bot', chatId: 'c', voiceChannelId: 'v' }, text: 'hello' }); assert.equal(result.status, 'accepted'); assert.equal(sends, 1); assert.match(adapter.status().error, /文字已送达/); await adapter.dispose();
});
