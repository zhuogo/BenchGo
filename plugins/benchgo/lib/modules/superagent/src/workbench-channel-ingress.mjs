import { createHash } from 'node:crypto';
import { channelSessionKey } from './channel-policy.mjs';
import { createUnifiedChannelIngress } from './channel-ingress.mjs';

/** Host-only official session pre-step. Never exposed as a model tool or raw HTTP action. */
export function createWorkbenchChannelIngress({ store, readPolicy, wake = () => {} }) {
  const ingress = createUnifiedChannelIngress({ store });
  return async function ingestWorkbenchChannelMessage({ thread, sessionId, message }) {
    if (!thread?.id || thread.sessionId !== sessionId || thread.sourceKey !== channelSessionKey(thread.source)
      || message?.source?.kind !== 'user' || typeof message.id !== 'string' || !message.id
      || !Array.isArray(message.content) || message.content.some(block => block?.type !== 'text' || typeof block.text !== 'string')) throw new Error('渠道直接回复需要官方来源会话中的真实用户输入');
    const text = message.content.map(block => block.text).join('\n');
    if (!text.trim() || text.length > 6000) throw new Error('渠道直接回复须为非空文字，最多6000字符；附件请使用支持的渠道发送');
    const source = structuredClone(thread.source);
    if (typeof source.threadId !== 'string' || !source.threadId) throw new Error('渠道来源缺少统一输入账标识');
    const ledgerThreadId = source.threadId;
    ingress.authorize(source.channel, { operation: 'send', source });
    const policy = await readPolicy(ledgerThreadId);
    ingress.authorize(source.channel, { operation: 'send', source });
    const key = `workbench-channel:${sessionId}:${message.id}`;
    const accepted = store.orchestration.ingest({
      id: `trigger:${createHash('sha256').update(key).digest('hex')}`, dedupeKey: key,
      thread: { id: ledgerThreadId, source: { type: source.channel, id: ledgerThreadId } },
      source: { channel: 'desktop', kind: 'channel-owner-reply', sessionId, messageId: message.id, deliveryTarget: source },
      actor: { id: 'desktop-owner', kind: 'human' }, content: text, mode: 'direct', policyVersion: policy.version,
      gate: { allowed: true, strength: 'explicit', reason: 'official-workbench-owner-reply' },
    });
    const delivery = store.orchestration.enqueueChannelOwnerReply({ triggerId: accepted.trigger.id, source, text, policyVersion: policy.version });
    wake();
    return { ...accepted, delivery };
  };
}
