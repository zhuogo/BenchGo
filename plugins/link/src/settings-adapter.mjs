import { LINK_TRANSPORT_SCHEMA, LINK_RELAY_SCHEMA } from './config.mjs';

export const LINK_TRANSPORT_NAMESPACE = 'benchgo-link-transport';
export const LINK_RELAY_NAMESPACE = 'benchgo-link-relay';
export function createLinkSettingsAdapter(service) {
  return {
    id: 'benchgo-link',
    async schema() { return [
      { namespace: LINK_TRANSPORT_NAMESPACE, title: 'Link 设备连接', schema: structuredClone(LINK_TRANSPORT_SCHEMA),
        risk: 'ordinary', applies: 'live', sensitivePaths: [],
        impact: '设备名称保存后生效；监听地址、端口或公网地址变化会重建监听并中断远端连接、清除待配对请求',
        pathPolicies: [
          { path: ['enabled'], risk: 'blocked', impact: 'Link 随模块常驻，停用请使用模块管理' },
          ...['host', 'port', 'publicUrl'].map(key => ({ path: [key], risk: 'confirm', impact: '重建远端监听，可能中断设备连接' })),
        ] },
      { namespace: LINK_RELAY_NAMESPACE, title: 'Link 自有中继池', schema: structuredClone(LINK_RELAY_SCHEMA),
        risk: 'confirm', applies: 'live', sensitivePaths: [['nodes', '*', 'token']],
        impact: '保存后重新连接中继；地址、优先级与启用状态复用设备页面同一配置。添加节点和密钥修改请使用中继安全入口' },
      { namespace: 'benchgo-link-launch', title: 'Link 启动与部署', risk: 'blocked', applies: 'blocked', sensitivePaths: [],
        impact: '数据目录、网页目录和云端部署环境属于启动配置，不能在运行中迁移',
        unavailableReason: '由基础层与 Link 入口合并的启动配置及部署环境提供；没有运行时配置编辑器，需修改原部署配置并重新加载模块' },
    ]; },
    async read(namespace) { return service.configurationSnapshot(namespace); },
    async apply(namespace, transaction) { return service.configureSettings(namespace, transaction); },
    subscribe: listener => service.subscribe(listener),
  };
}
