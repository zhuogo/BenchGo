import { VoiceError } from './config.mjs';

export const LIMITS = Object.freeze({ audioBytes: 2 * 1024 * 1024, audioSeconds: 15, jsonBytes: 32768, speechCharacters: 4000, speechBytes: 12 * 1024 * 1024, requestTimeout: 90000 });
export function validateWav(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE' || buffer.readUInt32LE(4) + 8 !== buffer.length) throw new VoiceError('Expected a complete PCM WAV file');
  let format, data;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', offset, offset + 4), length = buffer.readUInt32LE(offset + 4), start = offset + 8;
    if (start + length > buffer.length) throw new VoiceError('Malformed WAV chunk');
    if (id === 'fmt ') {
      if (length < 16) throw new VoiceError('Malformed WAV format');
      format = { codec: buffer.readUInt16LE(start), channels: buffer.readUInt16LE(start + 2), rate: buffer.readUInt32LE(start + 4), alignment: buffer.readUInt16LE(start + 12), bits: buffer.readUInt16LE(start + 14) };
    }
    if (id === 'data') data = length;
    offset = start + length + (length % 2);
  }
  if (!format || !data || format.codec !== 1 || format.channels !== 1 || format.bits !== 16 || format.alignment !== 2 || ![16000, 22050, 24000, 44100, 48000].includes(format.rate) || data % 2) throw new VoiceError('Audio must be mono PCM16 WAV (16–48 kHz)');
  if (data / (format.rate * 2) > LIMITS.audioSeconds) throw new VoiceError('Audio segment exceeds 15 seconds', 413);
  return format;
}
export { upstreamFailure } from './protocols/shared/upstream.mjs';
export { transcribe } from './protocols/openai/asr.mjs';
