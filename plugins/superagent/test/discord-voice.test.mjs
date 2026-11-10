import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createDiscordVoice, discordPcmWav } from '../src/channels/discord-voice.mjs';
function fixture(options = {}) {
  const config = { enabled: true, voiceEnabled: true, ownerIds: ['owner'], chatIds: ['text'] };
  const received = [], resources = [], conn = new EventEmitter(); conn.receiver = { speaking: new EventEmitter(), subscribe: () => Readable.from([Buffer.alloc(3840)]) }; conn.subscribe = () => {}; conn.destroy = () => { conn.destroyed = true; };
  const player = new EventEmitter(); player.stop = () => {}; player.play = resource => resources.push(resource);
  const sdk = { EndBehaviorType: { AfterSilence: 1 }, VoiceConnectionStatus: { Ready: 'ready', Disconnected: 'disconnected' }, StreamType: { Raw: 'raw' }, joinVoiceChannel: () => conn, createAudioPlayer: () => player, entersState: async () => {}, createAudioResource: stream => stream };
  const guild = { members: { fetch: async () => ({ voice: { channelId: 'voice' } }), fetchMe: async () => ({}) }, channels: { fetch: async () => ({ isVoiceBased: () => true, permissionsFor: () => ({ has: () => true }) }) } };
  const client = { user: { id: 'bot' }, guilds: { fetch: async () => guild } };
  const voice = createDiscordVoice({ getConfig: () => config, sdk, opusFactory: () => ({ decode: packet => packet }), authorizeConnection: ({ actor }) => config.ownerIds.includes(actor?.id), ingest: async event => { const normalized = await event.normalize(); if (normalized) received.push(normalized); }, transcribe: async () => new Response('{"type":"partial","text":"hel"}\n{"type":"final","text":"hello"}\n', { headers: { 'content-type': 'application/x-ndjson' } }), synthesize: async () => new Response(Buffer.from([1, 0, 2, 0])), ...options });
  const join = () => voice.action({ operation: 'join', client, guildId: 'guild', channelId: 'voice', chatId: 'text', actorId: 'owner', ownerAuthenticated: true });
  return { config, voice, conn, client, received, resources, join };
}
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
test('PCM converts stereo 48k into valid mono 24k WAV', () => { const pcm = Buffer.alloc(16); pcm.writeInt16LE(100, 0); pcm.writeInt16LE(200, 2); const wav = discordPcmWav(pcm); assert.equal(wav.readUInt32LE(24), 24000); assert.equal(wav.readInt16LE(44), 150); assert.equal(wav.length, 48); });
test('voice rejects untrusted actions and missing services', async () => { const f = fixture(); await assert.rejects(f.voice.action({ operation: 'join', actorId: 'stranger', chatId: 'text' }), /Discord/); const unavailable = fixture({ transcribe: undefined }); assert.equal(unavailable.voice.status().available, false); await assert.rejects(unavailable.join(), /ASR/); await f.voice.dispose(); });

test('missing platform DAVE runtime reports unavailable before loading Discord SDK', async () => {
  const requested = [];
  const f = fixture({ sdk: undefined, loadDependency(name) { requested.push(name); throw new Error('platform runtime missing'); } });
  const status = f.voice.status();
  assert.equal(status.available, false);
  assert.equal(status.connected, false);
  assert.match(status.reason, /DAVE/);
  assert.deepEqual(requested, ['@snazzah/davey']);
  await assert.rejects(f.join(), /DAVE/);
  assert.equal(f.resources.length, 0);
  await f.voice.dispose();
});
test('authorized voice utterance reaches Router with immutable source; bystanders ignored', async () => { const f = fixture(); await f.join(); f.conn.receiver.speaking.emit('start', 'stranger'); await settle(); assert.equal(f.received.length, 0); f.conn.receiver.speaking.emit('start', 'owner'); await settle(); assert.equal(f.received.length, 1); assert.equal(f.received[0].text, 'hello'); assert.equal(f.received[0].actor.owner, undefined); assert.equal(f.received[0].source.voiceChannelId, 'voice'); assert.equal(f.received[0].source.chatId, 'text'); f.config.ownerIds = []; f.conn.receiver.speaking.emit('start', 'owner'); await settle(); assert.equal(f.received.length, 1); await f.voice.dispose(); assert.equal(f.conn.destroyed, true); });
test('delivery plays only matching voice source and converts PCM for Discord', async () => { const f = fixture(); await f.join(); const source = { channel: 'discord', accountId: 'bot', chatId: 'text', voiceChannelId: 'voice' }; assert.equal(await f.voice.speak({ source: { ...source, voiceChannelId: 'other' }, text: 'reply' }), false); assert.equal(await f.voice.speak({ source, text: 'reply' }), true); const chunks = []; for await (const chunk of f.resources[0]) chunks.push(chunk); assert.deepEqual([...Buffer.concat(chunks)], [1,0,1,0,1,0,1,0,2,0,2,0,2,0,2,0]); await f.voice.dispose(); });
test('revoked owner during recognition cannot submit late text', async () => { let finish; const f = fixture({ transcribe: () => new Promise(resolve => { finish = resolve; }) }); await f.join(); f.conn.receiver.speaking.emit('start', 'owner'); await settle(); f.config.enabled = false; finish(Response.json({ text: 'late' })); await settle(); assert.equal(f.received.length, 0); await f.voice.dispose(); });
