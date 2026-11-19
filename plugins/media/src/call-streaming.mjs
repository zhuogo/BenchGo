import { protocolDescriptor } from '../shared/protocol-catalog.mjs';

/** Calls use the concrete protocols saved by matching or manual selection. */
export function callStreamingReason(config) {
  const asr = protocolDescriptor('asr', config.asr?.protocol), tts = protocolDescriptor('tts', config.tts?.protocol);
  if (!asr || !tts) return '请在设置 → 媒体 → 语音中点击自动匹配并保存协议，或在高级设置中选择具体协议';
  if (!asr.streaming) return '实时通话需要流式识别，请在设置 → 媒体 → 语音中选择 SSE 或实时 WebSocket';
  if (config.tts?.stream === false) return '实时通话需要流式播放，请在设置 → 媒体 → 语音中开启流式播放';
  return '';
}
