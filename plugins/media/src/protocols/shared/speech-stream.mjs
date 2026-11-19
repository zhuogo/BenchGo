import { VoiceError } from '../../config.mjs';

export const SPEECH_BYTES = 12 * 1024 * 1024;
export const PCM_HEADERS = Object.freeze({ 'content-type': 'audio/pcm;rate=24000;channels=1', 'x-voice-sample-rate': '24000', 'x-voice-channels': '1', 'x-voice-format': 'pcm_s16le' });
export function speechOperation(signal, timeoutMs = 90000) {
  const controller = new AbortController(), combined = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  combined.throwIfAborted(); return { signal: combined, cancel: () => controller.abort() };
}
export function audioBytes(encoded) {
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(SPEECH_BYTES / 3) * 4 || encoded.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw new VoiceError('Invalid TTS audio event', 502, 'tts_audio_invalid');
  return new Uint8Array(Buffer.from(encoded, 'base64'));
}
export function speechError(value) {
  const candidate = value?.error?.code ?? value?.code ?? value?.data?.code;
  const code = typeof candidate === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/u.test(candidate) ? candidate : 'tts_stream_error';
  return new VoiceError('TTS service rejected the audio stream', 502, code);
}

/** Bound, align and validate PCM while forwarding the first available samples. */
export function pcmResponse(source, operation, headers = PCM_HEADERS) {
  const reader = source.getReader(); let bytes = 0, tail = null, closed = false, downstream;
  const cleanup = () => { operation.signal.removeEventListener('abort', abort); };
  const abort = () => { if (closed) return; closed = true; void reader.cancel().catch(() => {}); cleanup(); try { downstream.error(operation.signal.reason); } catch {} };
  const body = new ReadableStream({
    start(controller) { downstream = controller; operation.signal.addEventListener('abort', abort, { once: true }); if (operation.signal.aborted) abort(); },
    async pull(controller) {
      try {
        while (!closed) {
          operation.signal.throwIfAborted(); const { value, done } = await reader.read(); operation.signal.throwIfAborted();
          if (done) { if (!bytes || tail !== null) throw new VoiceError('TTS service returned incomplete PCM audio', 502, 'tts_audio_empty'); closed = true; cleanup(); controller.close(); return; }
          bytes += value.byteLength; if (bytes > SPEECH_BYTES) throw new VoiceError('TTS output exceeds audio limit', 502, 'tts_audio_limit');
          let chunk = value;
          if (tail !== null) { chunk = new Uint8Array(value.length + 1); chunk[0] = tail; chunk.set(value, 1); tail = null; }
          if (chunk.length % 2) { tail = chunk[chunk.length - 1]; chunk = chunk.subarray(0, -1); }
          if (chunk.length) { controller.enqueue(chunk); return; }
        }
      } catch (error) { if (!closed) { closed = true; cleanup(); void reader.cancel().catch(() => {}); operation.cancel(); controller.error(error); } }
    },
    cancel() { closed = true; cleanup(); operation.cancel(); void reader.cancel().catch(() => {}); },
  });
  return new Response(body, { headers });
}
