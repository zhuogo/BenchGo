const boolean = label => ({ label, kind: 'boolean' });
const number = (label, min, max) => ({ label, kind: 'number', min, max });
const choice = (label, choices) => ({ label, kind: 'choice', choices });

export const runtimeSettingSchemas = {
  codex: { config: {
    features: { multi_agent: boolean('多代理') },
    agents: { max_threads: number('最大并发代理数', 1, 32), max_depth: number('最大委派深度', 1, 8) },
    model_reasoning_effort: choice('推理强度', { minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '最高' }),
    model_context_window: number('上下文窗口', 1024, 10000000),
    model_auto_compact_token_limit: number('自动压缩阈值', 1024, 10000000),
  } },
  claude: { settings: {
    env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: choice('代理团队', { '0': '关闭', '1': '开启' }) },
    teammateMode: choice('队友显示方式', { 'in-process': '内嵌', auto: '自动', tmux: 'tmux', iterm2: 'iTerm2' }),
    alwaysThinkingEnabled: boolean('持续思考'),
    effortLevel: choice('推理强度', { low: '低', medium: '中', high: '高', xhigh: '最高' }),
    disableAllHooks: boolean('禁用 Hooks'),
  } },
};

function collectFields(schema, parents = []) {
  return Object.entries(schema).flatMap(([key, entry]) => {
    const path = [...parents, key];
    return entry.kind ? [{ ...entry, path, key: path.join('.') }] : collectFields(entry, path);
  });
}

export const runtimeSettingFields = Object.fromEntries(Object.entries(runtimeSettingSchemas).map(([tool, schema]) => [tool, collectFields(schema)]));

const nativeEffortPaths = { codex: ['config', 'model_reasoning_effort'], claude: ['settings', 'effortLevel'] };

export function nativeModelReasoning(tool, reasoning) {
  const path = nativeEffortPaths[tool];
  if (!Array.isArray(path) || !reasoning?.efforts?.length) return undefined;
  const { choices } = readRuntimeSetting(runtimeSettingSchemas[tool], path);
  const efforts = reasoning.efforts.filter(({ id }) => Object.hasOwn(choices, id));
  if (!efforts.length) return undefined;
  const { defaultEffort } = reasoning;
  return { efforts, ...(efforts.some(({ id }) => id === defaultEffort) ? { defaultEffort } : {}) };
}

export function nativeReasoningEffort(tool, config) {
  const path = nativeEffortPaths[tool];
  return Array.isArray(path) ? readRuntimeSetting(config, path) : undefined;
}

export function nativeModelConfig(tool, defaults, reasoning, params = {}) {
  if (Object.keys(params).some(key => key !== 'reasoningEffort')) throw new Error('外部 Harness 仅支持在模型配置中设置推理强度');
  const { reasoningEffort } = params;
  if (reasoningEffort !== undefined && !reasoning?.efforts?.some(({ id }) => id === reasoningEffort)) {
    throw new Error('所选推理档位不受此模型与 Harness 支持');
  }
  const config = structuredClone(defaults ?? {});
  const path = nativeEffortPaths[tool];
  const selected = reasoningEffort ?? reasoning?.defaultEffort;
  if (Array.isArray(path)) writeRuntimeSetting(config, path, selected);
  return config;
}

export function readRuntimeSetting(config, path) {
  return path.reduce((value, key) => value?.[key], config);
}

export function writeRuntimeSetting(config, [key, ...children], value) {
  if (!children.length) {
    if (value === undefined) delete config[key];
    else config[key] = value;
    return;
  }
  if (value === undefined && !config[key]) return;
  const child = config[key] ??= {};
  writeRuntimeSetting(child, children, value);
  if (!Object.keys(child).length) delete config[key];
}
