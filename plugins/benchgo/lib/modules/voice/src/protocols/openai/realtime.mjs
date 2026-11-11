export const realtimeAsr = Object.freeze({
  path: '/realtime', query: Object.freeze({ intent: 'transcription' }), requiresItemId: true,
  // session.created does not acknowledge our transcription settings.
  ready: type => type === 'session.updated',
  session: model => ({ type: 'transcription', audio: { input: {
    format: { type: 'audio/pcm', rate: 24000 }, transcription: { model }, turn_detection: null,
  } } }),
  partial: (event, previous) => typeof event.delta === 'string' ? previous + event.delta : previous,
});
