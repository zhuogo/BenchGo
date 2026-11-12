import WebSocket from 'ws';
import { VoiceError, normalizeTtsModel, normalizeTtsSpeed } from '../../config.mjs';
import { audioBytes, pcmResponse, SPEECH_BYTES, speechError, speechOperation } from '../shared/speech-stream.mjs';

export function speechEndpoint(config) {
  const endpoint = new URL(config.baseURL.replace(/\/+$/u, '') + '/realtime/audio');
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : endpoint.protocol === 'http:' ? 'ws:' : endpoint.protocol;
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new VoiceError('Invalid TTS WebSocket endpoint');
  endpoint.search = ''; endpoint.searchParams.set('model', normalizeTtsModel(config.model)); return endpoint;
}

/** One bounded sentence request; the wire supports incremental text without a second playback pipeline. */
export async function requestSpeech(_fetcher, config, text, signal, { socket = (url, options) => new WebSocket(url, options), timeoutMs = 90000 } = {}) {
  const operation = speechOperation(signal, timeoutMs), speed = normalizeTtsSpeed(config.speed);
  if (speed < .5 || speed > 2) throw new VoiceError('阶跃语音协议的语速须为 0.5–2', 400, 'tts_speed_unsupported');
  const ws = socket(speechEndpoint(config).href, { headers: config.apiKey ? { authorization: 'Bearer ' + config.apiKey } : {}, followRedirects: false,
    maxPayload: Math.ceil(SPEECH_BYTES / 3) * 4 + 32768, handshakeTimeout: 10000 });
  let controller, closed = false, session = '', created = false, audioTotal = 0, resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const cleanup = () => { operation.signal.removeEventListener('abort', abort); if (ws.readyState === 0 || ws.readyState === 1) ws.terminate(); };
  const fail = error => { if (closed) return; closed = true; rejectReady(error); try { controller.error(error); } catch {} cleanup(); };
  const abort = () => fail(operation.signal.reason || new DOMException('Aborted', 'AbortError'));
  const send = (type, data) => ws.send(JSON.stringify({ type, data: { session_id: session, ...data } }));
  const enqueue = encoded => {
    const bytes = audioBytes(encoded); audioTotal += bytes.length;
    if (audioTotal > SPEECH_BYTES) throw new VoiceError('TTS output exceeds audio limit', 502, 'tts_audio_limit');
    if (bytes.length) { controller.enqueue(bytes); if (controller.desiredSize <= 0) ws.pause?.(); }
  };
  const source = new ReadableStream({ start(value) { controller = value; }, pull() { ws.resume?.(); }, cancel() { if (!closed) { closed = true; rejectReady(new DOMException('Aborted', 'AbortError')); cleanup(); } } }, { highWaterMark: 256 * 1024, size: chunk => chunk.byteLength });
  operation.signal.addEventListener('abort', abort, { once: true });
  ws.on('message', raw => {
    if (closed) return;
    try {
      let event; try { event = JSON.parse(String(raw)); } catch { throw new VoiceError('Invalid TTS WebSocket event', 502, 'tts_audio_invalid'); }
      if (!event || typeof event !== 'object') throw new VoiceError('Invalid TTS WebSocket event', 502, 'tts_audio_invalid');
      if (event.type === 'tts.response.error' || event.type === 'error' || event.error) throw speechError(event);
      const data = event.data || {};
      if (event.type === 'tts.connection.done') {
        if (session || typeof data.session_id !== 'string' || !data.session_id || data.session_id.length > 512) throw new VoiceError('Invalid TTS session', 502, 'tts_session_invalid');
        session = data.session_id;
        send('tts.create', { voice_id: config.voice || 'alloy', response_format: 'pcm', sample_rate: 24000, speed_ratio: speed, mode: 'sentence' }); return;
      }
      if (!session || data.session_id !== session) throw new VoiceError('TTS session does not match', 502, 'tts_session_invalid');
      if (event.type === 'tts.response.created') {
        if (created) throw new VoiceError('Duplicate TTS session', 502, 'tts_session_invalid');
        created = true;
        const characters = Array.from(text);
        const chunkSize = 1000;
        for (let offset = 0; offset < characters.length; offset += chunkSize) send('tts.text.delta', { text: characters.slice(offset, offset + chunkSize).join('') });
        send('tts.text.done'); resolveReady(); return;
      }
      if (!created) throw new VoiceError('TTS audio arrived before session creation', 502, 'tts_session_invalid');
      if (event.type === 'tts.response.audio.delta') enqueue(data.audio);
      if (event.type === 'tts.response.audio.done') {
        if (typeof data.audio !== 'string') throw new VoiceError('Invalid TTS completion event', 502, 'tts_audio_invalid');
        // The final event repeats the complete audio; playing it after deltas duplicates speech.
        if (!audioTotal && data.audio) enqueue(data.audio);
        closed = true; controller.close(); cleanup();
      }
    } catch (error) { fail(error); }
  });
  ws.on('error', () => fail(new VoiceError('TTS WebSocket connection failed', 502, 'tts_connection_failed')));
  ws.on('unexpected-response', (_request, response) => {
    response.resume?.(); const status = Number(response.statusCode) || 502;
    const error = new VoiceError('TTS WebSocket handshake rejected (' + status + ')', 502, 'tts_http_' + status); error.upstreamStatus = status; fail(error);
  });
  ws.on('close', () => { if (!closed) fail(new VoiceError('TTS WebSocket ended before completion', 502, 'tts_stream_incomplete')); });
  if (operation.signal.aborted) abort();
  // Forward the first samples immediately; all routes use the common player.
  try { await ready; return pcmResponse(source, operation); }
  catch (error) { void source.cancel().catch(() => {}); operation.cancel(); throw error; }
}
