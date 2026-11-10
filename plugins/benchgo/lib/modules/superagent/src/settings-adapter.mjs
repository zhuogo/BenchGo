import { applySettingsOps, normalizeSettingsOps, settingsSnapshot } from '../../../../shared/settings-adapter-utils.mjs';
import { validateIdentityName } from './identity.mjs';
import { ASSISTANT_BLOCKED_PATHS, ASSISTANT_CONFIG_SCHEMA, LEARNING_CONFIG_SCHEMA, SKILLS_POLICY_SCHEMA } from './settings-schema.mjs';
export function createAssistantSettingsAdapter(store, { applyConfig } = {}) {
  const read = async namespace => {
    if (namespace === 'superagent') return store.configurationSnapshot();
    if (namespace === 'superagent-learning') return store.memory.learningSettingsSnapshot();
    if (namespace === 'superagent-skills-policy') return settingsSnapshot(store.ownedSkills.policy(), undefined, { base: { staleDays: 14, archiveDays: 30, llmMerge: false } });
    throw new Error('未知总助手设置');
  };
  return {
    id: 'superagent',
    async schema() { return [
      { namespace: 'superagent', title: '总助手', schema: structuredClone(ASSISTANT_CONFIG_SCHEMA), risk: 'ordinary', impact: '后续路由/模型请求读取新配置；已分派 Worker 保留冻结模型及原授权', sensitivePaths: [], applies: applyConfig ? 'live' : 'reload', pathPolicies: [
        ...ASSISTANT_BLOCKED_PATHS.map(path => ({ path, risk: 'blocked', impact: '形象含本地素材、预览与历史，须通过现有宠物预览和应用入口修改' })),
        { path: ['capabilities'], risk: 'confirm', impact: '改变总助手主动能力范围' },
      ] },
      { namespace: 'superagent-learning', title: '长期记忆学习规则', description: 'USER.md“不要学习”正文的排除项始终生效，通用设置只修改其结构化规则。', schema: structuredClone(LEARNING_CONFIG_SCHEMA), risk: 'confirm', impact: '即时影响后续学习与隐私过滤；不会恢复遗忘内容', sensitivePaths: [], applies: 'live' },
      { namespace: 'superagent-skills-policy', title: '自建技能整理策略', schema: structuredClone(SKILLS_POLICY_SCHEMA), risk: 'ordinary', impact: '后续技能整理使用新阈值；archiveDays必须大于staleDays', sensitivePaths: [], applies: 'live', pathPolicies: [{ path: ['llmMerge'], risk: 'blocked', impact: '当前整理仅依据持久元数据，不启用模型合并' }] },
    ]; },
    read,
    async normalizeOps(namespace, { ops, current }) {
      if (namespace === 'superagent-learning') {
        const user = applySettingsOps(current.user ?? {}, ops), base = current.base ?? { enabled: true, excludedScopes: [], excludedTerms: [] };
        const actual = { ...base, ...user, excludedTerms: [...new Set([...(user.excludedTerms || []), ...base.excludedTerms])] };
        return normalizeSettingsOps(current.value, ops, actual, { base });
      }
      if (namespace !== 'superagent') return ops;
      return ops.map(operation => {
        if (operation.op !== 'set') return operation;
        if (operation.path.length === 1 && operation.path[0] === 'cardHtml' && typeof operation.value === 'string' && !operation.value.trim()) return { ...operation, value: null };
        if (operation.path.length === 1 && operation.path[0] === 'name') return { ...operation, value: validateIdentityName(operation.value) };
        if (!operation.path.length && operation.value && typeof operation.value === 'object') { const value = { ...operation.value }; if (typeof value.cardHtml === 'string' && !value.cardHtml.trim()) value.cardHtml = null; if (Object.hasOwn(value, 'name')) value.name = validateIdentityName(value.name); return { ...operation, value }; }
        return operation;
      });
    },
    async apply(namespace, { ops, expected, signal }) {
      let application = { state: 'applied' };
      if (namespace === 'superagent') {
        if (applyConfig) { const result = await applyConfig({ ops, expected, signal }); application = result?.application ?? application; }
        else { await store.updateConfig({}, { settingsOps: ops, expected, signal }); application = { state: 'reload-required', reason: '当前未接入总助手运行时配置应用接缝' }; }
      } else if (namespace === 'superagent-learning') await store.memory.configureLearning({}, { ops, expected, signal });
      else if (namespace === 'superagent-skills-policy') store.ownedSkills.configurePolicy({}, { ops, expected, signal });
      else throw new Error('未知总助手设置');
      return { ...await read(namespace), application };
    },
    subscribe(listener) {
      const disposers = [store.subscribeConfig(listener), store.ownedSkills.onChange(() => listener({ namespace: 'superagent-skills-policy' }))];
      if (store.documents.subscribe) disposers.push(store.documents.subscribe(({ name }) => { if (name === 'USER.md') listener({ namespace: 'superagent-learning' }); if (name === 'IDENTITY.md') listener({ namespace: 'superagent' }); }));
      return () => { for (const dispose of disposers) dispose(); };
    },
  };
}
