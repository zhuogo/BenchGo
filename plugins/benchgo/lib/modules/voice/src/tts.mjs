import { VoiceError, normalizeTtsModel, normalizeTtsSpeed } from './config.mjs';

/** Streaming synthesis is an explicit protocol choice, never inferred from a provider or model. */
export function speechRequest(config, text) {
  const protocol = config.protocol || 'speech';
  if (!['speech', 'speech-stream'].includes(protocol)) throw new VoiceError('Unknown TTS protocol');
  return {
    model: normalizeTtsModel(config.model),
    voice: config.voice || 'alloy',
    input: text,
    response_format: 'pcm',
    speed: normalizeTtsSpeed(config.speed),
    ...(protocol === 'speech-stream' ? { stream: true } : {}),
  };
}
