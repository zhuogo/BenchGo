import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import { z } from 'zod';
import { channelSessionKey, sourceTypes } from './channel-policy.mjs';
import { channelMessageRecordOf, channelMessageRecordType } from './channel-session-record.mjs';

export const channelSessionProjectionKey = 'benchgoChannelSource';
export const channelMessageKind = 'benchgo-channel';
const sourceSchema = z.object({ channel: z.string(), sourceType: z.enum(sourceTypes), conversationId: z.string().nullable().optional(), topicId: z.string().nullable().optional() }).nullable();

export function applyChannelSessionSource(state, event) {
  const source = event.type === 'user/message' && event.data?.source;
  // Existing valid raw mirrors remain readable for source history and audit;
  // all new writes are non-surface plugin records.
  const value = channelMessageRecordOf(event)?.source ?? (source?.kind === channelMessageKind ? source.channelSource : null);
  if (!value) return state;
  return sourceSchema.parse({ channel: value.channel, sourceType: value.sourceType,
    ...(value.conversationId === undefined ? {} : { conversationId: value.conversationId }),
    ...(value.topicId === undefined ? {} : { topicId: value.topicId }) });
}

export async function registerChannelSessionProjection(ctx) {
  return ctx.sessionProjections.register({ key: channelSessionProjectionKey, stateVersion: 1,
    stateSchema: sourceSchema, init: () => null, apply: applyChannelSessionSource,
    wire: { viewSchema: sourceSchema, view: state => state } });
}

/** Mirror the existing central trigger/outbox into ordinary official sessions.
 * No followup, model request, adapter state or second delivery ledger is created. */
export function createChannelSessionHost({ ctx, store, engine, receiveOwnerMessage, appendRecord = appendPluginRecord }) {
  const pending = new Map();
  const serial = (key, operation) => {
    const next = (pending.get(key) || Promise.resolve()).catch(() => {}).then(operation);
    pending.set(key, next);
    return next.finally(() => { if (pending.get(key) === next) pending.delete(key); });
  };
  async function mirror({ source, threadId, key, text, direction, deliveredAt, sessionKey = channelSessionKey(source) }) {
    return serial(sessionKey, async () => {
      const existing = (await store.getState()).threads.find(row => row.sourceKey === sessionKey);
      // Replaying the central sent ledger must not resurrect deleted history.
      // Only an actual inbound event can establish a new source conversation.
      if (direction === 'delivery' && (!existing || !Number.isFinite(Date.parse(existing.createdAt))
        || !Number.isFinite(Date.parse(deliveredAt)) || Date.parse(deliveredAt) < Date.parse(existing.createdAt))) return null;
      const thread = direction === 'delivery' ? existing : await engine.ensureSourceThread({ sourceKey: sessionKey,
        title: `${source.channel} · ${source.topicId || source.conversationId || source.sourceType}`,
        source: { ...source, threadId: threadId || source.threadId || existing?.source?.threadId } });
      const agent = await engine.ensureSession({ threadId: thread.id });
      const persisted = await ctx.sessionQuery.readSession(agent.session.id);
      if (!persisted.events.some(event => channelMessageRecordOf(event)?.mirrorKey === key
        || event.type === 'user/message' && event.data?.source?.kind === channelMessageKind && event.data.source.mirrorKey === key)) {
        appendRecord(agent.session, channelMessageRecordType, { mirrorKey: key, direction,
          source: structuredClone(source), text });
      }
      // A successful mirror is durable before the ingress/delivery hook returns.
      await ctx.sessions.flush(agent.session);
      return { threadId: thread.id, sessionId: agent.session.id };
    });
  }
  return {
    async onInbound(event, result, { sessionKey } = {}) {
      if (!result?.intakeEvent?.id) throw new Error('渠道会话需要已持久化的真实来源原文');
      if (sessionKey !== undefined && sessionKey !== channelSessionKey(event.source)) throw new Error('渠道会话标识不匹配');
      return mirror({ source: event.source, threadId: event.threadId, sessionKey,
        key: `intake:${result.intakeEvent.id}`, text: event.text, direction: 'inbound' });
    },
    async onDelivery(outbox) {
      if (outbox?.state !== 'sent' || outbox.receipt?.status !== 'accepted' || !outbox.receipt.messageId) return null;
      const source = outbox.payload?.source ?? outbox.source;
      if (!source?.channel || source.channel === 'desktop') return null;
      const text = outbox.payload?.publication?.text ?? outbox.payload?.text ?? outbox.text;
      if (typeof text !== 'string' || !text) return null;
      return mirror({ source, threadId: outbox.threadId || source.threadId, key: `delivery:${outbox.kind || 'ticket'}:${outbox.id}`,
        text, direction: 'delivery', deliveredAt: outbox.sentAt ?? outbox.updatedAt });
    },
    async onSourceMessage(input) {
      const { thread, sessionId, message } = input;
      const saved = (await store.getState()).threads.find(row => row.id === thread.id);
      if (!saved || saved.sessionId !== sessionId || saved.sourceKey !== channelSessionKey(saved.source)
        || message?.source?.kind !== 'user') throw new Error('渠道会话来源不匹配');
      if (typeof receiveOwnerMessage !== 'function') throw new Error('渠道回复入口不可用');
      return receiveOwnerMessage({ ...input, thread: saved });
    },
  };
}
