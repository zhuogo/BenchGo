import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { socialEvent, socialFacts, authorizeSocial } from '../social-common.mjs';
const require = createRequire(import.meta.url);
function dependency(name) { try { return require(name); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; return createRequire(new URL('../../../../../../package.json', import.meta.url))(name); } }
const LIMIT = 48000 * 4 * 20;
export function discordPcmWav(pcm) {
  const size = Math.floor(pcm.length / 8) * 2, wav = Buffer.alloc(44 + size);
  wav.write('RIFF'); wav.writeUInt32LE(36 + size, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(size, 40);
  for (let i = 0; i < size / 2; i++) wav.writeInt16LE(Math.round((pcm.readInt16LE(i * 8) + pcm.readInt16LE(i * 8 + 2)) / 2), 44 + i * 2);
  return wav;
}
export function createDiscordVoice({ getConfig, ingest, authorizeConnection, allowUnboundAuthorization = false, transcribe, synthesize, sdk, opusFactory, loadDependency = dependency } = {}) {
  let session, disposed = false, error = null, work = Promise.resolve(), queued = 0;
  const streams = new Set();
  function available() { if (typeof transcribe !== 'function' || typeof synthesize !== 'function') throw Error('请先配置可用的 Voice ASR/TTS 服务'); if (!sdk) { loadDependency('@snazzah/davey'); sdk = loadDependency('@discordjs/voice'); } if (!opusFactory) { const OpusScript = loadDependency('opusscript'); opusFactory = () => new OpusScript(48000, 2, OpusScript.Application.AUDIO); } }
  async function allowed(s, actorId, operation = 'receive') {
    const c = getConfig(); if (disposed || !c.enabled || !c.voiceEnabled) return false;
    try { await authorizeSocial(authorizeConnection, operation, { channel: 'discord', accountId: s.client?.user?.id, sourceType: 'group', conversationId: s.chatId, chatId: s.chatId, topicId: '', guildId: s.guildId, voiceChannelId: s.channelId }, { id: actorId, kind: 'human' }, allowUnboundAuthorization); return true; } catch { return false; }
  }
  async function leave() { const old = session; session = undefined; old?.abort.abort(); for (const stream of streams) stream.destroy(); streams.clear(); old?.player.stop(true); old?.connection.destroy(); }
  async function receive(s, userId) {
    if (session !== s || !await allowed(s, userId) || s.recording.has(userId) || queued >= 3) return;
    s.recording.add(userId);
    const stream = s.connection.receiver.subscribe(userId, { end: { behavior: sdk.EndBehaviorType.AfterSilence, duration: 450 } }); streams.add(stream);
    const timer = setTimeout(() => stream.destroy(), 21000); timer.unref?.(); let codec;
    try {
      codec = opusFactory(); const chunks = []; let size = 0;
      for await (const packet of stream) { const pcm = Buffer.from(codec.decode(packet)); size += pcm.length; if (size > LIMIT) throw Error('语音超过 20 秒，请分段重说'); chunks.push(pcm); }
      if (!size || session !== s || !await allowed(s, userId)) return;
      const wav = discordPcmWav(Buffer.concat(chunks)); queued++;
      work = work.then(async () => {
        if (session !== s || !await allowed(s, userId)) return;
        const message = { chatId: s.chatId, messageId: `voice-${randomUUID()}`, actorId: userId, group: true, mentioned: true, timestamp: Date.now() };
        const facts = socialFacts('discord', s.client.user.id, message);
        Object.assign(facts.source, { guildId: s.guildId, voiceChannelId: s.channelId });
        await ingest({ ...facts, normalize: async () => {
        if (!await allowed(s, userId)) return null;
        const response = await transcribe(new Request('http://localhost/api/voice/transcribe', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav, signal: s.abort.signal }));
        if (!response.ok) { await response.body?.cancel(); throw Error('Discord 语音转写不可用，请检查 Voice ASR 配置'); }
        let text;
        if (response.headers.get('content-type')?.includes('ndjson')) {
          const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '', total = 0, finished = false;
          try { while (!finished) { const next = await reader.read(); if (next.done) break; total += next.value.length; if (total > 1024 * 1024) throw Error('语音事件流超限'); pending += decoder.decode(next.value, { stream: true }); let end; while ((end = pending.indexOf('\n')) >= 0) { const event = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1); if (event.type === 'error') throw Error('Discord 语音转写失败'); if (event.type === 'final') { text = event.text; finished = true; break; } } } } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
        } else ({ text } = await response.json());
        if (!text?.trim() || session !== s || !await allowed(s, userId)) return null;
        const event = socialEvent('discord', s.client.user.id, { ...message, text });
        if (event) Object.assign(event.source, { guildId: s.guildId, voiceChannelId: s.channelId });
        return event;
        } });
      }).catch(e => { if (!s.abort.signal.aborted) error = e.message; }).finally(() => queued--);
    } catch (e) { if (!s.abort.signal.aborted) error = e.message; }
    finally { codec?.delete?.(); clearTimeout(timer); streams.delete(stream); s.recording.delete(userId); }
  }
  async function action({ operation, client, guildId, channelId, actorId, chatId = channelId }) {
    if (!await allowed({ client, chatId, guildId, channelId }, actorId, 'voice-control')) throw Error('Discord voice control authorization required');
    if (operation === 'leave') { await leave(); return status(); }
    if (operation !== 'join') throw Error('不支持的 Discord 语音操作');
    try { available(); } catch { error = 'Discord 语音需要 Voice ASR/TTS、Discord Voice SDK、Opus 与当前平台 DAVE 运行库'; throw Error(error); }
    const readSource = { client, chatId, guildId, channelId };
    if (!await allowed(readSource, actorId, 'history')) throw Error('Discord history authorization required');
    const guild = await client.guilds.fetch(guildId);
    if (!await allowed(readSource, actorId, 'history')) throw Error('Discord history authorization required');
    const member = await guild.members.fetch(actorId);
    if (member.voice?.channelId !== channelId) throw Error('只能加入操作人当前所在的语音频道');
    if (!await allowed(readSource, actorId, 'history')) throw Error('Discord history authorization required');
    const channel = await guild.channels.fetch(channelId);
    if (!channel?.isVoiceBased?.() || channel.type === 13) throw Error('仅支持普通 Discord 语音频道');
    if (!await allowed(readSource, actorId, 'history')) throw Error('Discord history authorization required');
    const me = await guild.members.fetchMe(), permissions = channel.permissionsFor(me);
    if (!permissions?.has(['ViewChannel', 'Connect', 'Speak'])) throw Error('机器人缺少查看、连接或讲话权限');
    if (!await allowed({ client, chatId, guildId, channelId }, actorId, 'voice-control')) throw Error('Discord 语音权限已撤销');
    await leave();
    const connection = sdk.joinVoiceChannel({ guildId, channelId, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
    const s = session = { connection, client, guildId, channelId, chatId, actorId, recording: new Set(), abort: new AbortController(), player: sdk.createAudioPlayer() };
    connection.on('error', () => { error = 'Discord 语音连接失败'; if (session === s) void leave(); });
    connection.on('stateChange', (_, next) => { if (next.status === sdk.VoiceConnectionStatus.Disconnected && session === s) { error = 'Discord 语音已断开，请重新加入'; void leave(); } });
    try { await sdk.entersState(connection, sdk.VoiceConnectionStatus.Ready, 15000); if (session !== s || !await allowed(s, actorId, 'voice-control')) throw Error('语音加入已取消'); connection.subscribe(s.player); s.player.on('error', () => { error = 'Discord 语音播放失败'; }); connection.receiver.speaking.on('start', userId => { void receive(s, userId).catch(() => { error = 'Voice receive rejected'; }); }); error = null; return status(); }
    catch (e) { if (session === s) await leave(); throw e; }
  }
  function status() { let reason; try { available(); } catch { reason = '需要 Voice ASR/TTS、Discord Voice SDK、Opus 与当前平台 DAVE 运行库'; } return { available: !reason && !!getConfig().voiceEnabled, connected: !!session, reason, error }; }
  return { action, status,
    async handleMessage(message, { client }) { const command = message.content?.trim(); if (!['/join', '/leave'].includes(command)) return false; if (!message.guildId) return false; try { await action({ operation: command.slice(1), client, guildId: message.guildId, channelId: message.member?.voice?.channelId, chatId: message.channelId, actorId: message.author.id }); if (!await allowed({ client, chatId: message.channelId, guildId: message.guildId, channelId: message.member?.voice?.channelId }, message.author.id, 'send')) return true; await message.reply({ content: command === '/join' ? '已加入语音频道；接收已授权连接的语音，每段最多 20 秒。' : '已离开语音频道。', allowedMentions: { parse: [], repliedUser: false } }); } catch (e) { if (!await allowed({ client, chatId: message.channelId, guildId: message.guildId, channelId: message.member?.voice?.channelId }, message.author.id, 'send')) return true; await message.reply({ content: e.message, allowedMentions: { parse: [], repliedUser: false } }); } return true; },
    async speak({ source, text }) {
      const s = session;
      if (!s || source?.channel !== 'discord' || source.accountId !== s.client.user.id || source.chatId !== s.chatId || source.voiceChannelId !== s.channelId || !await allowed(s, s.actorId, 'send')) return false;
      const response = await synthesize(new Request('http://localhost/api/voice/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: s.abort.signal }));
      if (!response.ok || !response.body) { await response.body?.cancel(); throw Error('Discord 语音合成不可用'); }
      if (session !== s || !await allowed(s, s.actorId, 'send')) { await response.body.cancel(); return false; }
      async function* pcm() { let remainder = Buffer.alloc(0); for await (const chunk of response.body) { if (session !== s || !await allowed(s, s.actorId, 'send')) return; const bytes = Buffer.concat([remainder, Buffer.from(chunk)]), size = bytes.length - bytes.length % 2, output = Buffer.alloc(size * 4); for (let i = 0; i < size; i += 2) { const value = bytes.readInt16LE(i); for (let j = 0; j < 4; j++) output.writeInt16LE(value, i * 4 + j * 2); } remainder = bytes.subarray(size); yield output; } }
      const stream = Readable.from(pcm()); streams.add(stream); stream.once('close', () => streams.delete(stream));
      s.player.play(sdk.createAudioResource(stream, { inputType: sdk.StreamType.Raw })); return true;
    },
    async dispose() { disposed = true; await leave(); await work; },
  };
}


