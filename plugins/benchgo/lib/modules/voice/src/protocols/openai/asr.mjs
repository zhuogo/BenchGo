import { readLimited } from '../../../../../../shared/http.mjs';
import { VoiceError, normalizeAsrModel } from '../../config.mjs';
import { upstreamFailure } from '../shared/upstream.mjs';
import { readAsrSse } from '../shared/asr-sse.mjs';

export async function transcribe(fetcher, config, bytes, signal, partial) {
  const streaming = config.protocol === 'transcriptions-sse', body = new FormData();
  body.set('file', new Blob([bytes], { type: 'audio/wav' }), 'segment.wav');
  body.set('model', normalizeAsrModel(config.model)); body.set('response_format', 'json');
  if (streaming) body.set('stream', 'true');
  const headers = { ...(streaming ? { accept: 'text/event-stream' } : {}), ...(config.apiKey ? { authorization: 'Bearer ' + config.apiKey } : {}) };
  const upstream = await fetcher(config.baseURL + '/audio/transcriptions', { method: 'POST', headers, body, signal, redirect: 'error' });
  if (!upstream.ok) throw await upstreamFailure(upstream, 'ASR', signal);
  if (streaming) return readAsrSse(upstream, signal, partial);
  const raw = await readLimited(new Request('http://voice.internal', { method: 'POST', body: upstream.body, duplex: 'half', signal }), 65536);
  let result; try { result = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new VoiceError('ASR service returned invalid JSON', 502); }
  if (typeof result.text !== 'string' || result.text.length > 20000) throw new VoiceError('ASR service returned invalid transcription', 502);
  signal.throwIfAborted(); return { text: result.text.trim() };
}
