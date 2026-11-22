import { VoiceError } from '../../config.mjs';
import { SPEECH_BYTES } from './speech-stream.mjs';

export const wavFormatError = () => new VoiceError('TTS service must return complete 24 kHz mono PCM16 WAV audio', 502, 'tts_wav_format');

function audioLimit() {
  return new VoiceError('TTS output exceeds audio limit', 502, 'tts_audio_limit');
}

// Streaming WAV writers use sentinel lengths when the final size is unknown.
const streamingLength = 0xffffffff;
// RouterGo also sends near-2 GiB placeholder lengths for chunked responses.
const routerGoStreamingSize = length => length >= 0x7f000000 && length <= 0x7fffffff;

/** Remove the WAV container without holding the audio in memory. */
export function wavPcmStream(source, signal, { routerGo = false } = {}) {
  const reader = source.getReader();
  const header = Buffer.alloc(16);
  let received = 0, position = 0, filled = 0, remaining = 0, riffEnd = Infinity;
  let provisionalEnd = null;
  let state = 'riff', formatSeen = false, audioSeen = false;

  async function* samples() {
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) {
          const streamed = state === 'data' && remaining === Infinity;
          const complete = provisionalEnd === null && state === 'chunk' && filled === 0 && (riffEnd === Infinity || position === riffEnd);
          if (!audioSeen || !(streamed || complete)) throw wavFormatError();
          return;
        }
        received += value.byteLength;
        if (received > SPEECH_BYTES) throw audioLimit();
        for (let offset = 0; offset < value.length;) {
          if (position >= riffEnd) throw wavFormatError();
          if (state === 'data' || state === 'skip') {
            const count = Math.min(value.length - offset, remaining);
            const output = state === 'data' ? value.subarray(offset, offset + count) : null;
            offset += count;
            position += count;
            remaining -= count;
            if (remaining === 0) state = 'chunk';
            if (output?.length) yield output;
            continue;
          }

          const size = state === 'riff' ? 12 : state === 'format' ? 16 : 8;
          const count = Math.min(size - filled, value.length - offset, riffEnd - position);
          header.set(value.subarray(offset, offset + count), filled);
          offset += count;
          position += count;
          filled += count;
          if (filled < size) continue;
          filled = 0;

          if (state === 'riff') {
            if (header.toString('latin1', 0, 4) !== 'RIFF' || header.toString('latin1', 8, 12) !== 'WAVE') throw wavFormatError();
            const length = header.readUInt32LE(4);
            if (routerGo && routerGoStreamingSize(length)) {
              provisionalEnd = length + 8;
            } else if (length !== streamingLength) {
              riffEnd = length + 8;
              if (riffEnd < 44 || riffEnd % 2) throw wavFormatError();
              if (riffEnd > SPEECH_BYTES) throw audioLimit();
            }
            state = 'chunk';
          } else if (state === 'format') {
            if (header.readUInt16LE(0) !== 1 || header.readUInt16LE(2) !== 1 || header.readUInt32LE(4) !== 24000
              || header.readUInt32LE(8) !== 48000 || header.readUInt16LE(12) !== 2 || header.readUInt16LE(14) !== 16) throw wavFormatError();
            formatSeen = true;
            state = remaining ? 'skip' : 'chunk';
          } else {
            const id = header.toString('latin1', 0, 4), length = header.readUInt32LE(4);
            const unknownLength = provisionalEnd === null
              ? length === streamingLength && riffEnd === Infinity
              : routerGoStreamingSize(length) && position + length === provisionalEnd;
            if (id === 'data' && unknownLength) {
              if (!formatSeen || audioSeen) throw wavFormatError();
              audioSeen = true;
              remaining = Infinity;
              state = 'data';
              continue;
            }
            if (id === 'data' && provisionalEnd !== null) throw wavFormatError();
            remaining = length + length % 2;
            if (position + remaining > SPEECH_BYTES) throw audioLimit();
            if (position + remaining > riffEnd) throw wavFormatError();
            if (id === 'fmt ') {
              if (formatSeen || length < 16) throw wavFormatError();
              remaining -= 16;
              state = 'format';
            } else if (id === 'data') {
              if (!formatSeen || audioSeen || !length || length % 2) throw wavFormatError();
              audioSeen = true;
              state = 'data';
            } else {
              state = remaining ? 'skip' : 'chunk';
            }
          }
        }
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  const iterator = samples();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel() {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
      void iterator.return().catch(() => {});
    },
  }, { highWaterMark: 0 });
}
