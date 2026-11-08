import React from 'react';

/** Source is supplied by the official summary projection; navigation and input
 * remain the ordinary workspace session implementation. */
export function registerChannelSessionRows(ctx) {
  function ChannelSource({ sessionId, useSessions }) {
    const source = useSessions(list => list.byId[sessionId]?.projectionValues?.benchgoChannelSource);
    if (!source?.channel) return null;
    const label = `${source.channel} · ${source.sourceType}`;
    return <span title={`渠道来源：${label}`} aria-label={`渠道来源：${label}`}>{source.channel}</span>;
  }
  const dispose = ['sidebar.session.row.trailing', 'benchgo.sidebar.session.row.trailing'].map(name => ctx.slots.inject(name, () => ctx.slots.register({
    name, id: 'benchgo-channel-source', order: 90,
  }, ChannelSource)));
  return () => { for (const cleanup of dispose) cleanup(); };
}
