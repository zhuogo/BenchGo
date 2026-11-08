import { randomUUID } from 'node:crypto';
import { authorizeAssessment } from './assessment-policy.mjs';
import { knownNotSent } from './channels/delivery-outcome.mjs';
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
      if (!trigger || trigger.threadId !== row.threadId || !ownerReply && row.policyVersion !== policy.version || !permission?.allowed) {
        database.finishDirectReply(row.id, { owner, suppressed: true, error: '来源或授权已变更' });
        continue;
      }
      const adapter = getAdapter(target.channel);
      if (!adapter?.send) {
        database.finishDirectReply(row.id, { owner, error: '来源交付服务不可用', retryMs: 30000 });
        continue;
      }
      if (signal.aborted) return;
      try {
        const receipt = await adapter.send({ source: target, text: row.text, idempotencyKey: `direct-reply:${row.id}` });
        if (receipt?.status !== 'accepted' || !receipt.messageId) throw new Error('No confirmed receipt');
        const saved = database.finishDirectReply(row.id, { owner, sent: true, receipt });
        // Projection is recoverable and must never turn a confirmed send into a retry.
        try { await onDelivered?.(saved); } catch { /* Runtime replays sent rows for projection recovery. */ }
      } catch (error) {
        // The remote side may already have accepted the request. Never resend blindly.
        database.finishDirectReply(row.id, { owner, uncertain: !knownNotSent(error), retryMs: 30000, receipt: error?.receipt,
          error: knownNotSent(error) ? '来源确认未发送，等待恢复后重试' : '来源发送结果待核实' });
      }
    }
  }
  return { tick: () => running ||= cycle().finally(() => { running = undefined; }), stop: () => running };
}
