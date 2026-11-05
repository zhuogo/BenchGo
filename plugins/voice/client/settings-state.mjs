const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function voiceSettingsPatch(draft, original, clearKeys = {}) {
  const patch = {};
  for (const kind of ['asr', 'tts']) {
    const protocols = kind === 'asr' ? ['transcriptions-sse', 'transcriptions', 'openai-websocket'] : ['speech'];
    if (draft[kind]?.protocol && !protocols.includes(draft[kind].protocol)) throw Error(`${kind.toUpperCase()} 当前协议已不支持，请显式选择 OpenAI 兼容协议后保存。`);
  }
  for (const key of ['dictation', 'readAloud', 'call']) if (draft[key] !== original[key]) patch[key] = draft[key];
  for (const kind of ['asr', 'tts']) {
    const endpoint = {};
    for (const [key, value] of Object.entries(draft[kind])) {
      if (key === 'apiKey') continue;
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
