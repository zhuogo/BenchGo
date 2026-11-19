import { VoiceError } from '../../config.mjs';
import { speechRequest } from '../openai/tts.mjs';
import { upstreamFailure } from '../shared/upstream.mjs';
import { audioBytes, pcmResponse, speechError, speechOperation } from '../shared/speech-stream.mjs';
import { sseEvents } from '../shared/sse.mjs';

export async function requestSpeech(fetcher, config, text, signal) {
  const operation = speechOperation(signal);
  const body = { ...speechRequest({ ...config, protocol: 'speech' }, text), stream_format: 'sse', sample_rate: 24000 };
  if (body.speed < .5 || body.speed > 2) throw new VoiceError('阶跃语音协议的语速须为 0.5–2', 400, 'tts_speed_unsupported');
  if (Array.from(text).length > 1000) throw new VoiceError('阶跃 SSE 语音合成每段文本不能超过 1000 字符', 400, 'tts_text_limit');
  const upstream = await fetcher(config.baseURL + '/audio/speech', { method: 'POST',
    headers: { accept: 'text/event-stream', 'content-type': 'application/json', ...(config.apiKey ? { authorization: 'Bearer ' + config.apiKey } : {}) },
    body: JSON.stringify(body), signal: operation.signal, redirect: 'error' });
  if (!upstream.ok) throw await upstreamFailure(upstream, 'TTS', operation.signal);
  if (!upstream.body || !upstream.headers.get('content-type')?.includes('text/event-stream')) {
    void upstream.body?.cancel().catch(() => {}); throw new VoiceError('TTS service did not return SSE audio', 502, 'tts_stream_unavailable');
  }
  const events = sseEvents(upstream.body, operation.signal);
  async function* audio() {
    for await (const data of events) {
      if (data === '[DONE]') break;
      let value; try { value = JSON.parse(data); } catch { throw new VoiceError('Invalid TTS stream event', 502, 'tts_audio_invalid'); }
      if (!value || typeof value !== 'object') throw new VoiceError('Invalid TTS stream event', 502, 'tts_audio_invalid');
      if (value.error || ['error', 'speech.audio.error'].includes(value.type)) throw speechError(value);
      if (value.type === 'speech.audio.delta') { const chunk = audioBytes(value.audio); if (chunk.length) yield chunk; }
      if (value.type === 'speech.audio.done') {
        // The live endpoint omits audio on done; documentation also shows ''.
        if (Object.hasOwn(value, 'audio') && value.audio !== '') throw new VoiceError('Invalid TTS completion event', 502, 'tts_audio_invalid');
        return;
      }
    }
    throw new VoiceError('TTS stream ended before completion', 502, 'tts_stream_incomplete');
  }
  const iterator = audio();
  const source = new ReadableStream({ async pull(controller) { try { const { value, done } = await iterator.next(); if (done) controller.close(); else controller.enqueue(value); } catch (error) { controller.error(error); } }, cancel() { operation.cancel(); void iterator.return().catch(() => {}); } });
  return pcmResponse(source, operation);
}
