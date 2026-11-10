import { VOICE_CONFIG_SCHEMA, VOICE_SENSITIVE_PATHS } from './config.mjs';
const namespace = 'benchgo-voice';
export function createVoiceSettingsAdapter(store) {
  return {
    id: namespace,
    async schema() { return [{ namespace, title: '语音', schema: structuredClone(VOICE_CONFIG_SCHEMA), risk: 'ordinary', impact: '即时切换后续语音请求；原语音服务按配置变更取消相关在途音频和通话', sensitivePaths: structuredClone(VOICE_SENSITIVE_PATHS), applies: 'live', pathPolicies: VOICE_SENSITIVE_PATHS.map(path => ({ path, risk: 'blocked', sensitive: true, impact: '凭据只允许通过安全输入入口修改' })).concat([['asr', 'baseURL'], ['tts', 'baseURL'], ['asr', 'providerId'], ['tts', 'providerId'], ['asr', 'realtime']].map(path => ({ path, risk: 'confirm', impact: '改变音频服务的请求与凭据使用目标' }))) }]; },
    async read(ns) { if (ns !== namespace) throw new Error('未知语音设置'); return store.settingsSnapshot(); },
    async normalizeOps(ns, { ops, current }) { if (ns !== namespace) throw new Error('未知语音设置'); return store.normalizeSettingsOps(ops, current); },
    async apply(ns, { ops, expected, signal }) { if (ns !== namespace) throw new Error('未知语音设置'); await store.configure({}, { ops, expected, signal }); return { ...store.settingsSnapshot(), application: { state: 'applied' } }; },
    subscribe: listener => store.subscribe(() => listener({ namespace })),
  };
}
