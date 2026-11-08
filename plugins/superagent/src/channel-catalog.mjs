import { feishuConfig } from './feishu.mjs';

export const channelIds = ['feishu', 'wecom', 'qq', 'weixin', 'telegram', 'discord', 'slack', 'dingtalk', 'whatsapp', 'email', 'webhook', 'api'];
const field = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });
const setupUrls = { slack: 'https://api.slack.com/apps', dingtalk: 'https://open-dev.dingtalk.com/', wecom: 'https://work.weixin.qq.com/', qq: 'https://q.qq.com/', telegram: 'https://t.me/BotFather', discord: 'https://discord.com/developers/applications', whatsapp: 'https://developers.facebook.com/apps/' };
const feishu = { id: 'feishu', label: '飞书', setupUrl: 'https://open.feishu.cn/app', help: '启用飞书应用的机器人与接收消息事件，选择长连接，无需公网地址。保存凭据并验证后，选择机器人所在群；@ 时按需读取相关讨论，读取范围取决于飞书权限。', defaults: feishuConfig(), capabilities: { text: true, groups: true, direct: true, history: true }, fields: [
  field('appId', 'App ID', 'text', { required: true }), field('appSecretRef', 'App Secret 凭据', 'secretRef', { required: true }),
  field('accessMode', '谁能发起任务', 'select', { hidden: true, options: ['owners', 'platform'] }),
  field('directMessages', '接收私聊', 'boolean', { hidden: true }), field('groups', '群聊', 'groups', { hidden: true }),
  field('otherGroups', '其他群', 'select', { hidden: true, options: ['disabled', 'mentions'] }),
  field('ownerOpenIds', '指定人员 Open ID', 'list', { advanced: true, help: '仅“指定人员”方式使用；沿用飞书应用范围时无需填写。' }), field('chatIds', '原会话范围', 'list', { hidden: true }),
  field('verificationTokenRef', 'Verification Token 凭据', 'secretRef', { advanced: true }), field('encryptKeyRef', 'Encrypt Key 凭据', 'secretRef', { advanced: true }),
  field('botOpenId', '机器人 Open ID', 'text', { hidden: true }), field('machineOpenIds', '自动化发送人', 'list', { advanced: true }),
  field('enabledRuleIds', '自动化消息规则 ID', 'list', { advanced: true }), field('admissionMode', '自动化消息处理', 'select', { advanced: true, options: [{ value: 'manual', label: '仅处理明确请求' }, { value: 'auto', label: '按已启用规则处理自动化消息' }], help: '仅影响指定自动化发送人，不会自动从群成员闲聊创建任务。' }),
] };
const modules = new Map();
// Loaded once per plugin lifecycle; optional SDKs are loaded by each adapter only on use.
export async function loadChannelModules() {
  for (const id of channelIds.slice(1)) if (!modules.has(id)) modules.set(id, await import(`./channels/${id}.mjs`));
}
export function channelModule(id) { return modules.get(id); }
export function channelDefinition(id) {
  if (!channelIds.includes(id)) throw new Error('未知链接渠道');
  if (id === 'feishu') return structuredClone(feishu);
  const definition = modules.get(id)?.channelDefinition;
  if (!definition) throw new Error(`渠道模块尚未加载：${id}`);
  const fields = [...(definition.fields || [])];
  for (const entry of [field('ownerIds', '允许使用的人员 ID', 'list', { required: true }), field('chatIds', '允许的会话 ID', 'list', { advanced: true }), field('machineIds', '自动化发送人 ID', 'list', { advanced: true }), field('enabledRuleIds', '自动化消息规则 ID', 'list', { advanced: true }), field('admissionMode', '自动化消息处理', 'select', { advanced: true, options: [{ value: 'manual', label: '仅处理明确请求' }, { value: 'auto', label: '按已启用规则处理自动化消息' }] })]) if (!fields.some(item => item.key === entry.key)) fields.push(entry);
  return { ...structuredClone(definition), ...(setupUrls[id] ? { setupUrl: setupUrls[id] } : {}), fields, defaults: { enabled: false, ownerIds: [], chatIds: [], machineIds: [], enabledRuleIds: [], admissionMode: 'manual', ...definition.defaults } };
}
export function connectionConfig(channel, input = {}) {
  if (channel === 'feishu') return feishuConfig(input);
  const definition = channelDefinition(channel);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('链接配置无效');
  const fields = new Map(definition.fields.map(item => [item.key, item]));
  const keys = new Set(['enabled', ...Object.keys(definition.defaults), ...fields.keys()]);
  if (Object.keys(input).some(key => !keys.has(key))) throw new Error('链接配置包含未知字段');
  const config = structuredClone({ ...definition.defaults, ...input });
  if (typeof config.enabled !== 'boolean') throw new Error('链接启用状态无效');
  if (!['manual', 'auto'].includes(config.admissionMode)) throw new Error('链接准入模式无效');
  for (const [key, value] of Object.entries(config)) {
    const descriptor = fields.get(key) || {};
    const expected = definition.defaults[key];
    if (Array.isArray(expected) || ['list', 'array', 'ids', 'string[]'].includes(descriptor.type)) {
      if (!Array.isArray(value) || value.length > 1000 || value.some(item => typeof item !== 'string' || !item || item.length > 2048 || /[\x00-\x1f\x7f]/u.test(item))) throw new Error(`链接 ${key} 无效`);
      config[key] = [...new Set(value)];
    } else if (typeof expected === 'boolean' || descriptor.type === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`链接 ${key} 无效`);
    } else if (typeof expected === 'number' || descriptor.type === 'number') {
      if (!Number.isFinite(value) || (descriptor.min !== undefined && value < descriptor.min) || (descriptor.max !== undefined && value > descriptor.max)) throw new Error(`链接 ${key} 无效`);
    } else if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/u.test(value)) throw new Error(`链接 ${key} 无效`);
    if (config.enabled && descriptor.required && (value === '' || value == null || (Array.isArray(value) && !value.length))) throw new Error(`启用前请配置${descriptor.label || key}`);
  }
  const module = channelModule(channel);
  const validate = Object.entries(module || {}).find(([key, value]) => /^[a-z].*Config$/.test(key) && typeof value === 'function')?.[1];
  if (validate) {
    const own = module.channelDefinition;
    const ownKeys = new Set(['enabled', 'ownerIds', 'chatIds', ...Object.keys(own.defaults || {}), ...(own.fields || []).map(field => field.key)]);
    validate(Object.fromEntries(Object.entries(config).filter(([key]) => ownKeys.has(key))));
  }
  return config;
}
