import { VOICE_CONFIG_SCHEMA, VOICE_SENSITIVE_PATHS } from './config.mjs';
const namespace = 'benchgo-voice';
export function createVoiceSettingsAdapter(store) {
  return {
    id: namespace,
    async schema() { return [{ namespace, title: '语音', schema: structuredClone(VOICE_CONFIG_SCHEMA), risk: 'ordinary', impact: '语速修改应用于后续合成片段；交互模型变化结束受影响通话；其他语音变更按媒体范围取消在途请求', sensitivePaths: structuredClone(VOICE_SENSITIVE_PATHS), applies: 'live', pathPolicies: VOICE_SENSITIVE_PATHS.map(path => ({ path, risk: 'blocked', sensitive: true, impact: '凭据只允许通过安全输入入口修改' })).concat([['asr', 'baseURL'], ['tts', 'baseURL'], ['asr', 'providerId'], ['tts', 'providerId'], ['asr', 'realtime'], ['conversation', 'providerId']].map(path => ({ path, risk: 'confirm', impact: '改变音频或交互服务的请求与凭据使用目标' }))) }]; },
    async read(ns) { if (ns !== namespace) throw new Error('未知语音设置'); return store.settingsSnapshot(); },
    async normalizeOps(ns, { ops, current }) { if (ns !== namespace) throw new Error('未知语音设置'); return store.normalizeSettingsOps(ops, current); },
    async apply(ns, { ops, expected, signal }) { if (ns !== namespace) throw new Error('未知语音设置'); await store.configure({}, { ops, expected, signal }); return { ...store.settingsSnapshot(), application: { state: 'applied' } }; },
    subscribe: listener => store.subscribe(() => listener({ namespace })),
  };
}
