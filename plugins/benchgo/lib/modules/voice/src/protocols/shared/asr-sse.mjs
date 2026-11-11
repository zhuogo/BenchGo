import { VoiceError } from '../../config.mjs';
import { sseEvents } from './sse.mjs';

export async function readAsrSse(upstream, signal, partial = () => {}) {
  if (!upstream.body || !upstream.headers.get('content-type')?.includes('text/event-stream')) {
    await upstream.body?.cancel();
    throw new VoiceError('所选识别接口未返回 SSE 增量；请在设置 → 媒体 → 语音中使用“自动匹配”按钮，或在高级设置中选择正确的流式协议。仅听写也可使用“整段转录（HTTP）”；实时通话需要支持流式识别的接口。', 502, 'asr_stream_unavailable');
  }
  let text = '', delivered = '', doneEvent = false;
  for await (const data of sseEvents(upstream.body, signal, { kind: 'ASR', maxBytes: 1024 * 1024, maxEventBytes: 65536 })) {
    if (data === '[DONE]') { doneEvent = true; break; }
    let value; try { value = JSON.parse(data); } catch { throw new VoiceError('Invalid ASR stream event', 502); }
    if (!value || typeof value !== 'object') throw new VoiceError('Invalid ASR stream event', 502);
    if (value.error || value.type === 'error') {
      const candidate = value.error?.code ?? value.code ?? value.error?.type;
      const code = typeof candidate === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/u.test(candidate) ? candidate : 'asr_stream_error';
      throw new VoiceError('ASR streaming request failed', 502, code);
    }
    if (value.type === 'transcript.text.delta' && typeof value.delta === 'string') text += value.delta;
    else if (value.type === 'transcript.text.done' && typeof value.text === 'string') { text = value.text; doneEvent = true; }
    if (text.length > 20000) throw new VoiceError('ASR transcript exceeds limit', 502);
    signal.throwIfAborted(); if (text && text !== delivered) { delivered = text; partial(text); }
    if (doneEvent) break;
  }
  if (!doneEvent) throw new VoiceError('ASR stream ended before final transcription', 502);
  return { text: text.trim() };
}
