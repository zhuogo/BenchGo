/** Keep the official llm-pi-ai vocabulary; wire values are provider-defined. */
export const reasoningLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const reasoningLevelLabels = {
  off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高',
};

export const isReasoningMapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function toggleReasoningLevel(current, available, inherited, level) {
  if (!Object.hasOwn(available, level)) return current;
  const next = { ...current };
  if (Object.hasOwn(next, level)) delete next[level];
  else next[level] = available[level];
  if (!Object.keys(next).some(key => key !== 'off')) return false;
  if (inherited && Object.keys(next).length === Object.keys(inherited).length &&
    Object.entries(next).every(([key, wire]) => Object.hasOwn(inherited, key) && inherited[key] === wire)) return undefined;
  return next;
}

/** Undefined inherits the installed catalog; false declares a non-reasoning model. */
export function withModelReasoning(model, value) {
  const next = { ...model };
  if (value === undefined) delete next.reasoningEfforts;
  else next.reasoningEfforts = value;
  return next;
}

/** Match the adapter's runtime constraints, including those absent from its schema. */
export function reasoningError(value) {
  if (value === undefined || value === false) return undefined;
  if (!isReasoningMapping(value)) return '思考档位配置无效';
  const entries = Object.entries(value);
  if (!entries.length) return '思考档位配置为空';
  for (const [level, wire] of entries) {
    if (!reasoningLevels.includes(level)) return '不支持的思考档位：' + level;
    if (wire === null && level === 'off') continue;
    if (typeof wire !== 'string' || !wire.trim()) return '思考档位 ' + level + ' 的配置值无效';
  }
  if (!entries.some(([level]) => level !== 'off')) return '至少选择一个可用的思考档位';
  return undefined;
}

export function validateModelReasoning(models) {
  if (!Array.isArray(models)) return undefined;
  for (const [index, model] of models.entries()) {
    const error = reasoningError(model?.reasoningEfforts);
    if (error) return '模型 ' + (index + 1) + '：' + error;
  }
  return undefined;
}
