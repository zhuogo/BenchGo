export const auxiliaryCapabilities = Object.freeze([
  ['vision', '看图', '读取任务图片'],
  ['compression', '上下文压缩', '压缩会话历史'],
  ['summary', '总结', '总结指定内容'],
  ['review', '研判与复盘', '接单研判与学习复盘'],
]);

export function validateModelSettings(config) {
  for (const [role, label, models] of [['router', '身份模型', config.models || []], ['worker', '工作模型', config.workerModels || []], ['auxiliary', '辅助模型', config.auxiliary?.models || []]]) {
    if (!Array.isArray(models) || models.length > 32) return { role, message: `${label}最多配置 32 项。` };
    const seen = new Set();
    for (const [index, model] of models.entries()) {
      const prefix = `${label}第 ${index + 1} 项`;
      for (const [key, name] of [['providerId', '供应商'], ['modelId', '模型']]) {
        const value = model?.[key];
        if (typeof value !== 'string' || !value.trim()) return { role, message: `${prefix}：请选择或填写${name} ID。` };
        if (value !== value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) return { role, message: `${prefix}：${name} ID 不能包含首尾空格或控制字符，且不能超过 512 字符。` };
      }
      const key = JSON.stringify([model.providerId, model.modelId]);
      if (seen.has(key)) return { role, message: `${prefix}与前面的配置重复，请移除重复项或选择其他模型。` };
      seen.add(key);
    }
  }
  return null;
}

export function identityConfigPatch(config, base) {
  return Object.fromEntries(['name', 'cardHtml', 'cardMotion', 'models', 'workerModels', 'auxiliary']
    .filter(key => JSON.stringify(config[key]) !== JSON.stringify(base[key]))
    .map(key => [key, config[key]]));
}

export function auxiliaryModelPatch(auxiliary, models) {
  return { auxiliary: models.length ? { ...auxiliary, models, capabilities: auxiliary?.capabilities || [] } : null };
}

export function auxiliaryCapabilityPatch(auxiliary, capability, enabled) {
  if (!auxiliary || !auxiliaryCapabilities.some(([key]) => key === capability)) return {};
  const selected = new Set(auxiliary.capabilities);
  if (enabled) selected.add(capability); else selected.delete(capability);
  return { auxiliary: { ...auxiliary, capabilities: [...selected] } };
}
