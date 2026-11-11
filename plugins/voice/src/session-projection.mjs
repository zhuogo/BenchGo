import { z } from 'zod';

export const voiceSessionProjectionKey = 'benchgoVoice';
const timestamp = z.number().finite().nonnegative().nullable();
const schema = z.object({ used: z.literal(true), startedAt: timestamp, lastActivityAt: timestamp }).nullable();
const timeOf = value => Number.isFinite(value) && value >= 0 ? value : null;

/** Fold only durable Voice activity; public summaries contain no spoken text. */
export function applyVoiceSessionActivity(state, event) {
  const data = event?.data;
  if (event?.type !== 'plugin:benchgo-plugin/voice-conversation' || event.ignorable !== true || !data
    || typeof data.callId !== 'string' || !data.callId || !['call-start', 'user', 'assistant'].includes(data.kind)) return state;
  const time = timeOf(event.time) ?? timeOf(data.startedAt);
  const started = data.kind === 'call-start' ? timeOf(data.startedAt) ?? time : time;
  const first = [state?.startedAt, started].filter(value => value !== undefined && value !== null);
  const last = [state?.lastActivityAt, time].filter(value => value !== undefined && value !== null);
  const next = { used: true, startedAt: first.length ? Math.min(...first) : null, lastActivityAt: last.length ? Math.max(...last) : null };
  return state && state.startedAt === next.startedAt && state.lastActivityAt === next.lastActivityAt ? state : next;
}

export function registerVoiceSessionProjection(ctx) {
  return ctx.sessionProjections.register({ key: voiceSessionProjectionKey, stateVersion: 1,
    stateSchema: schema, init: () => null, apply: applyVoiceSessionActivity,
    wire: { viewSchema: schema, view: state => state, summary: true } });
}
