import { ticketStopped } from './ticket-lifecycle.mjs';
import { createHash } from 'node:crypto';
import { channelAdmissionCheck } from './channel-policy.mjs';

/** Protocol adapters expose metadata before reading/normalizing message bodies. */
export async function ingestChannelEvent(database, envelope, policy, { onInbound, recheck } = {}) {
  if (!policy?.version) throw new Error('事件缺少现行规则');
  const checked = channelAdmissionCheck(envelope, policy);
  if (!checked.allowedThread || !checked.allowedActor) return { ignored: true, requiresEval: false,
    gate: { allowed: false, strength: 'ignore', reason: !checked.allowedThread ? 'channelDenied' : 'actorDenied' } };
  const identityOf = value => JSON.stringify([value.channel, value.sourceKey, value.threadId, value.messageId, value.sourceType, value.actor?.id, value.actor?.kind, value.source]);
  const identity = identityOf(envelope);
  const event = typeof envelope.normalize === 'function' ? await envelope.normalize() : envelope;
  if (!event) return { ignored: true, requiresEval: false, gate: { allowed: false, strength: 'ignore', reason: 'protocolRejected' } };
  if (identityOf(event) !== identity) throw new Error('消息归一不得修改已核实的来源身份');
  await recheck?.(event);
  const subscribed = database.subscriptions?.({ threadId: event.threadId })?.some(row => database.getTicket(row.ticketId)?.status !== 'completed' && !ticketStopped(database.getTicket(row.ticketId)));
  if (!checked.requested && !subscribed) return { ignored: true, requiresEval: false, gate: { allowed: false, strength: 'ignore', reason: 'notMentioned' } };
  const accepted = ingestAssistantEvent(database, event, { ...policy, routeDirect: true, intakeStage: 'pending' });
  const intakeEvent = database.readIntakeEvent(accepted.trigger.id);
  const result = { ...accepted, intakeEvent, trigger: database.getTrigger(intakeEvent.id) || null };
  await onInbound?.(event, result);
  return result;
}

/** Trusted adapters supply admission; the intake preserves source attribution. */
export function ingestAssistantEvent(database, event, policy) {
  if (!event || typeof event.text !== 'string' || !event.sourceKey || !event.threadId) throw new Error('事件缺少原文或来源');
  if (!policy || typeof policy.version !== 'string' || !policy.version) throw new Error('事件缺少现行规则');
  const { explicit, direct, allowed, strength, reason, allowedActor, allowedThread, valid } = channelAdmissionCheck(event, policy);
  const sourceType = event.source?.sourceType;
  const superseded = database.sourceMessageSuperseded?.({ source: event.source, actor: event.actor, createdAt: event.occurredAt }) === true;
  const input = {
    id: `trigger:${createHash('sha256').update(event.sourceKey).digest('hex')}`,
    dedupeKey: event.sourceKey,
    thread: { id: event.threadId, source: { type: event.channel, id: event.threadId } },
    source: { ...event.source, mentioned: event.mentioned === true },
    actor: { id: event.actor.id, kind: event.actor.kind },
    content: event.text,
    createdAt: event.occurredAt,
    ...(policy.intakeStage ? { intakeStage: policy.intakeStage } : {}),
    // External direct messages need the same durable Router queue as mentions.
    // The legacy direct mode is retained for callers that own their own Router.
    mode: direct && allowed && !policy.routeDirect ? 'direct' : 'group',
    policyVersion: policy.version,
    subscriptionEligible: !!allowedThread && allowedActor && !superseded && !explicit,
    gate: { allowed: !!allowed, strength, reason,
      evidence: { sourceVerified: valid && !!allowedThread && allowedActor,
        sourceType, connectionId: event.source?.connectionId, conversationId: event.source?.conversationId, mentioned: event.mentioned === true } },
  };
  const accepted = database.ingest(input);
  // The attention store additionally requires the original requester's identity.
  const attention = !superseded && database.answerAttention?.(accepted.trigger.id, { sourceAllowed: !!(allowedActor && allowedThread) });
  if (attention) return { ...accepted, requiresEval: false, gate: input.gate, direct: false, attention, delivery: null, ambiguousSubscription: false };
  // Existing subscriptions carry context only, including unmentioned messages.
  const subscriptions = database.subscriptions({ threadId: event.threadId }).filter(row => database.getTicket(row.ticketId)?.status !== 'completed' && !ticketStopped(database.getTicket(row.ticketId)));
  let delivery = null;
  if (!explicit && !superseded && subscriptions.length === 1 && allowedThread && allowedActor && accepted.trigger.seq > subscriptions[0].cursorSeq) delivery = database.deliverSubscribedMessage(accepted.trigger.id, { ticketId: subscriptions[0].ticketId });
  return { ...accepted, gate: input.gate, direct: !!(direct && allowed), delivery, ambiguousSubscription: subscriptions.length > 1 };
}
