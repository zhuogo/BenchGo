import { channelDefinition, channelIds, connectionConfig, connectionSettingsSchema } from './channel-catalog.mjs';
import { applySettingsOps, normalizeSettingsOps } from '../../benchgo/shared/settings-adapter-utils.mjs';
const namespaceFor = channel => `superagent-connections:${channel}`;
const channelFor = namespace => { const channel = channelIds.find(id => namespaceFor(id) === namespace); if (!channel) throw new Error('未知链接设置'); return channel; };
export function createConnectionSettingsAdapter(connections, { applyConfig } = {}) {
  return {
    id: 'superagent-connections',
    async schema() { return channelIds.map(channel => ({ namespace: namespaceFor(channel), title: `${channelDefinition(channel).label}链接`, schema: connectionSettingsSchema(channel), risk: 'confirm', impact: '变更接入身份、准入范围或凭据引用，使用既有渠道服务重连；不改变原任务授权', sensitivePaths: [], applies: applyConfig ? 'live' : 'reload' })); },
    async read(namespace) { return connections.settingsSnapshot(channelFor(namespace)); },
    async normalizeOps(namespace, { ops, current }) {
      const actual = connectionConfig(channelFor(namespace), applySettingsOps(current.value, ops, { base: current.base }));
      return normalizeSettingsOps(current.value, ops, actual, { base: current.base });
    },
    async apply(namespace, { ops, expected, signal }) {
      const channel = channelFor(namespace);
      let result;
      if (applyConfig) result = await applyConfig({ channel, ops, expected, signal });
      else connections.update({}, { channel, ops, expected, signal });
      return { ...connections.settingsSnapshot(channel), application: result?.application ?? (applyConfig ? { state: 'pending', reason: '配置已保存，渠道服务未提供即时应用回执' } : { state: 'reload-required', reason: '当前未接入渠道重连服务' }) };
    },
    subscribe: listener => connections.subscribe(listener),
  };
}
