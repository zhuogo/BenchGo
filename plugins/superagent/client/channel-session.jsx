import React from 'react';
import { channelMessageRecordOf } from '../src/channel-session-record.mjs';

/** Display-only plugin records use the host's context renderer, never its inbox. */
export const channelMessageDefinition = {
  kind: 'benchgo-channel-message', target: 'chat',
  match(event) {
    const record = channelMessageRecordOf(event);
    return record ? { id: record.mirrorKey, role: 'start' } : null;
  },
  start(_context, match) {
    const event = match.event, record = channelMessageRecordOf(event);
    return { kind: 'context', seq: event.seq, time: event.time,
      content: [{ type: 'text', text: record.text }],
      source: { kind: 'benchgo-channel', form: 'notice', summary: record.direction === 'inbound' ? '渠道消息' : '渠道交付回执',
        channelSource: record.source, mirrorKey: record.mirrorKey, direction: record.direction },
      producer: { role: 'inject', label: 'benchgo-channel' }, form: 'notice' };
  },
  update(context) { return context.state; },
  buildViewNode(context) {
    if (!context.start || !context.state) return null;
    return { key: context.key, kind: 'context', id: context.id, target: 'chat',
      anchorSeq: context.start.event.seq, location: context.start.location,
      visibility: 'visible', data: context.state };
  },
};

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
  dispose.push(ctx.effect(() => ctx.uiConversation.events.register(channelMessageDefinition)));
  return () => { for (const cleanup of dispose) cleanup(); };
}
