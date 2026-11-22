import { isManagedRouterGo, modelProtocol } from './provider-access.mjs';
import { createModelCapabilitySettings } from './model-capability-settings.mjs';
import { builtinProvider, isRouterGo, routerGo } from '../shared/builtin-providers.mjs';
import { isModelCapability, normalizeModelCapabilities, structuredCapabilities } from '../shared/model-capabilities.mjs';

const LIMIT = 4 * 1024 * 1024;
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
class ProviderError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

function text(value, label, max = 512) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) throw new ProviderError('Invalid ' + label); return value.trim(); }
function endpoint(value) {
  let url; try { url = new URL(text(value, 'provider URL', 2048)); } catch { throw new ProviderError('Invalid provider URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ProviderError('Provider URL must be HTTP(S), without credentials, query or fragment');
  return url.href.replace(/\/$/u, '');
}
function pathValue(value, path) { for (const part of path || []) { if (forbidden.has(part) || !value || !Object.hasOwn(value, part)) return undefined; value = value[part]; } return value; }
function safeString(value, secret) {
  return typeof value === 'string' && value.trim() && value.length <= 512 && !/[\u0000-\u001f]/u.test(value) && !value.includes(secret);
}
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : undefined;
const names = (rows, secret) => Array.isArray(rows) ? [...new Set(rows.filter(item => safeString(item, secret)).slice(0, 64))] : [];
function constraintValue(value, secret, depth = 0) {
  if (typeof value === 'boolean' || value === null || Number.isFinite(value) || safeString(value, secret)) return value;
  if (!value || typeof value !== 'object' || depth >= 5) return undefined;
  if (Array.isArray(value)) return value.slice(0, 64).map(item => constraintValue(item, secret, depth + 1)).filter(item => item !== undefined);
  return Object.fromEntries(Object.entries(value).slice(0, 64).flatMap(([key, child]) => {
    if (forbidden.has(key) || !safeString(key, secret)) return [];
    const safe = constraintValue(child, secret, depth + 1);
    return safe === undefined ? [] : [[key, safe]];
  }));
}

function modelEntry(model, publicProfile, override, secret) {
  const architecture = model.architecture || model.modalities || {};
  const preferPublic = (published, offered) => {
    const declared = names(published, secret);
    return declared.length ? declared : names(offered, secret);
  };
  const inputModalities = preferPublic(publicProfile?.input_modalities, model.input_modalities ?? architecture.input_modalities ?? architecture.input);
  const outputModalities = preferPublic(publicProfile?.output_modalities, model.output_modalities ?? architecture.output_modalities ?? architecture.output);
  const thinkingLevels = preferPublic(publicProfile?.thinking_levels, model.thinking_levels);
  const declared = names(structuredCapabilities(model, inputModalities, outputModalities), secret).filter(isModelCapability).slice(0, 32);
  const capabilities = override ?? normalizeModelCapabilities(declared);
  const mediaConstraints = model.media_constraints && typeof model.media_constraints === 'object' && !Array.isArray(model.media_constraints)
    ? constraintValue(model.media_constraints, secret) : undefined;
  const contextWindow = positive(publicProfile?.context) ?? positive(model.context_length);
  const maxTokens = positive(publicProfile?.max_output) ?? positive(model.max_output_tokens);
  return {
    id: model.id,
    name: [model.display_name, model.name, publicProfile?.model_name].find(name => safeString(name, secret)) || model.id,
    capabilities, kinds: capabilities.filter(name => name === 'asr' || name === 'tts'),
    ...(override || declared.some(capability => !capabilities.includes(capability)) ? { providerCapabilities: declared } : {}),
    ...(mediaConstraints ? { mediaConstraints } : {}),
    ...(inputModalities.length ? { inputModalities } : {}),
    ...(outputModalities.length ? { outputModalities } : {}),
    ...(thinkingLevels.length ? { thinkingLevels } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
  };
}
async function limitedJson(response, signal) {
  if (Number(response.headers.get('content-length')) > LIMIT) { await response.body?.cancel(); throw new ProviderError('Model catalog exceeds 4 MiB', 502); }
  if (!response.body) throw new ProviderError('Model service returned an empty response', 502);
  const reader = response.body.getReader(), chunks = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) { signal.throwIfAborted(); const { value, done } = await reader.read(); signal.throwIfAborted(); if (done) break; size += value.byteLength; if (size > LIMIT) throw new ProviderError('Model catalog exceeds 4 MiB', 502); chunks.push(value); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ProviderError('Model service returned invalid JSON', 502); }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); }
}
export async function fetchPublicModelProfiles(fetcher, signal) {
  const response = await fetcher('https://routergo.cn/api/x/public/models', { headers: { accept: 'application/json' }, redirect: 'error', signal });
  if (!response.ok) { await response.body?.cancel(); throw Error('模型参数目录暂不可用'); }
  const body = await limitedJson(response, signal);
  if (body?.success !== true || !Array.isArray(body.data) || body.data.length > 20000) throw Error('模型参数目录格式无效');
  return { success: true, data: body.data };
}

let publicProfiles;
function routerGoProfiles() {
  if (!publicProfiles || publicProfiles.fetcher !== globalThis.fetch || publicProfiles.expires <= Date.now()) {
    const current = { fetcher: globalThis.fetch, expires: Date.now() + 5 * 60_000 };
    current.rows = fetchPublicModelProfiles(current.fetcher, AbortSignal.timeout(2500)).then(({ data }) => {
      const byId = new Map();
      for (const row of data) {
        if (typeof row?.model_id === 'string') byId.set(row.model_id, byId.has(row.model_id) ? undefined : row);
      }
      return byId;
    }).catch(() => {
      if (publicProfiles === current) publicProfiles = undefined;
      return new Map();
    });
    publicProfiles = current;
  }
  return publicProfiles.rows;
}

async function discover(config, signal) {
  const timeout = AbortSignal.timeout(20000), requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout; let data;
  try {
    const response = await fetch(config.baseURL + '/models', { headers: { authorization: 'Bearer ' + config.apiKey, accept: 'application/json' }, signal: requestSignal, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw new ProviderError('Model service rejected the request (' + response.status + ')', 502); } data = await limitedJson(response, requestSignal);
  } catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError(requestSignal.aborted ? 'Model request cancelled or timed out' : 'Unable to reach the model service', 502); }
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : null;
  if (!rows || rows.length > 20000) throw new ProviderError('Model service returned an invalid catalog', 502);
  return rows;
}

function catalogModels(rows, publicRows, labels, apiKey) {
  const seen = new Set(), models = [];
  for (const row of rows) {
    if (!safeString(row?.id, apiKey) || seen.has(row.id)) continue;
    seen.add(row.id);
    models.push(modelEntry(row, publicRows?.get(row.id), labels?.get(row.id), apiKey));
  }
  return models;
}

/** A new account credential has no provider profile until discovery succeeds. */
export async function discoverRouterGoModels(apiKey, signal) {
  const [rows, publicRows] = await Promise.all([discover({ baseURL: routerGo.baseURL, apiKey }, signal), routerGoProfiles()]);
  const models = catalogModels(rows, publicRows, undefined, apiKey);
  if (rows.length && !models.length) throw new ProviderError('RouterGo model service returned invalid model IDs', 502);
  return models;
}

export function createModelProviders(ctx, { directory = ctx.get?.('benchgo')?.directory } = {}) {
  const entries = () => ctx.llm.listConfigurableProviders();
  const overrides = createModelCapabilitySettings(directory);
  const routerGoModels = new Map();
  const requireProvider = id => {
    const row = entries().find(entry => entry.provider === id);
    if (!row) throw new ProviderError('Provider is not configured', 404);
    return row;
  };
  const document = ns => ctx.settings.describe().find(row => row.ns === ns);
  const profile = entry => pathValue(document(entry.settingsNs)?.value, entry.settingsPath) || {};
  const address = (entry, value) => value.baseURL || entry.defaultBaseURL || '';
  const protocol = (entry, value) => value.api || value.protocol || entry.protocol || null;
  const credentialRefs = (entry, value) => (value.apiKeyEnv ? [value.apiKeyEnv] : (entry.nativeAuth?.env || []).filter(ref => /api[_-]?key/iu.test(ref))).filter(ref => !/oauth/iu.test(ref));
  const credential = async (entry, value) => {
    for (const ref of credentialRefs(entry, value)) {
      const hit = await ctx.credentials.resolve(ref);
      if (hit?.value && !/^sk-ant-oat/iu.test(hit.value)) return { ref, value: hit.value };
    }
  };
  const access = async (entry, value) => {
    const configured = !!await credential(entry, value);
    return {
      id: entry.provider,
      authMode: configured ? 'api' : 'unconfigured',
      configured,
      ...(isManagedRouterGo(entry.provider, address(entry, value), value.apiKeyEnv) ? { managedRouterGo: true } : {}),
      modelProtocol: modelProtocol(protocol(entry, value)),
    };
  };
  const service = {
    async list() {
      // describe() projects every plugin schema/config; do it once per directory read.
      const documents = new Map(ctx.settings.describe().map(row => [row.ns, row.value]));
      const list = await Promise.all(entries().map(async entry => {
        const value = pathValue(documents.get(entry.settingsNs), entry.settingsPath) || {}, baseURL = address(entry, value), identity = await access(entry, value);
        if (!baseURL || !identity.configured) return null;
        return { ...identity, name: value.displayName || builtinProvider(entry.provider)?.name || entry.displayName || entry.provider, baseURL: endpoint(baseURL), protocol: protocol(entry, value), ...(entry.declared === true && !builtinProvider(entry.provider) ? { declared: true } : {}) };
      }));
      return list.filter(Boolean).sort((a, b) => Number(isRouterGo(b.id)) - Number(isRouterGo(a.id)) || a.name.localeCompare(b.name));
    },
    async describeAccess(id) {
      const entry = requireProvider(id);
      return access(entry, profile(entry));
    },
    async resolve(id) {
      const { baseURL, apiKey } = await service.describeRoute(id);
      return { baseURL, apiKey };
    },
    async describeRoute(id, { credentials = true } = {}) {
      const entry = requireProvider(id);
      const value = profile(entry);
      const auth = credentials ? await credential(entry, value) : undefined;
      if (credentials && !auth) throw new ProviderError('Provider API credential is not configured', 409);
      const wire = protocol(entry, value);
      const baseURL = endpoint(address(entry, value));
      return { baseURL, protocol: wire, modelProtocol: modelProtocol(wire), credentialRef: auth?.ref ?? credentialRefs(entry, value).join('|'), ...(isManagedRouterGo(id, baseURL, value.apiKeyEnv) ? { managedRouterGo: true } : {}), ...(auth ? { apiKey: auth.value } : {}) };
    },
    async routerGoProtocolModels(id) {
      const config = await service.describeRoute(id);
      if (!config.managedRouterGo) throw new ProviderError('RouterGo account is not connected', 409);
      let current = routerGoModels.get(id);
      if (current?.credentialRef !== config.credentialRef || current?.apiKey !== config.apiKey || current.expires <= Date.now()) {
        current = { credentialRef: config.credentialRef, apiKey: config.apiKey, expires: Infinity };
        const pending = current;
        current.models = discover(config).then(rows => new Map(catalogModels(rows, undefined, undefined, config.apiKey).map(row => [row.id, row]))).then(models => {
          pending.expires = Date.now() + 30_000;
          return models;
        }).catch(error => {
          if (routerGoModels.get(id) === pending) routerGoModels.delete(id);
          throw error;
        });
        routerGoModels.set(id, current);
      }
      const [models, labels] = await Promise.all([current.models, overrides.list(id)]);
      const latest = await service.describeRoute(id);
      if (!latest.managedRouterGo || latest.credentialRef !== current.credentialRef || latest.apiKey !== current.apiKey) throw new ProviderError('Provider changed; refresh the model list again', 409);
      if (!labels.length) return models;
      const effective = new Map(models);
      for (const { modelId, capabilities } of labels) {
        const remote = models.get(modelId);
        if (remote) effective.set(modelId, { ...remote, capabilities,
          providerCapabilities: remote.providerCapabilities ?? remote.capabilities,
          kinds: capabilities.filter(name => name === 'asr' || name === 'tts'),
        });
      }
      return effective;
    },
    async models(id, signal) {
      const config = await service.describeRoute(id);
      const configuredModels = profile(requireProvider(id)).models;
      const configured = !config.managedRouterGo && Array.isArray(configuredModels) ? configuredModels : [];
      const catalog = discover(config, signal).catch(error => {
        if (!configured.length) throw error;
        signal?.throwIfAborted();
        return [];
      });
      const [rows, labels, publicRows] = await Promise.all([
        catalog,
        overrides.list(id),
        (isRouterGo(id) && config.baseURL === routerGo.baseURL) || configured.length > 0
          ? routerGoProfiles() : undefined,
      ]);
      signal?.throwIfAborted();
      const current = await service.describeRoute(id).catch(() => null);
      if (!current || ['baseURL', 'protocol', 'credentialRef', 'apiKey'].some(key => current[key] !== config[key])) throw new ProviderError('Provider changed; refresh the model list again', 409);
      const listed = new Set(rows.map(row => row?.id));
      const manual = configured.filter(row => row && !listed.has(row.id)).map(row => ({
        id: row.id, name: row.name, input_modalities: row.input ?? row.inputModalities,
        context_length: row.contextWindow, max_output_tokens: row.maxTokens,
      }));
      return catalogModels([...rows, ...manual], publicRows, new Map(labels.map(row => [row.modelId, row.capabilities])), config.apiKey);
    },
    async modelCapabilities(id) {
      requireProvider(id);
      return overrides.list(id);
    },
    async saveModelCapabilities(id, modelId, capabilities) {
      requireProvider(id);
      return overrides.save(id, modelId, capabilities);
    },
  }; return service;
}
