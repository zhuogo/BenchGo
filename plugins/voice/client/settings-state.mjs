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

export function generatedMediaDraft(value) {
  return { enabled: value !== null && value !== undefined, providerId: value?.providerId || '', modelId: value?.modelId || '', protocol: value?.protocol || 'openai-compatible' };
}

export function generatedMediaPatch(kind, draft, original) {
  if (!['image', 'video'].includes(kind)) throw Error('不支持的媒体类型');
  if (!draft.enabled) return { [kind]: null };
  for (const key of ['providerId', 'modelId']) {
    if (!draft[key] || draft[key] !== draft[key].trim()) throw Error('请选择供应商和模型，标识首尾不能含空格');
  }
  const selected = {};
  for (const key of ['providerId', 'modelId', 'protocol']) if (!original || draft[key] !== original[key]) selected[key] = draft[key];
  if (original?.providerId !== draft.providerId && original?.credentialRef) selected.credentialRef = '';
  return { [kind]: selected };
}
