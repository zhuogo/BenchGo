import { SIDEBAR_NS, WORKBENCH_BLOCKED_PATHS, WORKBENCH_PREFERENCES_SCHEMA, WORKBENCH_SENSITIVE_PATHS } from './preferences.mjs';

export function createWorkbenchSettingsAdapter(preferences, { applyConfig } = {}) {
  return {
    id: 'benchgo-workbench',
    async schema() { return [{ namespace: SIDEBAR_NS, title: '工作台偏好', schema: structuredClone(WORKBENCH_PREFERENCES_SCHEMA), risk: 'ordinary', impact: applyConfig ? '保存后重新挂载原侧栏运行时；工作台连接按既有服务生命周期切换' : '保存后由原侧栏设置入口读取；已打开页面需刷新', sensitivePaths: structuredClone(WORKBENCH_SENSITIVE_PATHS), applies: applyConfig ? 'live' : 'reload', pathPolicies: WORKBENCH_BLOCKED_PATHS.map(path => ({ path, risk: 'blocked', impact: '集成边界固定，请使用 BenchGo 既有入口' })).concat([{ path: ['pluginSettings'], risk: 'blocked', sensitive: true, impact: '扩展尚未注册字段约束和秘密路径，不能通过通用 JSON 读取或修改其任意私有配置' }]) }]; },
    async read(namespace) { if (namespace !== SIDEBAR_NS) throw new Error('未知工作台设置'); return preferences.settingsSnapshot(); },
    async apply(namespace, { ops, expected, signal }) {
      if (namespace !== SIDEBAR_NS) throw new Error('未知工作台设置');
      let application;
      if (applyConfig) application = (await applyConfig({ namespace, ops, expected, signal }))?.application;
      else await preferences.update(namespace, {}, undefined, { ops, expected, signal });
      return { ...preferences.settingsSnapshot(), application: application ?? { state: 'reload-required', reason: '偏好已保存；当前侧栏设置桥未提供运行中配置推送，请刷新已打开的页面' } };
    },
    subscribe: listener => preferences.subscribe(listener),
  };
}
