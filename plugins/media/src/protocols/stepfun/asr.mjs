import { normalizeAsrModel } from '../../config.mjs';
import { upstreamFailure } from '../shared/upstream.mjs';
import { readAsrSse } from '../shared/asr-sse.mjs';

/** StepFun native SSE differs from OpenAI multipart transcription. */
export async function transcribe(fetcher, config, bytes, signal, partial) {
  const body = JSON.stringify({ audio: { data: Buffer.from(bytes).toString('base64'), input: {
    transcription: { model: normalizeAsrModel(config.model) }, format: { type: 'wav' },
  } } });
  const headers = { accept: 'text/event-stream', 'content-type': 'application/json', ...(config.apiKey ? { authorization: 'Bearer ' + config.apiKey } : {}) };
  const upstream = await fetcher(config.baseURL + '/audio/asr/sse', { method: 'POST', headers, body, signal, redirect: 'error' });
  if (!upstream.ok) throw await upstreamFailure(upstream, 'ASR', signal);
  return readAsrSse(upstream, signal, partial);
}
