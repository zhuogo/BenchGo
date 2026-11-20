export const modelCapabilityLabels = Object.freeze({
  text: '文本',
  'image-generation': '图片生成',
  'image-edit': '图片编辑',
  'image-mask': '遮罩编辑',
  video: '视频生成',
  tts: '语音合成',
  asr: '语音识别',
  realtime: '实时音频',
  embedding: '向量嵌入',
  rerank: '重排序',
  moderation: '内容审核',
  decision: '判断',
});

const textCapabilities = new Set(['text', 'chat', 'responses', 'anthropic-messages']);

export function normalizeModelCapabilities(capabilities = []) {
  return [...new Set(capabilities.map(capability => textCapabilities.has(capability) ? 'text' : capability))];
}

export function hasTextCapability(capabilities = []) {
  return capabilities.some(capability => textCapabilities.has(capability));
}

const taskCapabilities = new Map([
  ['text-generation', 'text'],
  ['chat-completions', 'chat'],
  ['text-to-image', 'image-generation'],
  ['image-to-image', 'image-edit'],
  ['text-to-video', 'video'],
  ['image-to-video', 'video'],
  ['video-generation', 'video'],
  ['automatic-speech-recognition', 'asr'],
  ['audio-to-text', 'asr'],
  ['speech-to-text', 'asr'],
  ['transcription', 'asr'],
  ['transcriptions', 'asr'],
  ['text-to-speech', 'tts'],
  ['speech-synthesis', 'tts'],
  ['speech', 'tts'],
]);

export function structuredCapabilities(model, inputs, outputs) {
  if (Array.isArray(model.capabilities)) return [...new Set(model.capabilities)];
  const tags = model.capabilities && typeof model.capabilities === 'object'
    ? Object.keys(model.capabilities).filter(key => model.capabilities[key] === true)
    : [];
  const explicit = [...tags, model.task, model.pipeline_tag, model.type, model.mode]
    .map(task => taskCapabilities.get(task) ?? task)
    .filter(capability => typeof capability === 'string'
      && (Object.hasOwn(modelCapabilityLabels, capability) || textCapabilities.has(capability)));
  if (explicit.length) return [...new Set(explicit)];
  if (outputs.length !== 1) return [];
  if (outputs[0] === 'text' && inputs.length === 1 && inputs[0] === 'audio') return ['asr'];
  if (outputs[0] === 'audio' && inputs.length === 1 && inputs[0] === 'text') return ['tts'];
  if (outputs[0] === 'image' && inputs.includes('text')) return ['image-generation'];
  if (outputs[0] === 'video' && inputs.length) return ['video'];
  if (outputs[0] === 'text' && inputs.includes('text')) return ['text'];
  return [];
}
