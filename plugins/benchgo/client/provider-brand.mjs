const aliases = { 'deepseek-account': 'deepseek', 'deepseek-api': 'deepseek', 'openai-api': 'openai', 'openai-codex': 'openai', claude: 'anthropic', 'anthropic-api': 'anthropic', gemini: 'google', 'google-gemini': 'google', 'google-gemini-cli': 'google', 'google-generative-ai': 'google', 'google-vertex': 'google', dashscope: 'qwen', alibaba: 'qwen', 'qwen-token-plan': 'qwen', 'qwen-token-plan-cn': 'qwen', 'qwen-token-plan-individual': 'qwen', zai: 'zhipu', 'z-ai': 'zhipu', 'zai-coding-cn': 'zhipu', moonshot: 'kimi', moonshotai: 'kimi', 'moonshotai-cn': 'kimi', 'kimi-coding': 'kimi', mimo: 'xiaomimimo', xiaomi: 'xiaomimimo', 'xiaomi-token-plan-ams': 'xiaomimimo', 'xiaomi-token-plan-cn': 'xiaomimimo', 'xiaomi-token-plan-sgp': 'xiaomimimo', 'minimax-cn': 'minimax', aws: 'amazon-bedrock', 'cloudflare-ai-gateway': 'cloudflare', 'cloudflare-workers-ai': 'cloudflare', 'githubcopilot': 'github-copilot', copilot: 'github-copilot', 'opencode-go': 'opencode', 'vercel-ai-gateway': 'vercel' };
const known = new Set(['deepseek', 'openai', 'anthropic', 'google', 'openrouter', 'siliconflow', 'qwen', 'zhipu', 'minimax', 'stepfun', 'xiaomimimo', 'kimi', 'mistral', 'ollama', 'xai', 'azure', 'amazon-bedrock', 'github-copilot', 'huggingface', 'nvidia', 'cloudflare', 'meta', 'vercel', 'opencode', 'groq', 'together', 'fireworks', 'baseten']);
/** Exact registered identities only: a custom route is never guessed from its display name. */
export function providerBrand(id, declared = false) {
  const key = typeof id === 'string' ? id.trim().toLowerCase() : '';
  if (key === 'routergo') return 'routergo';
  if (key === 'deepseek-official') return 'deepseek';
  const brand = aliases[key] || (known.has(key) ? key : null);
  if (declared && !brand) return null;
  return brand;
}
export function providerInitial(name, id) {
  const text = String(name || id || '?').trim();
  return Array.from(text)[0]?.toLocaleUpperCase() || '?';
}
