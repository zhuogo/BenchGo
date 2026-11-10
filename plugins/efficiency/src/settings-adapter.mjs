import { EFFICIENCY_CONFIG_SCHEMA } from './config-schema.mjs';
const namespace = 'benchgo-efficiency';
export function createEfficiencySettingsAdapter(service) {
  return {
    id: namespace,
    async schema() { return [{ namespace, title: '原生执行增强', schema: structuredClone(EFFICIENCY_CONFIG_SCHEMA), risk: 'ordinary', impact: '保存后重装变更能力；是否可用取决于官方宿主服务，已运行的任务保持原执行边界', sensitivePaths: [], applies: 'reload', pathPolicies: [{ path: ['features', 'ops', 'shell'], risk: 'confirm', impact: '修改原生执行工具的 Shell 权限' }, { path: ['features', 'ops', 'enabled'], risk: 'confirm', impact: '修改模型可使用的原生执行工具' }] }]; },
    async read(ns) { if (ns !== namespace) throw new Error('未知增强设置'); return service.configurationSnapshot(); },
    async normalizeOps(ns, { ops, current }) { if (ns !== namespace) throw new Error('未知增强设置'); return service.normalizeSettingsOps(ops, current); },
    async apply(ns, { ops, expected, signal }) {
      if (ns !== namespace) throw new Error('未知增强设置');
      const runtime = await service.update({}, { ops, expected, signal }), enabled = Object.values(runtime.features).filter(feature => feature.enabled);
      const failed = enabled.find(feature => feature.state === 'unavailable');
      const ready = enabled.every(feature => feature.state === 'ready' && feature.available);
      return { ...service.configurationSnapshot(), application: failed ? { state: 'failed', reason: failed.error || '能力已保存但无法重装' } : ready ? { state: 'applied' } : { state: 'pending', reason: '配置已保存，等待官方宿主服务完成能力重装' } };
    },
    subscribe: listener => service.subscribe(listener),
  };
}
