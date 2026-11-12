import { knownNotSent } from './channels/delivery-outcome.mjs';

/** Shared send/receipt boundary for both durable source outboxes. */
export async function sendSourceDelivery({ send, finish, onDelivered, durableDeduplication = false }) {
  let saved;
  try {
    const receipt = await send();
    if (receipt?.status !== 'accepted' || !receipt.messageId) throw new Error('来源未返回确定回执');
    saved = finish({ sent: true, receipt });
  } catch (error) {
    const notSent = durableDeduplication || knownNotSent(error);
    return finish({ uncertain: !notSent, retryMs: 30000,
      error: notSent ? '来源确认未发送，等待恢复后重试' : '来源发送结果待核实',
      ...(error?.receipt ? { receipt: error.receipt } : {}) });
  }
  // Projection errors cannot undo a durable remote receipt or cause another send.
  try { await onDelivered?.(saved); } catch { /* Replayed separately from sending. */ }
  return saved;
}

export function deliveryLease(renew, intervalMs = 20000) {
  let failure;
  const timer = setInterval(() => { try { renew(); } catch (error) { failure ||= error; } }, intervalMs);
  timer.unref?.();
  return { check() { if (failure) throw failure; }, stop() { clearInterval(timer); } };
}
