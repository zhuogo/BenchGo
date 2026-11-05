import { VoiceError, normalizeTtsModel, normalizeTtsSpeed } from './config.mjs';

/** Keep vendor extensions out of the standard OpenAI speech request. */
export function speechRequest(config, text) {
  const protocol = config.protocol || 'speech';
  if (protocol !== 'speech') throw new VoiceError('Unknown TTS protocol');
  return {
    model: normalizeTtsModel(config.model),
    voice: config.voice || 'alloy',
    input: text,
    response_format: 'pcm',
    speed: normalizeTtsSpeed(config.speed),
  };
}
