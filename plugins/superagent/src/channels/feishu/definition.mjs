const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/u.test(value);
const field = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });

/** Only references enter persisted/public configuration; secrets use Harness credentials. */
export function feishuConfig(input = {}) {
  if (!object(input)) throw fail('飞书配置无效');
  const fields = ['enabled', 'appId', 'appSecretRef', 'verificationTokenRef', 'encryptKeyRef', 'botOpenId', 'ownerOpenIds', 'chatIds', 'admissionMode', 'machineOpenIds', 'enabledRuleIds', 'accessMode', 'directMessages', 'groups', 'otherGroups'];
  if (Object.keys(input).some(key => !fields.includes(key))) throw fail('飞书配置包含未知字段');
  const result = { enabled: false, appId: '', appSecretRef: '', verificationTokenRef: '', encryptKeyRef: '', botOpenId: '', ownerOpenIds: [], chatIds: [], admissionMode: 'manual', machineOpenIds: [], enabledRuleIds: [], accessMode: 'owners', directMessages: true, groups: null, otherGroups: 'disabled', ...structuredClone(input) };
  if (!['owners', 'platform'].includes(result.accessMode) || typeof result.directMessages !== 'boolean' || !['disabled', 'mentions'].includes(result.otherGroups)) throw fail('飞书对话范围无效');
  if (result.groups !== null) {
    if (!Array.isArray(result.groups) || result.groups.length > 1000 || result.groups.some(group => !object(group) || Object.keys(group).some(key => !['chatId', 'name', 'mode'].includes(key)) || !id(group.chatId) || !['mentions', 'all', 'disabled'].includes(group.mode) || (group.name !== undefined && (typeof group.name !== 'string' || group.name.length > 512)))) throw fail('飞书群配置无效');
    if (new Set(result.groups.map(group => group.chatId)).size !== result.groups.length) throw fail('飞书群配置重复');
  }
  if (typeof result.enabled !== 'boolean') throw fail('飞书启用状态无效');
  if (!['manual', 'auto'].includes(result.admissionMode)) throw fail('飞书准入模式无效');
  for (const key of ['appId', 'appSecretRef', 'verificationTokenRef', 'encryptKeyRef', 'botOpenId']) if (result[key] !== '' && !id(result[key])) throw fail(`飞书 ${key} 无效`);
  for (const key of ['ownerOpenIds', 'chatIds', 'machineOpenIds', 'enabledRuleIds']) {
    if (!Array.isArray(result[key]) || result[key].length > 1000 || !result[key].every(id)) throw fail(`飞书 ${key} 无效`);
    result[key] = [...new Set(result[key])];
  }
  if (result.enabled && (!result.appId || !result.appSecretRef)) throw fail('启用飞书前请配置 App ID 和 App Secret 引用');
  return result;
}

export const channelDefinition = { id: 'feishu', label: '飞书', setupUrl: 'https://open.feishu.cn/app', help: '启用飞书应用的机器人与接收消息事件，选择长连接，无需公网地址。保存凭据并验证后，选择机器人所在群；@ 时按需读取相关讨论，读取范围取决于飞书权限。', defaults: feishuConfig(), capabilities: { externalActions: ['external-send'], text: true, groups: true, direct: true, topics: true, history: true }, fields: [
  field('appId', 'App ID', 'text', { required: true }), field('appSecretRef', 'App Secret 凭据', 'secretRef', { required: true }),
  field('accessMode', '谁能发起任务', 'select', { hidden: true, options: ['owners', 'platform'] }),
  field('directMessages', '接收私聊', 'boolean', { hidden: true }), field('groups', '群聊', 'groups', { hidden: true }),
  field('otherGroups', '其他群', 'select', { hidden: true, options: ['disabled', 'mentions'] }),
  field('ownerOpenIds', '指定人员 Open ID', 'list', { advanced: true, help: '仅“指定人员”方式使用；沿用飞书应用范围时无需填写。' }), field('chatIds', '原会话范围', 'list', { hidden: true }),
  field('verificationTokenRef', 'Verification Token 凭据', 'secretRef', { advanced: true }), field('encryptKeyRef', 'Encrypt Key 凭据', 'secretRef', { advanced: true }),
  field('botOpenId', '机器人 Open ID', 'text', { hidden: true }), field('machineOpenIds', '自动化发送人', 'list', { advanced: true }),
  field('enabledRuleIds', '自动化消息规则 ID', 'list', { advanced: true }), field('admissionMode', '自动化消息处理', 'select', { advanced: true, options: [{ value: 'manual', label: '仅处理明确请求' }, { value: 'auto', label: '按已启用规则处理自动化消息' }], help: '仅影响指定自动化发送人，不会自动从群成员闲聊创建任务。' }),
] };

/** Same field registrations/defaults interpreted by connectionConfig, never sampled state. */
export function feishuSettingsSchema() {
  const definition = channelDefinition, fields = new Map(definition.fields.map(item => [item.key, item]));
  const properties = {};
  for (const key of new Set(['enabled', ...Object.keys(definition.defaults), ...fields.keys()])) {
    const descriptor = fields.get(key) || {}, fallback = definition.defaults[key];
    let schema;
    if (key === 'groups') schema = { anyOf: [{ type: 'null' }, { type: 'array', maxItems: 1000, items: { type: 'object', additionalProperties: false, required: ['chatId', 'mode'], properties: { chatId: { type: 'string', minLength: 1, maxLength: 512 }, name: { type: 'string', maxLength: 512 }, mode: { type: 'string', enum: ['mentions', 'all', 'disabled'] } } } }] };
    else if (Array.isArray(fallback) || ['list', 'array', 'ids', 'string[]'].includes(descriptor.type)) schema = { type: 'array', maxItems: 1000, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 512, pattern: '^[^\\u0000-\\u001f\\u007f]*$' } };
    else if (typeof fallback === 'boolean' || descriptor.type === 'boolean' || key === 'enabled') schema = { type: 'boolean' };
    else if (typeof fallback === 'number' || descriptor.type === 'number') schema = { type: 'number', ...(descriptor.min === undefined ? {} : { minimum: descriptor.min }), ...(descriptor.max === undefined ? {} : { maximum: descriptor.max }) };
    else schema = { type: 'string', maxLength: 512, pattern: '^[^\\u0000-\\u001f\\u007f]*$' };
    if (descriptor.options) schema.enum = descriptor.options.map(option => typeof option === 'string' ? option : option.value);
    if (descriptor.label) schema.title = descriptor.label;
    if (descriptor.help) schema.description = descriptor.help;
    if (fallback !== undefined) schema.default = structuredClone(fallback);
    properties[key] = schema;
  }
  return { type: 'object', additionalProperties: false, properties };
}
