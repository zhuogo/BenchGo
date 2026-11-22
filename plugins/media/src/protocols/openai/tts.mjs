import { upstreamFailure } from '../shared/upstream.mjs';
import { VoiceError, normalizeTtsModel, normalizeTtsSpeed } from '../../config.mjs';
import { pcmResponse, speechOperation, SPEECH_BYTES } from '../shared/speech-stream.mjs';
import { wavPcmStream, wavFormatError } from '../shared/wav-speech.mjs';
import { routerGo } from '../../../../base/shared/builtin-providers.mjs';

/** HTTP wire formats share the same PCM playback contract. */
export function speechRequest(config, text, { omitSpeed = false } = {}) {
  const protocol = config.protocol || 'speech';
  if (!['speech', 'speech-stream', 'speech-wav'].includes(protocol)) throw new VoiceError('Unknown TTS protocol');
  const request = {
    model: normalizeTtsModel(config.model),
    voice: config.voice || 'alloy',
    input: text,
  };
  if (protocol === 'speech-wav') return { ...request, response_format: 'wav' };
  return {
    ...request, response_format: 'pcm',
    ...(!omitSpeed && { speed: normalizeTtsSpeed(config.speed) }),
    ...(protocol === 'speech-stream' ? { stream: true } : {}),
  };
}

export async function requestSpeech(fetcher, config, text, signal, options) {
  const operation = speechOperation(signal);
  const upstream = await fetcher(config.baseURL + '/audio/speech', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: 'Bearer ' + config.apiKey } : {}) },
    body: JSON.stringify(speechRequest(config, text, options)), signal: operation.signal, redirect: 'error',
  });
  if (!upstream.ok) throw await upstreamFailure(upstream, 'TTS', operation.signal);
  if (Number(upstream.headers.get('content-length')) > SPEECH_BYTES) {
    void upstream.body?.cancel().catch(() => {}); throw new VoiceError('TTS output exceeds audio limit', 502, 'tts_audio_limit');
  }
  const type = upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (config.protocol === 'speech-wav') {
    if (!upstream.body || type && !['audio/wav', 'audio/wave', 'audio/x-wav', 'audio/vnd.wave', 'application/octet-stream'].includes(type)) {
      void upstream.body?.cancel().catch(() => {});
      throw wavFormatError();
    }
    return pcmResponse(wavPcmStream(upstream.body, operation.signal, { routerGo: config.baseURL === routerGo.baseURL }), operation);
  }
  const format = upstream.headers.get('content-type') || '', rate = upstream.headers.get('x-voice-sample-rate') || /(?:rate|samplerate|sample_rate)\s*=\s*"?(\d+)/iu.exec(format)?.[1], channels = upstream.headers.get('x-voice-channels') || /channels\s*=\s*"?(\d+)/iu.exec(format)?.[1];
  if (!upstream.body || type && !['audio/pcm', 'audio/pcm16', 'audio/x-pcm', 'application/octet-stream'].includes(type) || rate && Number(rate) !== 24000 || channels && Number(channels) !== 1) {
    void upstream.body?.cancel().catch(() => {}); throw new VoiceError('TTS service must return PCM16LE, 24 kHz mono audio', 502, 'tts_pcm_format');
  }
  return pcmResponse(upstream.body, operation);
}
