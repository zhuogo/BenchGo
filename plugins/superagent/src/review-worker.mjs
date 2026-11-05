import { randomUUID } from 'node:crypto';

/**
 * Durable, single-owner worker for the assistant review queue.
 *
 * The queue owns the lease and daily quota.  This module only coordinates
 * claiming, bounded processing and result persistence. The processor may persist
 * policy-checked memories and skill candidates, but must not mutate permissions,
 * Tickets or external systems. A failed item remains pending while retryable.
 */
export function createAssistantReviewWorker({
  review,
  process,
  workerId = `review-worker-${randomUUID()}`,
  batchSize = 1,
  leaseMs = 60_000,
  maxAttempts = 3,
  intervalMs = 30_000,
  logger,
} = {}) {
  if (!review?.claim || !review?.complete || !review?.fail) throw new Error('review worker 缺少队列');
  if (typeof process !== 'function') throw new Error('review worker 缺少处理器');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10) throw new Error('review worker 批量数量无效');
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3600000) throw new Error('review worker 租约无效');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new Error('review worker 重试次数无效');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3600000) throw new Error('review worker 间隔无效');
  let closed = false;
  let running = null;
  let timer = null;
  let stopController = new AbortController();

  const runOnce = async () => {
    if (closed) return { workerId, claimed: 0, completed: 0, failed: 0, retried: 0, skipped: true };
    if (running) return running;
    running = (async () => {
      const claim = review.claim({ workerId, limit: batchSize, leaseMs });
      let completed = 0, failed = 0, retried = 0;
      for (const item of claim.items) {
        if (item.attempts > maxAttempts) {
          try { review.fail(item.id, { workerId, error: `review attempts exceeded ${maxAttempts}` }); } catch (error) { logger?.warn?.(`Assistant review exhaustion commit failed: ${error.message}`); }
          failed += 1;
          continue;
        }
        try {
          const timeout = AbortSignal.timeout(leaseMs);
          const signal = AbortSignal.any ? AbortSignal.any([timeout, stopController.signal]) : timeout;
          const result = await process(item, { workerId, signal });
          const status = result?.status === 'rejected' ? 'rejected' : result?.status === 'pending' ? 'pending' : 'completed';
          review.complete(item.id, { workerId, result: result ?? { candidate: true }, status });
          completed += 1;
        } catch (error) {
          const message = String(error?.message || error || 'review failed').slice(0, 4000);
          // A retry is represented by the normal pending state.  The queue
          // attempt counter is authoritative, so a crashed worker can resume.
          if (item.attempts < maxAttempts) {
            try { review.complete(item.id, { workerId, result: { candidate: false, retryable: true, error: message }, status: 'pending' }); retried += 1; }
            catch (retryError) { logger?.warn?.(`Assistant review retry failed: ${retryError.message}`); failed += 1; }
          } else {
            try { review.fail(item.id, { workerId, error: message }); } catch (failError) { logger?.warn?.(`Assistant review failure commit failed: ${failError.message}`); }
            failed += 1;
          }
        }
      }
      return { workerId, claimed: claim.items.length, completed, failed, retried, budget: claim.budget };
    })();
    try { return await running; } finally { running = null; }
  };
  const tick = () => runOnce().catch(error => { logger?.warn?.(`Assistant review worker: ${error.message}`); return { workerId, error: error.message }; });
  const start = () => {
    if (closed || timer) return;
    stopController = new AbortController();
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  };
  const stop = async () => {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    stopController.abort();
    if (running) await running.catch(() => {});
  };
  return { workerId, runOnce, tick, start, stop, dispose: stop };
}
