import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTelegramAdapter, normalizeTelegramEvent } from '../src/channels/telegram.mjs';
import { createDiscordAdapter, normalizeDiscordEvent } from '../src/channels/discord.mjs';
const config = () => ({ enabled: true, botTokenRef: 'ref', ownerIds: ['owner'], chatIds: [] });
test('Telegram reports topic and mention facts without owner grants', () => {
  const update = { message: { message_id: 2, from: { id: 'owner' }, chat: { id: -2, type: 'supergroup' }, text: '@bot hello', entities: [{ type: 'mention', offset: 0, length: 4 }], message_thread_id: 3, date: 1700000000 } };
  const event = normalizeTelegramEvent(update, { id: 1, username: 'bot' }, config());
  assert.equal(event.actor.owner, undefined); assert.equal(event.source.topicId, '3');
  update.message.entities = []; assert.equal(normalizeTelegramEvent(update, { id: 1, username: 'bot' }, config()).mentioned, false);
});
test('Telegram parent identifiers share sent receipt namespace and Discord replies survive absent mentions', () => {
  const telegram = normalizeTelegramEvent({ message: { message_id: 3, from: { id: 'owner' }, chat: { id: -2, type: 'supergroup' }, text: 'answer', date: 1700000000, reply_to_message: { message_id: 2, from: { id: 1 } } } }, { id: 1, username: 'bot' }, config());
  assert.equal(telegram.source.parentMessageId, '-2:2');
  const discord = normalizeDiscordEvent({ id: 'reply', channelId: 'chat', guildId: 'guild', author: { id: 'owner' }, content: 'answer', reference: { messageId: 'question' }, createdTimestamp: 1700000000000 }, 'bot', config());
  assert.equal(discord.source.parentMessageId, 'question');
  assert.equal(discord.mentioned, false);
});
test('Telegram sends topic and refuses revoked destinations', async () => {
  const c = config(), calls = [];
  const adapter = createTelegramAdapter({ allowUnboundAuthorization: true, getConfig: () => c, credentials: { resolve: async () => ({ value: 'token' }) }, authorizeConnection: () => !c.chatIds.length, ingest: async () => {}, fetcher: async (url, options) => { calls.push(JSON.parse(options.body)); return Response.json({ ok: true, result: url.endsWith('getMe') ? { id: 1, is_bot: true } : { message_id: 2 } }); } });
  const source = { channel: 'telegram', accountId: '1', chatId: 'chat', topicId: '8' };
  const receipt = await adapter.send({ source, text: 'hello' }); assert.equal(calls[1].message_thread_id, 8); assert.equal(receipt.messageId, 'chat:2');
  c.chatIds = ['other']; await assert.rejects(adapter.send({ source, text: 'hello' }), { deliveryOutcome: 'not_sent' }); await adapter.dispose();
});
test('Discord preserves group and bot identity facts', () => {
  const m = { id: 'm', channelId: 'c', guildId: 'g', author: { id: 'owner' }, content: 'hello', createdTimestamp: 1700000000000, mentions: { users: new Set() } };
  assert.equal(normalizeDiscordEvent(m, 'bot', config()).mentioned, false);
  m.mentions.users.add('bot'); assert.equal(normalizeDiscordEvent(m, 'bot', config()).actor.owner, undefined);
  m.author.bot = true; assert.equal(normalizeDiscordEvent(m, 'bot', config()).actor.kind, 'machine');
});
test('Discord SDK lifecycle ingests and prevents output mention escalation', async () => {
  const client = new EventEmitter(), c = config(), received = [], sent = [];
  let failure;
  client.login = async () => { client.user = { id: 'bot' }; }; client.isReady = () => !!client.user;
  client.destroy = async () => { client.user = null; }; client.channels = { fetch: async () => ({ isTextBased: () => true, send: async x => { sent.push(x); if (failure) throw failure; return { id: 'sent' }; } }) };
  const adapter = createDiscordAdapter({ allowUnboundAuthorization: true, getConfig: () => c, credentials: { resolve: async () => ({ value: 'secret' }) }, ingest: async event => received.push(await event.normalize()), clientFactory: async () => client });
  await adapter.start(); client.emit('messageCreate', { id: 'm', channelId: 'c', author: { id: 'owner' }, content: 'hello', createdTimestamp: 1700000000000 });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(received.length, 1);
  await adapter.send({ source: received[0].source, text: '@everyone' }); assert.deepEqual(sent[0].allowedMentions.parse, []);
  failure = { status: 403 }; await assert.rejects(adapter.send({ source: received[0].source, text: 'rejected' }), { deliveryOutcome: 'not_sent' });
  failure = Error('socket timeout'); await assert.rejects(adapter.send({ source: received[0].source, text: 'unknown' }), { deliveryOutcome: 'unknown' });
  c.enabled = false; await assert.rejects(adapter.send({ source: received[0].source, text: 'no' }), /revoked|撤销/); await adapter.dispose();
});
test('Discord voice commands bypass mention requirement and TTS failure never retries sent text', async () => {
  const client = new EventEmitter(), c = { ...config(), voiceEnabled: true }; let commands = 0, sends = 0;
  client.login = async () => { client.user = { id: 'bot' }; }; client.isReady = () => true; client.destroy = async () => {};
  client.channels = { fetch: async () => ({ isTextBased: () => true, send: async () => { sends++; return { id: 'delivered' }; } }) };
  const voice = { status: () => ({ available: true }), handleMessage: async () => { commands++; return true; }, speak: async () => { throw Error('tts'); }, dispose: async () => {} };
  const adapter = createDiscordAdapter({ allowUnboundAuthorization: true, getConfig: () => c, credentials: { resolve: async () => ({ value: 'secret' }) }, ingest: async event => { assert.equal(await event.normalize(), null); }, clientFactory: async () => client, voice });
  await adapter.start(); client.emit('messageCreate', { id: 'm', channelId: 'c', guildId: 'g', author: { id: 'owner' }, content: '/join', mentions: { users: new Set() } }); await new Promise(resolve => setImmediate(resolve)); assert.equal(commands, 1);
  const result = await adapter.send({ source: { channel: 'discord', accountId: 'bot', chatId: 'c', voiceChannelId: 'v' }, text: 'hello' }); assert.equal(result.status, 'accepted'); assert.equal(sends, 1); assert.match(adapter.status().error, /文字已送达/); await adapter.dispose();
});

test('unbound adapters reject sends by default', async () => {
  const adapter = createTelegramAdapter({ getConfig: config, credentials: { resolve: async () => ({ value: 'token' }) }, fetcher: async () => Response.json({ ok: true, result: { id: 1, is_bot: true } }) });
  await assert.rejects(adapter.send({ source: { channel: 'telegram', accountId: '1', chatId: 'c' }, text: 'hello' })); await adapter.dispose();
});
test('Discord verifies metadata before reading content', async () => {
  const client = new EventEmitter(); let reads = 0, normalized = 0;
  client.login = async () => { client.user = { id: 'bot' }; }; client.destroy = async () => {};
  const adapter = createDiscordAdapter({ getConfig: config, credentials: { resolve: async () => ({ value: 'token' }) }, clientFactory: async () => client, authorizeConnection: () => { assert.equal(reads, 0); return true; }, ingest: async event => { assert.equal(reads, 0); const result = await event.normalize(); assert.deepEqual(result.source, event.source); assert.deepEqual(result.actor, event.actor); normalized++; } });
  await adapter.start(); client.emit('messageCreate', { id: 'm', channelId: 'c', guildId: 'g', author: { id: 'u' }, get content() { reads++; return 'hello'; }, createdTimestamp: 1700000000000 }); await new Promise(resolve => setImmediate(resolve)); assert.equal(normalized, 1); await adapter.dispose();
});

test('Discord rejects unbound startup before login', async () => {
  let logins = 0;
  const adapter = createDiscordAdapter({ getConfig: config, credentials: { resolve: async () => ({ value: 'token' }) }, clientFactory: async () => ({ login: async () => { logins++; } }) });
  await assert.rejects(adapter.start()); assert.equal(logins, 0); await adapter.dispose();
});
