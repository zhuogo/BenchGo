import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { VoiceError } from './config.mjs';
import { executeAsr, requestSpeech } from './protocols/registry.mjs';
import { protocolDescriptor, protocolOptions } from '../shared/protocol-catalog.mjs';
import { validateWav } from './media.mjs';
import { setTimeout as delay } from 'node:timers/promises';

// Windows System.Speech, PCM16 mono 16kHz: “Hello. This is a voice connection test.”
// A fixed synthetic phrase never uploads the user's microphone recording during discovery.
const probeAudio = () => readFile(new URL('./protocols/shared/protocol-probe.wav', import.meta.url));
const ATTEMPT_TIMEOUT = 8000;
const PLAYABLE_PCM_BYTES = 3840; // The common player's minimum 80 ms, 24 kHz PCM16 mono reserve.
const PCM_BYTES_PER_MS = 48;
const PROBE_TEXT = 'Hello. This is a voice connection test. Speech should continue smoothly from the first sentence to the next.';
const apiType = config => config.apiType === 'stepfun' || config.apiType !== 'openai' && new URL(config.baseURL).hostname === 'api.stepfun.com' ? 'stepfun' : 'openai';
const keyFor = (kind, config, requirement, explicit) => {
  const realtime = config.realtime || {};
  // Concurrent button requests share only an identical private route and purpose.
  const routing = [kind, config.baseURL, config.providerId || '', config.apiKey || '', config.model, config.apiType || '', config.protocol || '', config.speed,
    kind === 'tts' ? config.voice || '' : '', kind === 'tts' ? config.stream !== false : true,
    kind === 'asr' ? [realtime.url || '', Object.entries(realtime.query || {}).sort(([left], [right]) => left.localeCompare(right))] : null, requirement, explicit];
  return createHash('sha256').update(JSON.stringify(routing)).digest('hex');
};
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

export function protocolCandidates(kind, config, requirement = 'any', explicit = false) {
  if (explicit) return config.protocol && config.protocol !== 'auto' ? [config.protocol] : [];
  const selectedType = config.apiType && config.apiType !== 'auto' ? config.apiType : apiType(config);
  return protocolOptions(kind, selectedType).filter(item => item.id && item.id !== 'auto'
    && (requirement !== 'streaming' || item.streaming)
    && (requirement !== 'http' || item.transport !== 'websocket')).sort((left, right) => capabilityRank(kind, left) - capabilityRank(kind, right)
      || Number(right.apiType === selectedType) - Number(left.apiType === selectedType)).map(item => item.id);
}

function capabilityRank(kind, descriptor) {
  if (kind === 'asr') return descriptor.transport === 'websocket' ? 0 : descriptor.transport === 'sse' ? 1 : 2;
  // Sentence requests finish their text before synthesis. Incremental text
  // input is therefore no playback advantage over another streaming output.
  return descriptor.outputStreaming || descriptor.streaming ? 0 : 1;
}

function playbackRisk(attempt) {
  if (!Number.isFinite(attempt.observedPlaybackGapMs)) return Infinity;
  // Ignore sub-frame jitter; compare nearby continuity samples by start time.
  // A packet gap alone is not an underrun: preceding PCM may cover it fully.
  const gaps = Math.ceil(Math.max(0, attempt.observedPlaybackGapMs - 40) / 80);
  return gaps + (attempt.audioSupplyRatio !== null && attempt.audioSupplyRatio < 0.95 ? 1 : 0);
}

/** Exercise the existing websocket adapter through an actual synthetic utterance. */
export async function probeRealtimeAsr(runtime, config, wav, signal, onOutput = () => {}) {
  const { rate } = validateWav(wav), buffer = Buffer.from(wav); let pcm;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32LE(offset + 4), start = offset + 8;
    if (buffer.toString('ascii', offset, offset + 4) === 'data') { pcm = buffer.subarray(start, start + length); break; }
    offset = start + length + length % 2;
  }
  const samples = pcm.length / 2, output = Buffer.alloc(Math.floor(samples * 24000 / rate) * 2);
  for (let index = 0; index < output.length / 2; index++) {
    const position = index * rate / 24000, low = Math.min(Math.floor(position), samples - 1), high = Math.min(low + 1, samples - 1), mix = position - low;
    output.writeInt16LE(Math.round(pcm.readInt16LE(low * 2) * (1 - mix) + pcm.readInt16LE(high * 2) * mix), index * 2);
  }
  const id = await runtime.open(config, signal, 'protocol-test'); let reader;
  try {
    reader = runtime.events(id, 'protocol-test').getReader();
    for (let offset = 0; offset < output.length; offset += 12000) {
      signal.throwIfAborted();
      while (runtime.append(id, 'protocol-test', output.subarray(offset, offset + 12000), 1) === false) await delay(20, undefined, { signal });
    }
    runtime.commit(id, 'protocol-test', 1);
    let pending = '';
    while (true) {
      signal.throwIfAborted(); const { value, done } = await reader.read(); if (done) break;
      pending += new TextDecoder().decode(value);
      for (let newline; (newline = pending.indexOf('\n')) !== -1;) {
        const event = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
        if (event.type === 'error') throw new VoiceError('WebSocket transcription test failed', 502, event.code);
        if (['partial', 'final'].includes(event.type) && event.text?.trim()) onOutput();
        if (event.type === 'final' && event.text?.trim()) return;
      }
    }
    throw new VoiceError('WebSocket test returned no transcription', 502);
  } finally { runtime.close(id); await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
}

function failure(error) {
  const status = error?.upstreamStatus || Number(/(?:http_|handshake_)(\d{3})/u.exec(error?.code || '')?.[1]);
  if ([401, 403].includes(status) || ['invalid_api_key', 'authentication_error', 'permission_denied'].includes(error?.code)) return { status: 'inconclusive', message: '认证失败，请检查供应商密钥与权限。', stop: true };
  if (status === 429 || ['rate_limit_exceeded', 'insufficient_quota'].includes(error?.code)) return { status: 'inconclusive', message: '供应商限流，请稍后重试。', stop: true };
  if (['asr_no_speech', 'no_speech', 'no_speech_found'].includes(error?.code)) return { status: 'inconclusive', message: '测试音频未识别到语音，无法据此判断协议。', stop: true };
  if ([404, 405, 415].includes(status) || ['asr_stream_unavailable', 'asr_session_required', 'tts_pcm_format', 'tts_audio_empty', 'tts_audio_invalid', 'tts_audio_limit'].includes(error?.code)) return { status: 'unsupported', message: '当前接口不支持该请求或响应格式。' };
  if ([400, 422].includes(status)) return { status: 'inconclusive', message: '供应商拒绝测试参数；请检查模型与音色，尚不能确定协议不兼容。' };
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return { status: 'inconclusive', message: '检测超时，请检查网络或手动选择协议。' };
  return { status: 'inconclusive', message: '连接或响应校验失败，请检查服务地址和模型。' };
}

export class ProtocolDetection {
  constructor({ fetcher = fetch, websocketProbe, shutdown = new AbortController().signal, audio = probeAudio, now = () => performance.now() } = {}) {
    this.fetcher = fetcher; this.websocketProbe = websocketProbe; this.shutdown = shutdown; this.audio = audio; this.now = now; this.pending = new Map();
  }
  cancelPending() { for (const item of this.pending.values()) item.controller.abort(); this.pending.clear(); }
  clear() { this.cancelPending(); }
  async probe(kind, config, protocol, signal) {
    const descriptor = protocolDescriptor(kind, protocol);
    if (!descriptor || !protocol || protocol === 'auto') throw new VoiceError('Unknown voice protocol', 409);
    const selected = { ...config, protocol }, started = this.now(); let firstOutputMs = null;
    const output = () => { if (firstOutputMs === null) firstOutputMs = Math.max(0, Math.round(this.now() - started)); };
    let message, bytes = 0, firstPlayableMs = null, maxAudioGapMs = 0, previousAudioAt = null;
    let firstAudioAt = null, remainingAudioMs = 0, observedPlaybackGapMs = 0, audioSupplyRatio = null;
    if (kind === 'asr' && descriptor.transport === 'websocket') {
      if (!this.websocketProbe) throw new VoiceError('WebSocket detection unavailable', 409);
      await this.websocketProbe(selected, await this.audio(), signal, output); output();
      message = '实时会话已建立，测试语音已通过 WebSocket 识别。';
    } else if (kind === 'asr') {
      const result = await executeAsr(this.fetcher, selected, await this.audio(), signal, output);
      if (!result.text?.trim()) throw new VoiceError('No test transcription', 502, 'asr_no_speech');
      output(); message = '测试语音已识别，响应格式有效。';
    } else {
      const upstream = await requestSpeech(this.fetcher, selected, PROBE_TEXT, signal);
      const type = upstream.headers.get('content-type') || '';
      const rate = upstream.headers.get('x-voice-sample-rate') || /(?:rate|samplerate|sample_rate)\s*=\s*"?(\d+)/iu.exec(type)?.[1];
      const channels = upstream.headers.get('x-voice-channels') || /channels\s*=\s*"?(\d+)/iu.exec(type)?.[1];
      if (!upstream.body || type && !['audio/pcm', 'audio/pcm16', 'audio/x-pcm', 'application/octet-stream'].includes(type.split(';')[0].trim().toLowerCase()) || rate && Number(rate) !== 24000 || channels && Number(channels) !== 1) {
        void upstream.body?.cancel().catch(() => {}); throw new VoiceError('Invalid PCM response', 502, 'tts_pcm_format');
      }
      const reader = upstream.body.getReader(); const cancel = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        while (true) {
          signal.throwIfAborted(); const { value, done } = await reader.read(); if (done) break;
          if (value.byteLength) {
            const receivedAt = this.now(); bytes += value.byteLength; output();
            firstAudioAt ??= receivedAt;
            if (previousAudioAt !== null) maxAudioGapMs = Math.max(maxAudioGapMs, Math.max(0, Math.round(receivedAt - previousAudioAt)));
            if (firstPlayableMs !== null) {
              const elapsed = Math.max(0, receivedAt - previousAudioAt);
              observedPlaybackGapMs += Math.max(0, elapsed - remainingAudioMs);
              remainingAudioMs = Math.max(0, remainingAudioMs - elapsed) + value.byteLength / PCM_BYTES_PER_MS;
            } else if (bytes >= PLAYABLE_PCM_BYTES) {
              firstPlayableMs = Math.max(0, Math.round(receivedAt - started));
              remainingAudioMs = bytes / PCM_BYTES_PER_MS;
            }
            previousAudioAt = receivedAt;
          }
          if (bytes > 12 * 1024 * 1024) throw new VoiceError('TTS test exceeds audio limit', 502, 'tts_pcm_format');
        }
      } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
      signal.throwIfAborted();
      if (!bytes || bytes % 2) throw new VoiceError('Incomplete PCM response', 502, 'tts_pcm_format');
      // A complete short utterance plays immediately even below the watermark.
      firstPlayableMs ??= Math.max(0, Math.round(this.now() - started));
      // Supply is measured over actual PCM arrival, excluding a late done event.
      // A single burst has no measurable arrival interval, so its ratio is null.
      if (previousAudioAt > firstAudioAt) audioSupplyRatio = Math.round(bytes / PCM_BYTES_PER_MS / (previousAudioAt - firstAudioAt) * 1000) / 1000;
      observedPlaybackGapMs = Math.round(observedPlaybackGapMs);
      message = '已验证首段 PCM 音频与完整结束；时延仅代表本次测试。';
    }
    return { message, firstOutputMs, completionMs: Math.max(0, Math.round(this.now() - started)), ...(kind === 'tts' ? { bytes, firstPlayableMs, maxAudioGapMs, audioSupplyRatio, observedPlaybackGapMs } : {}) };
  }
  async detect(kind, config, { requirement = 'any', explicit = false, signal = new AbortController().signal } = {}) {
    if (!['asr', 'tts'].includes(kind) || !['any', 'streaming', 'http'].includes(requirement)) throw new VoiceError('Invalid protocol matching request');
    if (explicit && (!config.protocol || config.protocol === 'auto')) return { status: 'inconclusive', protocol: '', apiType: '', attempts: [], message: '请先选择具体协议，或点击“自动匹配”。' };
    signal.throwIfAborted(); const key = keyFor(kind, config, requirement, explicit);
    let pending = this.pending.get(key);
    if (!pending) {
      if (this.pending.size >= 4) throw new VoiceError('协议匹配正在进行，请稍后重试', 429);
      const controller = new AbortController(); pending = { controller, consumers: 0 };
      pending.promise = this.run(kind, config, { requirement, explicit, signal: AbortSignal.any([controller.signal, this.shutdown]) })
        .finally(() => { if (this.pending.get(key) === pending) this.pending.delete(key); });
      this.pending.set(key, pending);
    }
    pending.consumers++;
    try { return await abortable(pending.promise, signal); }
    finally { if (--pending.consumers === 0 && this.pending.get(key) === pending) pending.controller.abort(); }
  }
  async run(kind, config, { requirement, explicit, signal }) {
    const attempts = [], candidates = protocolCandidates(kind, config, requirement, explicit);
    let stopped = false;
    for (const protocol of candidates) {
      if (stopped) { attempts.push({ protocol, status: 'not-tested', message: '前项认证、限流或输入校验失败，已停止后续请求。' }); continue; }
      signal.throwIfAborted(); const timeout = AbortSignal.timeout(ATTEMPT_TIMEOUT), attemptSignal = AbortSignal.any([signal, timeout]);
      const descriptor = protocolDescriptor(kind, protocol);
      if (!descriptor || requirement === 'streaming' && !descriptor.streaming || requirement === 'http' && descriptor.transport === 'websocket') {
        attempts.push({ protocol, status: 'unsupported', message: '该协议不符合当前用途的音频传输能力。' }); continue;
      }
      const started = this.now();
      try {
        const measured = await abortable(this.probe(kind, config, protocol, attemptSignal), attemptSignal);
        signal.throwIfAborted(); attempts.push({ protocol, status: 'supported', ...measured });
      } catch (error) {
        signal.throwIfAborted(); const result = failure(attemptSignal.aborted ? attemptSignal.reason : error);
        attempts.push({ protocol, status: result.status, message: result.message, completionMs: Math.max(0, Math.round(this.now() - started)) }); stopped = !!result.stop;
      }
    }
    const supported = attempts.filter(attempt => attempt.status === 'supported').sort((left, right) => capabilityRank(kind, protocolDescriptor(kind, left.protocol)) - capabilityRank(kind, protocolDescriptor(kind, right.protocol))
      || (kind === 'tts' ? playbackRisk(left) - playbackRisk(right) : 0)
      || (kind === 'tts' ? (left.firstPlayableMs ?? Infinity) - (right.firstPlayableMs ?? Infinity) : 0)
      || (left.firstOutputMs ?? Infinity) - (right.firstOutputMs ?? Infinity) || (left.completionMs ?? Infinity) - (right.completionMs ?? Infinity));
    if (supported.length) {
      const best = supported[0];
      return { status: 'supported', protocol: best.protocol, apiType: protocolDescriptor(kind, best.protocol).apiType, attempts, firstOutputMs: best.firstOutputMs, completionMs: best.completionMs,
        ...(kind === 'tts' ? { firstPlayableMs: best.firstPlayableMs, maxAudioGapMs: best.maxAudioGapMs, audioSupplyRatio: best.audioSupplyRatio, observedPlaybackGapMs: best.observedPlaybackGapMs } : {}),
        message: explicit ? '当前协议验证通过。' : kind === 'tts' ? '已比较可用协议，优先参考本次音频供给连续性，再比较起播时间；请保存所选协议。' : '已比较可用协议，按用途能力与本次首输出时间匹配；请保存所选协议。' };
    }
    const inconclusive = attempts.some(attempt => attempt.status === 'inconclusive');
    return { status: inconclusive ? 'inconclusive' : 'unsupported', protocol: '', apiType: '', attempts, message: inconclusive ? '暂时无法匹配，请检查配置后重试或手动选择。' : '没有符合当前用途的协议，请检查接口类型和模型。' };
  }
}
