// Wire formats are independent from account brands and opaque model IDs.
export const VOICE_API_TYPES = Object.freeze([
  Object.freeze({ value: 'openai', id: 'openai', label: 'OpenAI 兼容' }),
  Object.freeze({ value: 'stepfun', id: 'stepfun', label: '阶跃星辰原生' }),
]);
const descriptor = (kind, id, apiType, label, outputStreaming, transport, inputStreaming = false) => Object.freeze({ kind, id, value: id, apiType, label, streaming: outputStreaming, inputStreaming, outputStreaming, transport });
export const VOICE_PROTOCOLS = Object.freeze([
  descriptor('asr', 'openai-websocket', 'openai', '实时识别（WebSocket）', true, 'websocket', true),
  descriptor('asr', 'transcriptions-sse', 'openai', '增量转录（SSE）', true, 'sse'),
  descriptor('asr', 'transcriptions', 'openai', '整段转录（HTTP）', false, 'http'),
  descriptor('asr', 'stepfun-sse', 'stepfun', '阶跃增量转录（SSE）', true, 'sse'),
  descriptor('tts', 'speech', 'openai', '语音合成（HTTP 音频）', true, 'http'),
  descriptor('tts', 'speech-stream', 'openai', '语音合成（stream 扩展）', true, 'http'),
  descriptor('tts', 'stepfun-speech-sse', 'stepfun', '阶跃语音合成（SSE）', true, 'sse'),
  descriptor('tts', 'stepfun-speech-websocket', 'stepfun', '阶跃语音合成（WebSocket）', true, 'websocket', true),
]);
export const ASR_PROTOCOL_OPTIONS = Object.freeze(VOICE_PROTOCOLS.filter(item => item.kind === 'asr'));
export const TTS_PROTOCOL_OPTIONS = Object.freeze(VOICE_PROTOCOLS.filter(item => item.kind === 'tts'));
export function protocolDescriptor(kind, id) { return VOICE_PROTOCOLS.find(item => item.kind === kind && item.id === id); }
export function protocolApiType(kind, id) { return protocolDescriptor(kind, id)?.apiType; }
export function protocolOptions(kind, apiType = '') {
  // StepFun standard speech/transcriptions reuse the OpenAI adapters.
  return VOICE_PROTOCOLS.filter(item => item.kind === kind && (!apiType || apiType === 'auto' || item.apiType === apiType || (apiType === 'stepfun' && item.apiType === 'openai' && item.transport !== 'websocket')));
}
