export const auxiliaryCapabilities = Object.freeze([
  ['vision', '看图', '读取任务图片'],
  ['compression', '上下文压缩', '压缩会话历史'],
  ['summary', '总结', '总结指定内容'],
  ['review', '研判与复盘', '接单研判、成果验收和学习复盘'],
]);

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
