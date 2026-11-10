import { Tooltip } from '../../shared/client/ui/tooltip.jsx';
import React from 'react';

/** Source is supplied by the official summary projection; navigation and input
 * remain the ordinary workspace session implementation. */
export function registerChannelSessionRows(ctx) {
  function ChannelSource({ sessionId, useSessions }) {
    const source = useSessions(list => list.byId[sessionId]?.projectionValues?.benchgoChannelSource);
    if (!source?.channel) return null;
    const label = `${source.channel} · ${source.sourceType}`;
    return <Tooltip label={`渠道来源：${label}`}><span tabIndex={0} aria-label={`渠道来源：${label}`}>{source.channel}</span></Tooltip>;
  }
  return ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({
    name: 'sidebar.session.row.trailing', id: 'benchgo-channel-source', order: 90,
  }, ChannelSource));
}
