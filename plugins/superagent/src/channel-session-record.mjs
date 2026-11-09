/** Display-only mirror in the owning official Session; never model input or authority. */
export const channelMessageRecordType = 'plugin:benchgo-plugin/channel-message';

export function channelMessageRecordOf(event) {
  const value = event?.data;
  return event?.type === channelMessageRecordType && event.ignorable === true
    && value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.mirrorKey === 'string' && value.mirrorKey.length > 0
    && ['inbound', 'delivery'].includes(value.direction) && typeof value.text === 'string'
    && value.source && typeof value.source === 'object' && !Array.isArray(value.source)
    && typeof value.source.channel === 'string' && value.source.channel.length > 0
    && typeof value.source.sourceType === 'string' && value.source.sourceType.length > 0
    ? value : null;
}
