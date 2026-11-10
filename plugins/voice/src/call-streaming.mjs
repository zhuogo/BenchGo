/** One streaming contract for capability discovery, UI and both media boundaries. */
export function callStreamingReason(config) {
  if (!['transcriptions-sse', 'openai-websocket'].includes(config.asr?.protocol || 'transcriptions-sse')) return '实时通话需要流式识别，请在设置 → 媒体 → 语音中选择 SSE 或实时 WebSocket';
  if (config.tts?.stream === false) return '实时通话需要流式播放，请在设置 → 媒体 → 语音中开启流式播放';
  return '';
}
