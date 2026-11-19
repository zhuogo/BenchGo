import { protocolDescriptor, VOICE_API_TYPES } from '../shared/protocol-catalog.mjs';
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
export const listeningDraft = (value = {}) => ({ enabled: !!value.enabled, endpoint: value.endpoint ?? '', model: value.model || '', apiKey: '', wakeSource: value.wakeSource || 'custom', wakeWord: value.wakeWord ?? '' });

export function listeningSettingsPatch(draft, original = {}, clearKey = false) {
  if (typeof draft.model !== 'string' || draft.model !== draft.model.trim()) throw Error('决策模型 ID 首尾不能含空格。');
  const patch = {};
  for (const key of ['enabled', 'endpoint', 'model', 'wakeSource', 'wakeWord']) {
    if (draft[key] !== listeningDraft(original)[key]) patch[key] = draft[key];
  }
  if (clearKey) patch.apiKey = '';
  else if (draft.apiKey?.trim()) patch.apiKey = draft.apiKey;
  return patch;
}

export function voiceSettingsPatch(draft, original, clearKeys = {}) {
  const patch = {};
  for (const kind of ['asr', 'tts']) {
    if (draft[kind]?.protocol && !protocolDescriptor(kind, draft[kind].protocol)) throw Error(`${kind.toUpperCase()} 当前协议已不支持，请显式选择支持的协议后保存。`);
    if (draft[kind]?.apiType && !VOICE_API_TYPES.some(type => type.value === draft[kind].apiType)) throw Error(`${kind.toUpperCase()} 当前接口类型已不支持，请重新选择。`);
  }
  for (const key of ['dictation', 'readAloud', 'call']) if (draft[key] !== original[key]) patch[key] = draft[key];
  const conversation = draft.conversation || { providerId: '', model: '' };
  if (!!conversation.providerId !== !!conversation.model) throw Error('通话交互模型需要同时选择供应商和模型；两项留空使用原会话直通。');
  for (const key of ['providerId', 'model']) {
    const value = conversation[key] || '';
    if (typeof value !== 'string' || value !== value.trim()) throw Error('通话交互模型的供应商和模型 ID 首尾不能含空格。');
    if (value !== (original.conversation?.[key] || '')) (patch.conversation ||= {})[key] = value;
  }
  if (draft.listening) {
    const listening = listeningSettingsPatch(draft.listening, original.listening, !!clearKeys.listening);
    if (Object.keys(listening).length) patch.listening = listening;
  }
  for (const kind of ['asr', 'tts']) {
    const endpoint = {};
    for (const [key, value] of Object.entries(draft[kind])) {
      if (key === 'apiKey' || ['resolvedProtocol', 'detection', 'configured', 'apiKeyConfigured', 'apiKeyMasked', 'unavailableReason'].includes(key)) continue;
      if (!same(value, original[kind][key])) endpoint[key] = value;
    }
    if (!draft[kind].providerId) {
      if (clearKeys[kind]) endpoint.apiKey = '';
      else if (draft[kind].apiKey?.trim()) endpoint.apiKey = draft[kind].apiKey;
    }
    if (Object.keys(endpoint).length) patch[kind] = endpoint;
  }
  return patch;
}

export function mediaSettingsPayload(draft, original) {
  const settings = {};
  for (const [kind, label] of [['image', '图片'], ['video', '视频'], ['audio', '音频']]) {
    if (draft[kind] === original[kind]) continue;
    const { enabled, routes } = draft[kind];
    if (enabled && !routes.length) throw Error(label + '生成需要至少一个模型。');
    const seen = new Set();
    for (const [index, { providerId, modelId }] of routes.entries()) {
      const prefix = label + '顺位 ' + (index + 1) + ' ';
      if (!providerId || !modelId) throw Error(prefix + '需要同时填写供应商和模型。');
      if ([providerId, modelId].some(id => id !== id.trim())) throw Error(prefix + '的标识首尾不能含空格。');
      const pair = JSON.stringify([providerId, modelId]);
      if (seen.has(pair)) throw Error(prefix + '的模型已配置。');
      seen.add(pair);
    }
    settings[kind] = { enabled, routes };
  }
  return settings;
}
