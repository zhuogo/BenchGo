import { fromJSONSchema } from 'zod';
import {
  applySettingsOps, assertSettingsExpected, normalizeSettingsOps, settingsFingerprint, settingsSnapshot,
} from '../../base/shared/settings-adapter-utils.mjs';
import { normalizeMediaCategorySettings } from './generation.mjs';

const namespace = 'benchgo-media-generation';
const kinds = ['image', 'video', 'audio'];
const identity = { type: 'string', minLength: 1, maxLength: 512 };
const value = { type: 'string', minLength: 1, maxLength: 100 };
const schema = {
  type: 'object', additionalProperties: false, required: kinds,
  properties: Object.fromEntries(kinds.map(kind => [kind, {
    type: 'object', additionalProperties: false, required: ['enabled', 'routes'],
    properties: {
      enabled: { type: 'boolean' },
      routes: {
        type: 'array', maxItems: 3, description: '按首选到备用排序。仅调整顺位时可提交按目标顺序排列的 providerId 和 modelId，保留同一模型的其他配置。更换模型时设置完整顺位。',
        items: {
          type: 'object', additionalProperties: false, required: ['providerId', 'modelId'],
          properties: {
            providerId: { ...identity, description: '准确的供应商 ID' },
            modelId: { ...identity, description: '供应商提供的原始模型 ID' },
            size: value, quality: value,
            ...(kind === 'audio' && {
              voices: {
                type: 'array', maxItems: 20, description: '此模型的音色。新增或移除音色时一并处理默认项。',
                items: {
                  type: 'object', additionalProperties: false, required: ['name'],
                  properties: { name: value, description: { type: 'string', maxLength: 160 } },
                },
              },
              defaultVoice: { ...value, description: '此模型 voices 中的原始音色名称' },
            }),
          },
        },
      },
    },
  }])),
};
const inputSchema = fromJSONSchema(schema);

function assertNamespace(ns) {
  if (ns !== namespace) throw new Error('未知媒体生成设置');
}

function publicCategory({ enabled, routes }, kind) {
  return { enabled, routes: routes.map(({ credentialRef, ...route }) => kind === 'audio' ? { ...route, voices: route.voices ?? [] } : route) };
}

function snapshot(settings) {
  const value = Object.fromEntries(kinds.map(kind => [kind, publicCategory(settings[kind], kind)]));
  return settingsSnapshot(value, settings.revision, { fingerprint: settingsFingerprint(settings) });
}

function routeIdentity({ providerId, modelId }) {
  return JSON.stringify([providerId, modelId]);
}

export function createMediaGenerationSettingsAdapter(generation) {
  return {
    id: namespace,
    async schema() {
      return [{ namespace, title: '媒体生成', schema, risk: 'ordinary', applies: 'live',
        description: '配置图片、视频和音频生成的开关、模型顺位和音色。使用供应商的原始模型 ID。开启类别前须配置模型。实时语音使用 benchgo-voice。',
        impact: '之后的媒体生成读取新配置。播放、合成验证或向供应商发送生成请求需要另行触发。' }];
    },
    async read(ns) {
      assertNamespace(ns);
      return snapshot(await generation.getSettings());
    },
    async normalizeOps(ns, { ops, current }) {
      assertNamespace(ns);
      const expanded = ops.map(op => {
        const [kind, field] = op.path;
        if (op.op !== 'set' || op.path.length !== 2 || field !== 'routes' || !kinds.includes(kind) || !Array.isArray(op.value)) return op;
        const previous = new Map(current.value[kind].routes.map(route => [routeIdentity(route), route]));
        const routes = op.value.map(route => route && Object.keys(route).length === 2 && Object.hasOwn(route, 'providerId') && Object.hasOwn(route, 'modelId')
          ? previous.get(routeIdentity(route)) ?? route : route);
        return { ...op, value: routes };
      });
      const next = applySettingsOps(current.value, expanded);
      if (!inputSchema.safeParse(next).success) throw Object.assign(new Error('媒体设置中有未支持的字段或无效值'), { code: 'SETTINGS_SCHEMA_REJECTED' });
      const actual = Object.fromEntries(kinds.map(kind => [kind, publicCategory(normalizeMediaCategorySettings(next[kind], kind), kind)]));
      return normalizeSettingsOps(current.value, ops, actual);
    },
    async apply(ns, { ops, expected, signal }) {
      assertNamespace(ns);
      const settings = await generation.getSettings();
      const current = snapshot(settings);
      assertSettingsExpected(current, expected, signal);
      const next = applySettingsOps(current.value, ops);
      const patch = {};
      for (const kind of kinds) {
        if (settingsFingerprint(current.value[kind]) === settingsFingerprint(next[kind])) continue;
        const refs = new Map(settings[kind].routes.map(route => [routeIdentity(route), route.credentialRef]));
        patch[kind] = {
          ...next[kind], routes: next[kind].routes.map(({ credentialRef, ...route }) => {
            const ref = refs.get(routeIdentity(route));
            return ref ? { ...route, credentialRef: ref } : route;
          }),
        };
      }
      const saved = Object.keys(patch).length ? await generation.updateSettings(patch, settings.revision, { signal }) : settings;
      return { ...snapshot(saved), application: { state: 'applied' } };
    },
    subscribe: listener => generation.subscribeSettings(() => listener({ namespace })),
  };
}
