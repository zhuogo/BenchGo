import { VoiceError } from './config.mjs';

// Wire formats depend on the selected protocol, never a provider identity.
const protocols = {
  'openai-websocket': {
    path: '/realtime', query: { intent: 'transcription' }, requiresItemId: true,
    // Initial session.created does not acknowledge our transcription settings.
    ready: type => type === 'session.updated',
    session: model => ({ type: 'transcription', audio: { input: {
      format: { type: 'audio/pcm', rate: 24000 }, transcription: { model }, turn_detection: null,
    } } }),
    partial: (event, previous) => typeof event.delta === 'string' ? previous + event.delta : previous,
  },
};

export function realtimeProtocol(protocol = 'openai-websocket') {
  const adapter = Object.hasOwn(protocols, protocol) ? protocols[protocol] : undefined;
  if (!adapter) throw new VoiceError('Select a supported native realtime ASR protocol', 400);
  return adapter;
}
