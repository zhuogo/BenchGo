export const personalChannels = new Set(['wecom', 'weixin', 'qq', 'telegram']);

/** Keep platform identifiers available for manual configuration before admission. */
export function createPersonalChannelSources() {
  const channels = new Map();
  return {
    observe(channel, revision, source, actor) {
      if (!personalChannels.has(channel) || source?.channel !== channel || source.selfOrigin || actor?.kind !== 'human') return;
      if (!['direct', 'group', 'topic'].includes(source.sourceType)
        || ![actor.id, source.conversationId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value))) return;
      if (channels.get(channel)?.revision !== revision) channels.set(channel, { revision, rows: new Map() });
      const { rows } = channels.get(channel);
      const entry = { actorId: actor.id, ...(source.sourceType === 'direct' ? {} : { groupId: source.conversationId }) };
      const key = JSON.stringify(entry);
      rows.delete(key);
      rows.set(key, entry);
      if (rows.size > 20) rows.delete(rows.keys().next().value);
    },
    list(channel, revision) {
      const current = channels.get(channel);
      return current?.revision === revision ? Array.from(current.rows.values(), row => ({ ...row })).reverse() : [];
    },
  };
}
