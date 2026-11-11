import { VoiceError } from '../../config.mjs';

/** Pull-driven SSE packets, bounded independently from decoded audio. */
export async function* sseEvents(body, signal, { kind = 'TTS', maxBytes = 20 * 1024 * 1024, maxEventBytes = 2 * 1024 * 1024 } = {}) {
  const reader = body.getReader(), decoder = new TextDecoder(); let pending = '', total = 0;
  const abort = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', abort, { once: true });
  const packet = text => text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  try {
    while (true) {
      signal.throwIfAborted(); const { value, done } = await reader.read(); signal.throwIfAborted();
      if (done) break;
      total += value.byteLength; if (total > maxBytes) throw new VoiceError(kind + ' event stream exceeds limit', 502, kind.toLowerCase() + '_stream_limit');
      pending = (pending + decoder.decode(value, { stream: true })).replace(/\r\n/gu, '\n');
      let end; while ((end = pending.indexOf('\n\n')) >= 0) {
        if (end > maxEventBytes) throw new VoiceError(kind + ' event exceeds limit', 502, kind.toLowerCase() + '_stream_limit');
        const data = packet(pending.slice(0, end)); pending = pending.slice(end + 2); if (data) yield data;
      }
      if (pending.length > maxEventBytes) throw new VoiceError(kind + ' event exceeds limit', 502, kind.toLowerCase() + '_stream_limit');
    }
    pending += decoder.decode(); const data = packet(pending); if (data) yield data;
  } finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
