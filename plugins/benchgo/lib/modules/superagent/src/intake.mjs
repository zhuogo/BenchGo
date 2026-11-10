import { ticketStopped } from './ticket-lifecycle.mjs';
import { createHash } from 'node:crypto';
import { channelSourceAllowed, sourceTypes } from './channel-policy.mjs';

function sourceCheck(event, policy) {
  const source = event?.source;
  const owner = event?.actor?.kind === 'human' && policy.ownerIds?.includes(event.actor.id);
  const platformHuman = event?.actor?.kind === 'human' && policy.allowHumanRequests === true;
  const machine = event?.actor?.kind === 'machine';
  const allowedActor = !source?.selfOrigin && !source?.replyLoop && !!(owner || platformHuman || (machine ? policy.machineIds : policy.actorIds)?.includes(event?.actor?.id));
  const valid = !!source && sourceTypes.includes(source.sourceType) && source.channel === event.channel && (!event.sourceType || event.sourceType === source.sourceType)
    && (source.sourceType === 'system' || typeof source.conversationId === 'string' && !!source.conversationId && typeof source.chatId === 'string' && !!source.chatId)
    && (source.sourceType !== 'topic' || typeof source.topicId === 'string' && !!source.topicId);
  const allowedThread = valid && (policy.config ? channelSourceAllowed(policy.config, source, policy.connection)
    : policy.sourceAllowed !== false && (!policy.threadIds || policy.threadIds.includes(source.conversationId)));
  return { owner: !!owner, platformHuman, machine, allowedActor, allowedThread, valid };
}

/** Protocol adapters expose metadata before reading/normalizing message bodies. */
export async function ingestChannelEvent(database, envelope, policy, { onInbound, recheck } = {}) {
  if (!policy?.version) throw new Error('事件缺少现行规则');
  const checked = sourceCheck(envelope, policy);
  if (!checked.allowedThread || !checked.allowedActor) return { ignored: true, requiresEval: false,
    gate: { allowed: false, strength: 'ignore', reason: !checked.allowedThread ? 'channelDenied' : 'actorDenied' } };
  const identityOf = value => JSON.stringify([value.channel, value.sourceKey, value.threadId, value.messageId, value.sourceType, value.actor?.id, value.actor?.kind, value.source]);
  const identity = identityOf(envelope);
  const event = typeof envelope.normalize === 'function' ? await envelope.normalize() : envelope;
  if (!event) return { ignored: true, requiresEval: false, gate: { allowed: false, strength: 'ignore', reason: 'protocolRejected' } };
  if (identityOf(event) !== identity) throw new Error('消息归一不得修改已核实的来源身份');
  await recheck?.(event);
  const requested = event.source.sourceType === 'direct' || checked.machine || event.mentioned === true;
  const subscribed = database.subscriptions?.({ threadId: event.threadId })?.some(row => database.getTicket(row.ticketId)?.status !== 'completed' && !ticketStopped(database.getTicket(row.ticketId)));
  if (!requested && !subscribed) return { ignored: true, requiresEval: false, gate: { allowed: false, strength: 'ignore', reason: 'notMentioned' } };
  const accepted = ingestAssistantEvent(database, event, { ...policy, routeDirect: true, intakeStage: 'pending' });
  const intakeEvent = database.readIntakeEvent(accepted.trigger.id);
  const result = { ...accepted, intakeEvent, trigger: database.getTrigger(intakeEvent.id) || null };
  await onInbound?.(event, result);
  return result;
}

/** Trusted adapters supply actor identity; callers cannot grant themselves ownership. */
export function ingestAssistantEvent(database, event, policy) {
  if (!event || typeof event.text !== 'string' || !event.sourceKey || !event.threadId) throw new Error('事件缺少原文或来源');
  if (!policy || typeof policy.version !== 'string' || !policy.version) throw new Error('事件缺少现行规则');
  const { owner, machine, platformHuman, allowedActor, allowedThread, valid } = sourceCheck(event, policy);
  const sourceType = event.source?.sourceType;
  const direct = sourceType === 'direct' && (owner || platformHuman || allowedActor);
  const superseded = database.sourceMessageSuperseded?.({ source: event.source, actor: event.actor, createdAt: event.occurredAt }) === true;
  const allowed = allowedThread && allowedActor && (direct || machine || (['group', 'topic'].includes(sourceType) && event.mentioned === true));
  const explicit = allowed && event.actor?.kind === 'human';
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
    gate: { allowed: !!allowed, strength: allowed ? (machine ? 'inferred' : 'explicit') : 'ignore', reason: !allowedThread ? 'channelDenied' : !allowedActor ? 'actorDenied' : !direct && !machine && !event.mentioned ? 'notMentioned' : 'allowed',
      evidence: { sourceVerified: valid && !!allowedThread && allowedActor, ownerVerified: owner && !!allowedThread,
        sourceType, connectionId: event.source?.connectionId, conversationId: event.source?.conversationId, mentioned: event.mentioned === true } },
  };
  const accepted = database.ingest(input);
  // The attention store additionally requires the original requester's identity.
  const attention = !superseded && database.answerAttention?.(accepted.trigger.id, { ownerAllowed: !!((owner || platformHuman) && allowedThread) });
  if (attention) return { ...accepted, requiresEval: false, gate: input.gate, direct: false, attention, delivery: null, ambiguousSubscription: false };
  // Existing subscriptions carry context only, including unmentioned messages.
  const subscriptions = database.subscriptions({ threadId: event.threadId }).filter(row => database.getTicket(row.ticketId)?.status !== 'completed' && !ticketStopped(database.getTicket(row.ticketId)));
  let delivery = null;
  if (!explicit && !superseded && subscriptions.length === 1 && allowedThread && allowedActor && accepted.trigger.seq > subscriptions[0].cursorSeq) delivery = database.deliverSubscribedMessage(accepted.trigger.id, { ticketId: subscriptions[0].ticketId });
  return { ...accepted, gate: input.gate, direct: !!(direct && allowed), delivery, ambiguousSubscription: subscriptions.length > 1 };
}
