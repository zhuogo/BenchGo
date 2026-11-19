import React from 'react';
import { voiceRecordOf } from './conversation-records.mjs';

const NODE_KIND = 'benchgo-voice-message';
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function recordState(event, previous) {
  const record = voiceRecordOf(event);
  if (record.kind === 'handoff') return { ...previous, linked: previous?.linked || nonempty(record.userMessageId) };
  if (record.kind === 'execution') return { kind: record.kind };
  if (record.kind === 'call-start') return { kind: record.kind, time: record.startedAt ?? event.time };
  return { kind: record.kind, text: typeof record.text === 'string' ? record.text : '',
    seq: previous?.seq ?? event.seq, time: previous?.time ?? event.time,
    linked: previous?.linked === true, partial: record.partial === true };
}

/** Claim durable call records while keeping spoken dialogue out of the executor. */
export const voiceMessageDefinition = {
  kind: NODE_KIND, target: 'chat',
  match(event) {
    const record = voiceRecordOf(event);
    if (!record) return null;
    const identity = record.kind === 'handoff' || record.kind === 'user' ? 'user'
      : record.kind === 'assistant' ? ['assistant', record.messageId || record.requestId]
        : [record.kind, record.kind === 'call-start' ? record.callId : record.messageId || event.seq];
    return { id: JSON.stringify([record.callId, record.requestId, identity]), role: 'start' };
  },
  start(_context, match) { return recordState(match.event); },
  update(context, match) { return recordState(match.event, context.state); },
  buildViewNode(context) {
    if (!context.start || !context.state) return null;
    const state = context.state;
    return { key: context.key, kind: NODE_KIND, id: context.id, target: 'chat',
      anchorSeq: context.start.event.seq, location: context.start.location,
      visibility: state.kind === 'call-start' ? 'visible' : 'hidden', data: state };
  },
};

export function registerVoiceConversationRows(ctx) {
  ctx.effect(() => ctx.uiConversation.events.register(voiceMessageDefinition));
  ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: NODE_KIND }, VoiceCallStartRow)));
}

/** A durable Session milestone, never a user prompt or an executor turn. */
export function VoiceCallStartRow({ node }) {
  if (node?.data?.kind !== 'call-start') return null;
  const time = node.data.time, date = new Date(time), valid = Number.isFinite(time) && Number.isFinite(date.getTime());
  return <div data-voice-call-start style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', color: 'var(--dsw-alias-label-secondary, #777)', fontSize: 13 }}>
    <span>语音通话已开始</span>{valid && <time dateTime={date.toISOString()} title={date.toLocaleString()}>{date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}
  </div>;
}
