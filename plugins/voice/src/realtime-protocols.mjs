import { VoiceError } from './config.mjs';
import { realtimeAsr } from './protocols/openai/realtime.mjs';

const protocols = Object.freeze({ 'openai-websocket': realtimeAsr });
export function realtimeProtocol(protocol = 'openai-websocket') {
  const adapter = Object.hasOwn(protocols, protocol) ? protocols[protocol] : undefined;
  if (!adapter) throw new VoiceError('Select a supported native realtime ASR protocol', 400);
  return adapter;
}
