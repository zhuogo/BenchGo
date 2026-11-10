import { ingestChannelEvent } from './intake.mjs';
import { authorizeChannelConnection, channelSessionKey, connectionPolicy, prepareChannelExternalSend } from './channel-policy.mjs';

/** Shared ingress for all transports, including the separately hosted Feishu stream. */
export function createUnifiedChannelIngress({ store, onInbound }) {
  const read = channel => ({ ...store.connections.read(channel), channel });
  const authorize = (channel, input, { expectedRevision } = {}) => {
    if (expectedRevision !== undefined && read(channel).revision !== expectedRevision) throw Object.assign(new Error('渠道连接配置已更改'), { status: 403 });
    return authorizeChannelConnection(read, channel, input);
  };
  return {
    authorize,
    prepareExternalSend: (channel, input, context) => prepareChannelExternalSend(read, id => store.orchestration.getTrigger(id), channel, input, context),
    async receive(channel, event, { expectedRevision } = {}) {
      const row = read(channel);
      authorize(channel, { operation: 'receive' }, { expectedRevision });
      if (event?.channel !== channel || event.source?.channel !== channel) throw new Error('渠道来源不匹配');
      const bind = value => value && ({ ...value, source: { ...value.source, connectionId: row.connectionId || channel, connectionRevision: row.revision }, actor: { id: value.actor?.id, kind: value.actor?.kind } });
      const trusted = bind(event);
      if (typeof event.normalize === 'function') trusted.normalize = async () => bind(await event.normalize());
      return ingestChannelEvent(store.orchestration, trusted, connectionPolicy(row), {
        recheck: normalized => authorize(channel, { operation: 'receive', source: normalized.source, actor: normalized.actor }, { expectedRevision: row.revision }),
        onInbound: (normalized, result) => onInbound?.(normalized, result, { sessionKey: channelSessionKey(normalized.source) }),
      });
    },
  };
}
