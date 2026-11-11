import { VoiceError } from '../config.mjs';
import { transcribe as openaiTranscribe } from './openai/asr.mjs';
import { transcribe as stepfunTranscribe } from './stepfun/asr.mjs';
import { requestSpeech as openaiSpeech } from './openai/tts.mjs';
import { requestSpeech as stepfunSseSpeech } from './stepfun/tts-sse.mjs';
import { requestSpeech as stepfunWebsocketSpeech } from './stepfun/tts-websocket.mjs';
export { speechRequest } from './openai/tts.mjs';
export { VOICE_API_TYPES, VOICE_PROTOCOLS, ASR_PROTOCOL_OPTIONS, TTS_PROTOCOL_OPTIONS, protocolOptions, protocolDescriptor, protocolApiType } from '../../shared/protocol-catalog.mjs';

const asr = Object.freeze({ transcriptions: openaiTranscribe, 'transcriptions-sse': openaiTranscribe, 'stepfun-sse': stepfunTranscribe });
const tts = Object.freeze({ speech: openaiSpeech, 'speech-stream': openaiSpeech, 'stepfun-speech-sse': stepfunSseSpeech, 'stepfun-speech-websocket': stepfunWebsocketSpeech });
export function requestSpeech(fetcher, config, text, signal) {
  const protocol = config.protocol || 'speech', adapter = Object.hasOwn(tts, protocol) ? tts[protocol] : undefined;
  if (!adapter) throw new VoiceError('Unknown TTS protocol');
  return adapter(fetcher, config, text, signal);
}
export async function executeAsr(fetcher, config, bytes, signal, partial = () => {}) {
  const protocol = config.protocol || 'transcriptions';
  if (protocol === 'openai-websocket') throw new VoiceError('Native realtime ASR requires a WebSocket session', 409, 'asr_session_required');
  const adapter = Object.hasOwn(asr, protocol) ? asr[protocol] : undefined;
  if (!adapter) throw new VoiceError('Select a supported transcription protocol', 409);
  return adapter(fetcher, config, bytes, signal, partial);
}
