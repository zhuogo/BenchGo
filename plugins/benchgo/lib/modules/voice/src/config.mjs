import { HttpError } from '../../../../shared/http.mjs';
import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { prepareVoiceDataDirectory } from '../../../../src/data-directory.mjs';
import { applySettingsOps, assertSettingsExpected, normalizeSettingsOps, notifySettings, settingsSnapshot } from '../../../../shared/settings-adapter-utils.mjs';
import { VOICE_API_TYPES, VOICE_PROTOCOLS } from '../shared/protocol-catalog.mjs';

export class VoiceError extends HttpError {}
const object = value => value && typeof value === 'object' && !Array.isArray(value);
// Requests use a concrete saved wire format. Matching is an explicit settings action.
export const DEFAULT_TTS_SPEED = 1.2;
const TTS_SPEED_MIN = 0.25, TTS_SPEED_MAX = 4;
const routingString = maxLength => ({ type: 'string', maxLength, pattern: '^[^\\u0000-\\u001f\\u007f]*$' });
const apiTypes = ['', ...VOICE_API_TYPES.map(item => item.id).filter(id => id !== 'auto')];
const protocolIds = kind => ['', ...VOICE_PROTOCOLS.filter(item => item.kind === kind && item.id !== 'auto').map(item => item.id)];
const providerProperties = { providerId: routingString(200), baseURL: routingString(2048), apiKey: { ...routingString(4096), writeOnly: true }, model: routingString(200), apiType: { type: 'string', enum: apiTypes } };
export const defaultListening = () => ({ enabled: false, endpoint: '', model: '', apiKey: '', wakeSource: 'custom', wakeWord: '' });
export const VOICE_CONFIG_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  dictation: { type: 'boolean', default: false }, readAloud: { type: 'boolean', default: false }, call: { type: 'boolean', default: false },
  conversation: { type: 'object', additionalProperties: false, properties: { providerId: routingString(200), model: routingString(200) } },
  listening: { type: 'object', additionalProperties: false, properties: { enabled: { type: 'boolean', default: false }, endpoint: routingString(2048), model: routingString(200), apiKey: { ...routingString(4096), writeOnly: true }, wakeSource: { type: 'string', enum: ['custom', 'superagent'] }, wakeWord: routingString(100) } },
  asr: { type: 'object', additionalProperties: false, properties: { ...providerProperties, protocol: { type: 'string', enum: protocolIds('asr') }, realtime: { type: 'object', additionalProperties: false, properties: { url: routingString(2048), query: { type: 'object', maxProperties: 32, additionalProperties: routingString(512) } } } } },
  tts: { type: 'object', additionalProperties: false, properties: { ...providerProperties, protocol: { type: 'string', enum: protocolIds('tts') }, voice: routingString(200), speed: { type: 'number', minimum: TTS_SPEED_MIN, maximum: TTS_SPEED_MAX, multipleOf: 0.01, default: DEFAULT_TTS_SPEED }, stream: { type: 'boolean', default: true } } },
} };
export const VOICE_SENSITIVE_PATHS = [['asr', 'apiKey'], ['tts', 'apiKey'], ['listening', 'apiKey']];
const defaults = () => ({ dictation: false, readAloud: false, call: false, conversation: { providerId: '', model: '' }, listening: defaultListening(), asr: { baseURL: '', apiKey: '', model: '', apiType: '', protocol: '' }, tts: { baseURL: '', apiKey: '', model: '', apiType: '', protocol: '', voice: '', speed: DEFAULT_TTS_SPEED, stream: true } });
const string = (value, label, limit) => {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value)) throw new VoiceError(`Invalid ${label}`);
  return value.trim();
};
function endpoint(value) {
  value = string(value, 'baseURL', 2048);
  if (!value) return '';
  let url; try { url = new URL(value); } catch { throw new VoiceError('Invalid baseURL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new VoiceError('baseURL must be an HTTP(S) API base without credentials, query or fragment');
  return url.href.replace(/\/+$/u, '');
}
export function validateListeningEndpoint(value) {
  const clean = string(value, 'decision endpoint', 2048);
  if (!clean) return '';
  let parsed; try { parsed = new URL(clean); } catch { throw new VoiceError('决策接口地址无效'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new VoiceError('决策接口地址必须是完整 HTTP(S) 地址，不能包含凭据、查询或片段');
  return clean;
}
const sensitiveQuery = /api.?key|authorization|token|secret|password|credential|^key$|^bearer$/iu;
/** Public routing metadata only: credentials belong exclusively in server headers. */
export function validateRealtime(value, apiKey = '') {
  if (!object(value) || Object.keys(value).some(key => !['url', 'query'].includes(key))) throw new VoiceError('Invalid realtime ASR configuration');
  const result = { url: '', query: {} };
  const parameter = (key, val) => {
    if (!/^[a-zA-Z0-9_.~-]{1,80}$/u.test(key) || sensitiveQuery.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new VoiceError('Invalid realtime ASR query key');
    const clean = string(val, 'realtime ASR query', 512);
    if (apiKey && clean.includes(apiKey)) throw new VoiceError('Realtime ASR routing must not contain API credentials');
    return clean;
  };
  if (value.url) {
    const raw = string(value.url, 'realtime ASR URL', 2048);
    let url; try { url = new URL(raw); } catch { throw new VoiceError('Invalid realtime ASR URL'); }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new VoiceError('Realtime ASR URL must be HTTP(S) or WS(S), without credentials or fragment');
    for (const [key, val] of url.searchParams) parameter(key, val);
    if (apiKey && decodeURIComponent(url.href).includes(apiKey)) throw new VoiceError('Realtime ASR routing must not contain API credentials');
    result.url = url.href;
  } else if (Object.hasOwn(value, 'url') && typeof value.url !== 'string') throw new VoiceError('Invalid realtime ASR URL');
  if (Object.hasOwn(value, 'query')) {
    if (!object(value.query) || Object.keys(value.query).length > 32) throw new VoiceError('Invalid realtime ASR query');
    for (const [key, val] of Object.entries(value.query)) result.query[key] = parameter(key, val);
  }
  return result;
}
// Model IDs belong to the selected provider; an apparent alias may be a distinct route.
export function normalizeTtsModel(model) {
  return String(model || '').trim();
}
export function normalizeAsrModel(model) {
  return String(model || '').trim();
}
export function normalizeTtsSpeed(value) {
  if (value === undefined) return DEFAULT_TTS_SPEED;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < TTS_SPEED_MIN || value > TTS_SPEED_MAX || Math.abs(Math.round(value * 100) - value * 100) > 1e-9) throw new VoiceError('Invalid TTS speed');
  return Math.round(value * 100) / 100;
}
export function updateConfig(current, patch, { loading = false } = {}) {
  if (!object(patch)) throw new VoiceError('Expected config object');
  if (Object.keys(patch).some(key => !Object.hasOwn(VOICE_CONFIG_SCHEMA.properties, key))) throw new VoiceError('Unknown config field');
  const next = structuredClone(current);
  next.conversation ??= { providerId: '', model: '' };
  next.listening ??= defaultListening();
  if (Object.hasOwn(patch, 'listening')) {
    if (!object(patch.listening)) throw new VoiceError('Invalid listening configuration');
    for (const [key, value] of Object.entries(patch.listening)) {
      if (['configured', 'apiKeyConfigured', 'apiKeyMasked', 'unavailableReason', 'wakeAvailable', 'wakeWordResolved', 'superagentName', 'superagentAvailable'].includes(key)) continue;
      if (!Object.hasOwn(VOICE_CONFIG_SCHEMA.properties.listening.properties, key)) throw new VoiceError('Unknown listening field');
      if (key === 'enabled') { if (typeof value !== 'boolean') throw new VoiceError('Invalid listening enabled'); next.listening.enabled = value; continue; }
      if (key === 'wakeSource' && !['custom', 'superagent'].includes(value)) throw new VoiceError('Invalid wake word source');
      const clean = key === 'endpoint' ? validateListeningEndpoint(value) : string(value, key, key === 'apiKey' ? 4096 : key === 'wakeWord' ? 100 : 200);
      if (key === 'model' && clean !== value) throw new VoiceError('决策模型 ID 首尾不能含空格');
      next.listening[key] = clean;
    }
  }
  if (Object.hasOwn(patch, 'conversation')) {
    if (!object(patch.conversation)) throw new VoiceError('Invalid conversation model');
    for (const [key, value] of Object.entries(patch.conversation)) {
      if (['configured', 'unavailableReason'].includes(key)) continue;
      if (!['providerId', 'model'].includes(key)) throw new VoiceError('Unknown conversation model field');
      next.conversation[key] = string(value, key, 200);
    }
    if (!!next.conversation.providerId !== !!next.conversation.model) throw new VoiceError('请同时选择通话交互模型的供应商与模型，或全部留空使用原会话');
  }
  if (next.tts && !Object.hasOwn(next.tts, 'stream')) next.tts.stream = true;
  if (next.tts && !Object.hasOwn(next.tts, 'speed')) next.tts.speed = DEFAULT_TTS_SPEED;
  for (const key of ['dictation', 'readAloud', 'call']) if (Object.hasOwn(patch, key)) {
    if (typeof patch[key] !== 'boolean') throw new VoiceError(`Invalid ${key}`);
    next[key] = patch[key];
  }
  for (const kind of ['asr', 'tts']) if (Object.hasOwn(patch, kind)) {
    if (!object(patch[kind])) throw new VoiceError(`Invalid ${kind}`);
    for (const [key, value] of Object.entries(patch[kind])) {
      // Read-only metadata may be round-tripped by settings forms.
      if (['configured', 'apiKeyConfigured', 'apiKeyMasked', 'unavailableReason', 'resolvedProtocol', 'detection'].includes(key)) continue;
      if (!Object.hasOwn(VOICE_CONFIG_SCHEMA.properties[kind].properties, key)) throw new VoiceError(`Unknown ${kind} field`);
      if (kind === 'tts' && key === 'stream') { if (typeof value !== 'boolean') throw new VoiceError('Invalid TTS stream'); next.tts.stream = value; continue; }
      if (key === 'realtime') { next.asr.realtime = validateRealtime(value); continue; }
      if (kind === 'tts' && key === 'speed') { next.tts.speed = normalizeTtsSpeed(value); continue; }
      if (key === 'protocol' && !loading && (value === 'auto' || value !== current[kind]?.protocol && !VOICE_CONFIG_SCHEMA.properties[kind].properties.protocol.enum.includes(value))) throw new VoiceError(`Unknown ${kind.toUpperCase()} protocol`);
      if (key === 'apiType' && !apiTypes.includes(value) && !(loading && value === 'auto')) throw new VoiceError('Unknown voice API type');
      const normalized = key === 'baseURL' ? endpoint(value) : string(value, key, key === 'apiKey' ? 4096 : 200);
      next[kind][key] = key === 'model' ? (kind === 'asr' ? normalizeAsrModel(normalized) : normalizeTtsModel(normalized)) : normalized;
    }
    const changedProvider = Object.hasOwn(patch[kind], 'providerId') && (current[kind].providerId || '') !== next[kind].providerId || Object.hasOwn(patch[kind], 'baseURL') && !next[kind].providerId && current[kind].baseURL !== next[kind].baseURL;
    if (changedProvider) {
      if (kind === 'asr' && !Object.hasOwn(patch.asr, 'realtime')) delete next.asr.realtime;
      if (!Object.hasOwn(patch[kind], 'protocol')) next[kind].protocol = '';
      if (!Object.hasOwn(patch[kind], 'apiType')) next[kind].apiType = '';
      if (kind === 'tts' && !Object.hasOwn(patch.tts, 'voice')) next.tts.voice = '';
    }
    if (next[kind].providerId) { next[kind].apiKey = ''; next[kind].baseURL = ''; }
    if (kind === 'asr' && next.asr.realtime) next.asr.realtime = validateRealtime(next.asr.realtime, next.asr.apiKey);
  }
  return next;
}
/** Missing selections remain unmatched; old explicit values are never rewritten. */
export function migrateLegacyConfig(value) {
  const next = structuredClone(value);
  if (next.asr && !Object.hasOwn(next.asr, 'protocol')) next.asr.protocol = '';
  if (next.tts && !Object.hasOwn(next.tts, 'protocol')) next.tts.protocol = '';
  return next;
}
export function publicConfig(config) {
  return Object.fromEntries(Object.entries({ ...config, listening: config.listening || defaultListening() }).map(([key, value]) => {
    if (key === 'conversation') return [key, { ...value, configured: !!(value.providerId && value.model) }];
    if (key === 'listening') { const { apiKey, ...safe } = value; return [key, { ...safe, configured: !!(value.endpoint && apiKey), apiKeyConfigured: !!apiKey, apiKeyMasked: apiKey ? '••••••••' : '' }]; }
    if (!['asr', 'tts'].includes(key)) return [key, value];
    const { apiKey, ...safe } = value;
    return [key, { ...safe, configured: !!((value.providerId || value.baseURL) && value.model), apiKeyConfigured: !!apiKey, apiKeyMasked: apiKey ? '••••••••' : '' }];
  }));
}
function managedConfig(current, ops) {
  const submitted = applySettingsOps(current, ops, { sensitivePaths: VOICE_SENSITIVE_PATHS, base: defaults() });
  const next = updateConfig(current, submitted), fallback = defaults();
  for (const key of ['dictation', 'readAloud', 'call']) if (!Object.hasOwn(submitted, key)) next[key] = fallback[key];
  for (const kind of ['asr', 'tts', 'conversation', 'listening']) for (const key of Object.keys(next[kind])) if (!Object.hasOwn(submitted[kind] || {}, key)) {
    if (Object.hasOwn(fallback[kind], key)) next[kind][key] = fallback[kind][key]; else delete next[kind][key];
  }
  if (VOICE_SENSITIVE_PATHS.some(([kind, key]) => next[kind][key] !== current[kind][key])) throw Object.assign(new VoiceError('该供应商变更会删除现有凭据，请先通过安全输入入口处理凭据', 409), { code: 'SETTINGS_PATH_BLOCKED' });
  return next;
}
function managedPublic(config) { const value = structuredClone(config); for (const [kind, key] of VOICE_SENSITIVE_PATHS) delete value[kind][key]; return value; }
export class VoiceConfig {
  constructor({ dataDir } = {}) {
    this.defaultDataDirectory = dataDir === undefined;
    dataDir ??= join(homedir(), '.benchgo', 'voice');
    this.directory = dataDir; this.path = join(dataDir, 'config.json'); this.value = defaults(); this.writes = Promise.resolve(); this.listeners = new Set(); this.settingsEpoch = randomUUID(); this.settingsRevision = 0;
  }
  async open() {
    if (this.defaultDataDirectory) await prepareVoiceDataDirectory();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { this.value = updateConfig(defaults(), migrateLegacyConfig(JSON.parse(await readFile(this.path, 'utf8'))), { loading: true }); await chmod(this.path, 0o600); }
    catch (error) { if (error.code !== 'ENOENT') throw new VoiceError('Voice configuration could not be loaded', 500); }
    return this;
  }
  snapshot() { return publicConfig(this.value); }
  settingsSnapshot() {
    const value = structuredClone(this.value), secrets = VOICE_SENSITIVE_PATHS.map(path => ({ path, set: !!value[path[0]][path[1]] }));
    for (const [kind, key] of VOICE_SENSITIVE_PATHS) delete value[kind][key];
    return settingsSnapshot(value, `${this.settingsEpoch}:${this.settingsRevision}`, { secrets, base: managedPublic(defaults()) });
  }
  normalizeSettingsOps(ops, current) { return normalizeSettingsOps(current.value, ops, managedPublic(managedConfig(this.value, ops)), { base: current.base }); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  configure(patch, options = {}) {
    const operation = this.writes.then(async () => {
      if (options.expected || options.ops) assertSettingsExpected(this.settingsSnapshot(), options.expected, options.signal);
      // Ops start from the original private object, preserving credentials without exposing them.
      const next = options.ops ? managedConfig(this.value, options.ops) : updateConfig(this.value, patch);
      if (JSON.stringify(next) === JSON.stringify(this.value)) return this.snapshot();
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 }); await rename(temp, this.path); }
      finally { await rm(temp, { force: true }); }
      this.value = next; this.settingsRevision++; notifySettings(this.listeners); return this.snapshot();
    });
    this.writes = operation.catch(() => {}); return operation;
  }
}
