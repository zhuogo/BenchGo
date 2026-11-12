import { randomUUID } from 'node:crypto';
import { authorizeAssessment } from './assessment-policy.mjs';
import { sendSourceDelivery, deliveryLease } from './source-delivery.mjs';
import { channelSourceAllowed } from './channel-policy.mjs';
import { isDeepStrictEqual } from 'node:util';

/** Durable human-facing answers share channel transports, never invent Tickets. */
export function createDirectReplyDelivery({ database, readPolicy, getAdapter, signal, onDelivered }) {
  const owner = `direct-reply:${randomUUID()}`;
  let running;
  async function cycle() {
    if (signal.aborted) return;
    for (const row of database.claimDirectReplies({ owner, limit: 1, leaseMs: 60000 })) {
      if (signal.aborted) return;
      const lease = deliveryLease(() => database.renewDirectReply(row.id, { owner }));
      try {
      let policy;
      try { policy = await readPolicy(row.threadId); }
      catch {
        database.finishDirectReply(row.id, { owner, error: '当前权限暂不可核实', retryMs: 30000 });
        continue;
      }
      const trigger = database.getTrigger(row.triggerId);
      const ownerReply = row.kind === 'owner';
      const target = ownerReply ? row.source : trigger?.source;
      const connection = policy.connections?.[target?.channel];
      const permission = ownerReply ? { allowed: trigger?.actor.id === 'desktop-owner' && trigger.actor.kind === 'human'
        && trigger.source.channel === 'desktop' && trigger.source.kind === 'channel-owner-reply' && trigger.content === row.text
        && isDeepStrictEqual(trigger.source.deliveryTarget, target)
        && channelSourceAllowed(target.channel === 'feishu' ? policy.connection : connection?.config, target, connection) }
        : trigger && authorizeAssessment({ policy, candidate: { gate: row.gate }, trigger, decision: { outcome: row.kind } });
      if (!trigger || trigger.threadId !== row.threadId || !permission?.allowed) {
        database.finishDirectReply(row.id, { owner, suppressed: true, error: '来源或授权已变更' });
        continue;
      }
      const adapter = getAdapter(target.channel);
      if (!adapter?.send) {
        database.finishDirectReply(row.id, { owner, error: '来源交付服务不可用', retryMs: 30000 });
        continue;
      }
      if (signal.aborted) return;
      lease.check();
      await sendSourceDelivery({ send: () => adapter.send({ source: target, text: row.text, idempotencyKey: `direct-reply:${row.id}` }),
        finish: options => database.finishDirectReply(row.id, { owner, ...options }), onDelivered });
      } finally { lease.stop(); }
    }
  }
  return { tick: () => running ||= cycle().finally(() => { running = undefined; }), stop: () => running };
}
