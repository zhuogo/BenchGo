import { validatePetProfile } from './pet-profile.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { resolve, join } from 'node:path';
import { ASSISTANT_DOCUMENTS, createAssistantDocuments, documentHash } from './documents.mjs';
import { createAssistantMemory } from './memory.mjs';
import { createAssistantReview } from './review.mjs';
import { createLearningCounters } from './learning-counters.mjs';
import { createOwnedSkills } from './owned-skills.mjs';
import { createAssistantLedger } from './ledger.mjs';
import { createAssistantConnections } from './connections.mjs';
import { loadChannelModules } from './channel-catalog.mjs';
import { createAssistantOrchestrationStore } from './orchestration-store.mjs';
import { createAssistantIdentity, identityName, withIdentityName } from './identity.mjs';

// Windows keeps an open SQLite handle from being removed during test/profile
// replacement. Keep one live store per data directory and release the previous
// handle before opening a replacement store.

const queues = new Map();
const copy = (value) => structuredClone(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function merge(base, patch) {
  const result = copy(base);
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Invalid field');
    result[key] = object(value) && object(result[key]) ? merge(result[key], value) : copy(value);
  }
  return result;
}
function noSecrets(value, depth = 0) {
  if (depth > 16) throw new Error('Configuration nesting exceeds limit');
  if (typeof value === 'string' && (value.length > 16000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))) throw new Error('Invalid configuration string');
  if (!object(value) && !Array.isArray(value)) return;
  if (Object.keys(value).length > 256) throw new Error('Configuration contains too many fields');
  for (const [key, entry] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key) || key.length > 128) throw new Error('Invalid configuration field');
    if (/^(api[-_]?key|secret|password|token|accessToken|authorization|headers)$/i.test(key)) throw new Error('Use credentialRef instead of storing credentials');
    noSecrets(entry, depth + 1);
  }
}
function validateModel(value) {
  if (!object(value) || typeof value.providerId !== 'string' || !value.providerId.trim() || typeof value.modelId !== 'string' || !value.modelId.trim()) throw new Error('Model requires providerId and modelId');
  for (const key of ['providerId', 'modelId']) if (value[key].length > 512 || value[key] !== value[key].trim() || /[\u0000-\u001f\u007f]/u.test(value[key])) throw new Error(`Invalid ${key}`);
}
export function validateAssistantModels(models) {
  if (!Array.isArray(models) || models.length > 32) throw new Error('Invalid model queue');
  noSecrets(models);
  const seen = new Set();
  for (const model of models) {
    validateModel(model);
    if (model.credentialRef !== undefined) throw new Error('文本模型凭据请在供应商设置中配置');
    if (model.options !== undefined) {
      if (!object(model.options) || Object.keys(model.options).some(key => !['reasoningEffort', 'maxTokens'].includes(key))) throw new Error('不支持的文本模型选项');
      if (model.options.reasoningEffort !== undefined && (typeof model.options.reasoningEffort !== 'string' || !model.options.reasoningEffort || model.options.reasoningEffort.length > 100)) throw new Error('无效推理选项');
      if (model.options.maxTokens !== undefined && (!Number.isSafeInteger(model.options.maxTokens) || model.options.maxTokens <= 0)) throw new Error('无效输出长度');
    }
    const key = JSON.stringify([model.providerId, model.modelId]);
    if (seen.has(key)) throw new Error('Duplicate model in queue');
    seen.add(key);
  }
}
export const ASSISTANT_AUXILIARY_CAPABILITIES = Object.freeze(['vision', 'compression', 'summary', 'review']);
export function validateAssistantAuxiliary(value) {
  if (value === null) return;
  if (!object(value) || Object.keys(value).some(key => !['models', 'capabilities'].includes(key))) throw new Error('Invalid auxiliary model configuration');
  validateAssistantModels(value.models);
  if (!value.models.length) throw new Error('Auxiliary model requires a primary model');
  if (!Array.isArray(value.capabilities) || value.capabilities.some(capability => !ASSISTANT_AUXILIARY_CAPABILITIES.includes(capability))
    || new Set(value.capabilities).size !== value.capabilities.length) throw new Error('Invalid auxiliary model capabilities');
}
function validateConfig(value) {
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('Unsupported assistant configuration version');
  if (value.cardHtml === undefined) value.cardHtml = null;
  if (value.cardMotion === undefined) value.cardMotion = true;
  if (value.pet === undefined) value.pet = null;
  if (value.petPrevious === undefined) value.petPrevious = null;
  if (value.petHasPrevious === undefined) value.petHasPrevious = false;
  validatePetProfile(value.pet);
  validatePetProfile(value.petPrevious);
  if (typeof value.petHasPrevious !== 'boolean') throw new Error('Invalid pet history');
  if (value.video === undefined) value.video = null;
  if (value.auxiliary === undefined) value.auxiliary = null;
  if (value.workerModels === undefined) value.workerModels = [];
  // Retired credential pools must not survive a legacy configuration load.
  delete value.keyPools;
  if (value.workerConcurrency === undefined) value.workerConcurrency = 2;
  if (!Number.isSafeInteger(value.workerConcurrency) || value.workerConcurrency < 1) throw new Error('Worker 并发数量必须是正整数');
  validateAssistantModels(value.models);
  validateAssistantModels(value.workerModels);
  validateAssistantAuxiliary(value.auxiliary);
  noSecrets(value);
  if (typeof value.name !== 'string' || value.name.length > 100) throw new Error('Invalid assistant name');
  if (value.cardHtml !== undefined && value.cardHtml !== null && typeof value.cardHtml !== 'string') throw new Error('Invalid assistant cardHtml');
  if (typeof value.cardHtml === 'string' && !value.cardHtml.trim()) value.cardHtml = null;
  if (typeof value.cardMotion !== 'boolean') throw new Error('Invalid assistant cardMotion');
  for (const field of ['image', 'video', 'tts', 'asr']) if (value[field] !== null) {
    validateModel(value[field]);
    if (value[field].credentialRef && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value[field].credentialRef)) throw new Error('Invalid credentialRef');
    if (field === 'asr' && value.asr.language !== undefined) throw new Error('当前语音识别适配器不支持独立语言参数');
    for (const key of ['protocol', 'voice', 'language', 'size', 'quality', 'credentialRef']) if (value[field][key] !== undefined && (typeof value[field][key] !== 'string' || value[field][key].length > 512 || /[\u0000-\u001f\u007f]/u.test(value[field][key]))) throw new Error(`Invalid ${field} ${key}`);
    if (field === 'tts' && value.tts.speed !== undefined && (typeof value.tts.speed !== 'number' || !Number.isFinite(value.tts.speed) || value.tts.speed < 0.25 || value.tts.speed > 4)) throw new Error('Invalid TTS speed');
  }
}
function validateState(value) {
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('Unsupported assistant state version');
  for (const thread of value.threads || []) delete thread.models;
}
async function json(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return copy(fallback); throw error; }
}
async function atomic(path, content) {
  await writeFileAtomic(path, content, { mode: 0o600 });
}
function serialize(key, operation) {
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  queues.set(key, current);
  return current.finally(() => { if (queues.get(key) === current) queues.delete(key); });
}
function checkRevision(value, revision) {
  if (revision !== undefined && revision !== value.revision) {
    const error = new Error('Assistant data changed; reload before saving');
    error.code = 'REVISION_CONFLICT';
    error.revision = value.revision;
    throw error;
  }
}

export async function createAssistantStore({ dataDirectory } = {}) {
  await loadChannelModules();
  if (typeof dataDirectory !== 'string' || !dataDirectory) throw new Error('dataDirectory is required');
  const rootDirectory = resolve(dataDirectory, 'assistant');
  const directory = rootDirectory;
  const paths = { directory, workspace: join(directory, 'workspace'), config: join(directory, 'config.json'), state: join(directory, 'state.json'), identity: join(directory, 'IDENTITY.md'), user: join(directory, 'USER.md'), memory: join(directory, 'memory'), database: join(directory, 'assistant.db') };
  await mkdir(paths.workspace, { recursive: true });
  await mkdir(paths.memory, { recursive: true });
  const defaults = { schemaVersion: 1, revision: 0, name: '', cardHtml: null, models: [], image: null, video: null, tts: null, asr: null, capabilities: { proactive: false } };
  const initialState = { schemaVersion: 1, revision: 0, mainSessionId: null, threads: [] };
  async function readVersioned(path, fallback, validate) {
    const value = await json(path, fallback);
    validate(value);
    return value;
  }
  function update(path, fallback, validate, patch, { revision } = {}) {
    return serialize(directory, async () => {
      if (!object(patch) || 'schemaVersion' in patch || 'revision' in patch) throw new Error('Invalid update');
      const current = await readVersioned(path, fallback, validate);
      checkRevision(current, revision);
      const next = merge(current, patch);
      next.revision = current.revision + 1;
      validate(next);
      await atomic(path, JSON.stringify(next, null, 2) + '\n');
      return copy(next);
    });
  }
  await serialize(directory, async () => {
    const legacyState = await json(paths.state, initialState);
    if (legacyState.threads?.some(thread => Object.hasOwn(thread, 'models'))) {
      validateState(legacyState);
      legacyState.revision++;
      await atomic(paths.state, JSON.stringify(legacyState, null, 2) + '\n');
    }
    for (const [path, fallback, validate] of [[paths.config, defaults, validateConfig], [paths.state, initialState, validateState]]) {
      const value = await readVersioned(path, fallback, validate);
      try { await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  });
  const documents = await createAssistantDocuments({ directory });
  const readConfig = () => readVersioned(paths.config, defaults, validateConfig);
  const identityService = createAssistantIdentity({ documents });
  async function getConfig() {
    const [config, document] = await Promise.all([readConfig(), documents.read('IDENTITY.md')]);
    const name = identityName(document.content);
    return { ...config, name: name ?? config.name };
  }
  function updateConfig(patch, options = {}) {
    return serialize(directory, async () => {
      if (!object(patch) || 'schemaVersion' in patch || 'revision' in patch) throw new Error('Invalid update');
      if (!options.petWrite && ['pet', 'petPrevious', 'petHasPrevious'].some(key => Object.hasOwn(patch, key))) throw new Error('请通过宠物预览与应用操作修改形象');
      if (Object.hasOwn(patch, 'keyPools') && (!Array.isArray(patch.keyPools) || patch.keyPools.length)) throw Object.assign(new Error('凭据路由池已移除，请使用首选和备用模型'), { code: 'KEY_POOL_REMOVED', status: 400 });
      const current = await readConfig();
      checkRevision(current, options.revision);
      const next = merge(current, patch);
      if (options.petWrite && Object.hasOwn(patch, 'pet')) { next.pet = copy(patch.pet); next.petPrevious = copy(current.pet); next.petHasPrevious = true; }
      next.revision = current.revision + 1;
      validateConfig(next);
      // Keep the config fallback stable; every explicit name write goes through IDENTITY.
      if (Object.hasOwn(patch, 'name')) await identityService.rename(patch.name, { expectedHash: options.expectedHash });
      next.name = current.name;
      await atomic(paths.config, JSON.stringify(next, null, 2) + '\n');
      return getConfig();
    });
  }
  let memory;
  try { memory = await createAssistantMemory({ directory, documents }); }
  catch (error) { documents.close(); throw error; }
  let review;
  try { review = createAssistantReview({ directory }); }
  catch (error) { memory.close(); documents.close(); throw error; }
  let ledger;
  try { ledger = createAssistantLedger({ directory }); }
  catch (error) { review.close(); memory.close(); documents.close(); throw error; }
  let connections;
  try { connections = createAssistantConnections({ directory }); }
  catch (error) { ledger.close(); review.close(); memory.close(); documents.close(); throw error; }
  let orchestration;
  try { orchestration = createAssistantOrchestrationStore({ directory }); }
  catch (error) { connections.close(); ledger.close(); review.close(); memory.close(); documents.close(); throw error; }
  let learning;
  try { learning = createLearningCounters({ directory, review }); }
  catch (error) { orchestration.close(); connections.close(); ledger.close(); review.close(); memory.close(); documents.close(); throw error; }
  let ownedSkills;
  try { ownedSkills = createOwnedSkills({ directory }); }
  catch (error) { learning.close(); orchestration.close(); connections.close(); ledger.close(); review.close(); memory.close(); documents.close(); throw error; }
  async function getProfile() {
    const rows = await documents.list();
    return { identity: rows.find(row => row.name === 'IDENTITY.md').content, user: rows.find(row => row.name === 'USER.md').content };
  }
  const exportConfig = config => {
    const value = JSON.parse(JSON.stringify(config));
    for (const key of ['image', 'video', 'tts', 'asr']) if (value[key]) delete value[key].credentialRef;
    delete value.revision;
    delete value.schemaVersion;
    return value;
  };
  async function profileInfo() {
    const config = await getConfig();
    return { id: 'default', name: config.name, schemaVersion: 1, isolated: true };
  }
  async function profileExport() {
    const [config, documentRows, memories] = await Promise.all([
      getConfig(), documents.list(), memory.list(),
    ]);
    return {
      format: 'benchgo-assistant-profile', version: 1,
      profile: await profileInfo(), exportedAt: new Date().toISOString(), config: exportConfig(config),
      documents: documentRows.map(({ name, content, hash, revision }) => ({ name, content, hash, revision })),
      memories: memories.map(({ id, content, scope, source, createdAt, updatedAt, revision }) => ({ id, content, scope, source, createdAt, updatedAt, revision })),
    };
  }
  async function profileImport(bundle, { apply = false, overwrite = false, includeMemories = true } = {}) {
    if (JSON.stringify(bundle || {}).length > 16 * 1024 * 1024) throw new Error('Profile 包超过大小限制');
    if (!bundle || bundle.format !== 'benchgo-assistant-profile' || bundle.version !== 1) throw new Error('不支持的助手 Profile 包');
    if (!Array.isArray(bundle.documents) || bundle.documents.length !== 6) throw new Error('Profile 包缺少六份助手文档');
    const current = await documents.list(), currentByName = new Map(current.map(row => [row.name, row]));
    const documentsToImport = bundle.documents.map(row => {
      if (!ASSISTANT_DOCUMENTS.includes(row.name) || typeof row.content !== 'string') throw new Error('Profile 文档无效');
      if (row.content.length > 256 * 1024 || (row.hash !== undefined && row.hash !== documentHash(row.content))) throw new Error('Profile 文档哈希无效');
      return { ...row };
    });
    const importedNames = new Set(documentsToImport.map(row => row.name));
    if (importedNames.size !== ASSISTANT_DOCUMENTS.length || ASSISTANT_DOCUMENTS.some(name => !importedNames.has(name))) {
      throw new Error('Profile 包必须恰好包含六份不同的助手文档');
    }
    // These documents are the authoritative memory store, not just the export array.
    // Opting out preserves the target's personal data in all three documents.
    if (!includeMemories) {
      for (let index = documentsToImport.length - 1; index >= 0; index--) {
        if (['MEMORY.md', 'USER.md', 'TOOLS.md'].includes(documentsToImport[index].name)) documentsToImport.splice(index, 1);
      }
    }
    const importedIdentity = documentsToImport.find(row => row.name === 'IDENTITY.md');
    if (identityName(importedIdentity.content) === null) {
      const fallbackName = bundle.config?.name ?? identityName(currentByName.get('IDENTITY.md').content);
      if (fallbackName !== null && fallbackName !== undefined) importedIdentity.content = withIdentityName(importedIdentity.content, fallbackName);
      importedIdentity.hash = documentHash(importedIdentity.content);
    }
    const importedMemories = includeMemories && Array.isArray(bundle.memories) ? bundle.memories : [];
    for (const row of importedMemories) {
      if (!row || typeof row.content !== 'string' || row.content.length > 16000 || (row.id !== undefined && (typeof row.id !== 'string' || row.id.length > 200))) throw new Error('Profile 记忆无效');
    }
    const conflicts = documentsToImport.filter(row => currentByName.get(row.name)?.content !== row.content).map(row => ({ name: row.name, currentHash: currentByName.get(row.name)?.hash, incomingHash: row.hash || documentHash(row.content) }));
    const result = { profile: await profileInfo(), conflicts, documents: documentsToImport.map(row => row.name), memories: importedMemories.length, applied: false };
    if (!apply) return { ...result, preview: true };
    if (!overwrite && conflicts.length) throw Object.assign(new Error('Profile 与当前资料存在冲突，请预览后选择覆盖'), { code: 'PROFILE_CONFLICT', conflicts });
    if (bundle.config && typeof bundle.config === 'object' && !Array.isArray(bundle.config)) {
      const patch = exportConfig(bundle.config);
      // The imported document owns the name; a missing field is filled from the bundle.
      delete patch.name;
      // Image assets are local and are not included in profile bundles. Preserve this device's appearance.
      delete patch.pet; delete patch.petPrevious; delete patch.petHasPrevious;
      await updateConfig(patch);
    }
    for (const row of documentsToImport) await documents.update(row.name, { content: row.content, expectedHash: currentByName.get(row.name)?.hash, source: { type: 'profile-import', profileId: bundle.profile?.id || null } });
    if (importedMemories.length) for (const row of importedMemories) {
      await memory.save({ id: row.id, content: row.content, scope: row.scope, source: { ...(row.source || {}), type: 'profile-import', profileId: bundle.profile?.id || null } });
    }
    return { ...result, applied: true, preview: false, profile: await profileInfo() };
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    ownedSkills.close();
    learning.close();
    ledger.close();
    connections.close();
    orchestration.close();
    review.close();
    memory.close();
    documents.close();
  };
  return {
    paths,
    rootDirectory,
    profileId: 'default',
    ledger,
    connections,
    orchestration,
    documents,
    memory,
    review,
    learning,
    ownedSkills,
    getConfig,
    updateConfig,
    getState: () => readVersioned(paths.state, initialState, validateState),
    updateState: (patch, options) => update(paths.state, initialState, validateState, patch, options),
    getProfile,
    profileInfo,
    profileExport,
    profileImport,
    // Ordered five-document context for the assistant runtime. Keep getProfile
    // as the legacy identity/user projection used by existing callers.
    async getContext() {
      // memory.context() applies USER.md learning exclusions and tombstones
      // before data is exposed to the prompt. Do not use memory.list() here:
      // that API is intentionally an administrative/raw view.
      return memory.context();
    },
    async getSessionContext(sessionId) {
      return await documents.sessionContext(sessionId, memory.redactForgottenContext)
        ?? documents.freezeSessionContext(sessionId, await memory.context(), memory.redactForgottenContext);
    },
    async updateProfile(patch) {
      if (!object(patch) || Object.keys(patch).some((key) => !['identity', 'user'].includes(key))) throw new Error('Invalid profile update');
      for (const value of Object.values(patch)) if (typeof value !== 'string' || value.length > 64000) throw new Error('Invalid profile text');
      return serialize(directory, async () => {
        const completed = [];
        try {
          for (const [key, value] of Object.entries(patch)) {
            const name = key === 'identity' ? 'IDENTITY.md' : 'USER.md';
            await documents.mutate(name, current => {
              // Legacy identity text editors do not rename. Preserve concurrent name edits;
              // full-document edits remain available through the hash-checked document API.
              const currentName = name === 'IDENTITY.md' ? identityName(current) : null;
              return currentName ? withIdentityName(value, currentName) : value;
            }, { source: { type: 'user-edit', entrypoint: 'profile' } });
            completed.push(name);
          }
        } catch (error) { error.completedDocuments = completed; throw error; }
        return getProfile();
      });
    },
    listMemories: () => memory.list(),
    saveMemory: (input, options) => memory.save(input, options),
    deleteMemory: (id, options) => memory.remove(id, options),
    close,
  };
}
