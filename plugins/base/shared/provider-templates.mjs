const defaultProtocol = 'openai-completions';

export const providerTemplates = [
  {
    kind: 'dashscope', name: '阿里云百炼', brand: 'qwen',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keywords: ['DashScope', 'Alibaba', 'Qwen', '通义千问'],
    placeholder: 'https://你的工作空间ID.cn-beijing.maas.aliyuncs.com',
    hint: '请使用 API Key 对应区域的工作空间地址。填写工作空间的根地址时会补全兼容接口路径。',
  },
  {
    kind: 'grok', name: 'Grok', brand: 'xai', baseURL: 'https://api.x.ai/v1',
    keywords: ['xAI'],
  },
  {
    kind: 'minimax', name: 'MiniMax', brand: 'minimax', baseURL: 'https://api.minimax.cn/v1',
    keywords: ['稀宇科技', '海螺'],
    hint: '默认使用中国区开放平台。国际站请填写对应的 API 地址。',
  },
  {
    kind: 'spark', name: '讯飞星火', brand: 'spark', baseURL: 'https://spark-api-open.xf-yun.com/v1',
    keywords: ['Spark', 'iFlytek', '科大讯飞'],
    hint: '请填写 HTTP API 的 APIPassword。部分模型使用独立的 API 地址，请以模型文档为准。',
  },
  {
    kind: 'qianfan', name: '百度千帆', brand: 'qianfan', baseURL: 'https://qianfan.baidubce.com/v2',
    keywords: ['Baidu', 'Qianfan', '文心', 'ERNIE'],
  },
  {
    kind: 'ark', name: '火山方舟', brand: 'volcengine', baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    keywords: ['Ark', 'Volcengine', '豆包', '火山引擎'],
  },
  {
    kind: 'stepfun', name: '阶跃星辰', brand: 'stepfun', baseURL: 'https://api.stepfun.com/v1',
    keywords: ['StepFun', 'Step'],
  },
  {
    kind: 'mimo', name: '小米 MiMo', brand: 'xiaomimimo', baseURL: 'https://api.xiaomimimo.com/v1',
    keywords: ['Xiaomi', 'MiMo'],
  },
  {
    kind: 'siliconflow', name: '硅基流动', brand: 'siliconflow', baseURL: 'https://api.siliconflow.cn/v1',
    keywords: ['SiliconFlow', 'SiliconCloud', '硅基云'],
  },
  {
    kind: 'new-api', name: 'New API', brand: 'new-api', baseURL: '',
    keywords: ['newapi', 'One API', '网关'],
    placeholder: 'https://api.example.com/v1',
    hint: '请填写部署实例的 API 地址和访问令牌。',
  },
  {
    kind: 'sub2api', name: 'Sub2API', brand: 'sub2api', baseURL: '',
    keywords: ['sub2api', '网关'],
    placeholder: 'https://api.example.com/v1',
    hint: '请填写部署实例的 API 地址和访问令牌，并确认令牌可以访问 Chat Completions。',
  },
  {
    kind: 'kimi', name: '月之暗面 Kimi', brand: 'kimi', baseURL: 'https://api.moonshot.cn/v1',
    keywords: ['Moonshot', 'Moonshot AI', '月之暗面'],
    hint: '默认使用中国站。国际站请填写 https://api.moonshot.ai/v1 和国际站 API Key。',
  },
  {
    kind: 'openai', name: 'OpenAI', brand: 'openai', baseURL: 'https://api.openai.com/v1',
    protocol: 'openai-responses', keywords: ['GPT', 'Responses', 'ChatGPT'],
    hint: '请填写 OpenAI 平台 API Key，并选择支持 Responses API 的模型。',
  },
  {
    kind: 'anthropic', name: 'Anthropic', brand: 'anthropic', baseURL: 'https://api.anthropic.com',
    protocol: 'anthropic-messages', keywords: ['Claude', 'Messages'],
    hint: '请填写 Claude Console 的 API Key。',
  },
  {
    kind: 'opencode', name: 'OpenCode', brand: 'opencode', baseURL: 'https://opencode.ai/inference/openai/v1',
    keywords: ['Zen', 'OpenCode Console'],
    hint: '请填写 OpenCode Console（原 Zen）API Key，按官方模型表选择支持 Chat Completions 的模型，必要时手动填写原始模型 ID。',
  },
  {
    kind: 'google', name: 'Google Gemini', brand: 'google',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    protocol: 'google-generative-ai', keywords: ['Google AI Studio', 'Gemini API', '谷歌'],
    hint: '请填写 Google AI Studio 的 Gemini API Key。',
  },
  {
    kind: 'meta', name: 'Meta', brand: 'meta', baseURL: 'https://api.meta.ai/v1',
    keywords: ['Meta Model API', 'Muse', 'Llama'],
    hint: '请填写 Meta Model API 的 API Key，并选择支持 Chat Completions 的模型。',
  },
  {
    kind: 'nvidia', name: 'NVIDIA', brand: 'nvidia', baseURL: 'https://integrate.api.nvidia.com/v1',
    keywords: ['NIM', 'NVIDIA API Catalog', '英伟达'],
    hint: '请填写 NVIDIA API Catalog 的 API Key，并选择支持 Chat Completions 的模型。',
  },
  {
    kind: 'huggingface', name: 'Hugging Face', brand: 'huggingface', baseURL: 'https://router.huggingface.co/v1',
    keywords: ['HuggingFace', 'HF', 'Inference Providers'],
    hint: '请填写有 Inference Providers 调用权限的令牌，保留模型 ID 的大小写及路由后缀。',
  },
  {
    kind: 'mistral', name: 'Mistral', brand: 'mistral', baseURL: 'https://api.mistral.ai/v1',
    keywords: ['Mistral AI', 'La Plateforme', 'Codestral'],
  },
  {
    kind: 'zai', name: '智谱 Z.ai', brand: 'zhipu', baseURL: 'https://api.z.ai/api/paas/v4',
    keywords: ['Zhipu', 'GLM', 'BigModel'],
    hint: '请填写 Z.ai 国际站的 API Key。国内开放平台或 Coding Plan 请填写各自的 API 地址和 API Key。',
  },
].map(template => ({ protocol: defaultProtocol, ...template }));

export function providerTemplate(kind) {
  return providerTemplates.find(template => template.kind === kind);
}

export function templateProviderId(kind) {
  if (!providerTemplate(kind)) throw new TypeError('Unknown provider template');
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const suffix = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `benchgo-${kind}-${suffix}`;
}

export function providerTemplateForRoute(id) {
  const match = typeof id === 'string' && /^benchgo-([a-z0-9-]+)-[a-f0-9]{32}$/.exec(id);
  return match ? providerTemplate(match[1]) : undefined;
}

const dashscopeHosts = new Set([
  'dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com',
  'cn-hongkong.dashscope.aliyuncs.com', 'dashscope-us.aliyuncs.com',
]);
const dashscopeWorkspaceHost = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:cn-beijing|us-east-1|ap-southeast-1|ap-northeast-1)\.maas\.aliyuncs\.com$/;

export function normalizeTemplateBaseURL(template, value) {
  if (template?.kind !== 'dashscope' || typeof value !== 'string') return value;

  const address = value.trim();
  const root = /^(https?:\/\/([a-z0-9.-]+))\/?$/i.exec(address);
  if (!root) return value;

  const hostname = root[2].toLowerCase();
  return dashscopeHosts.has(hostname) || dashscopeWorkspaceHost.test(hostname)
    ? `${root[1]}/compatible-mode/v1`
    : value;
}
