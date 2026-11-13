import { randomUUID } from 'node:crypto';

const yieldError = reason => Object.assign(new Error(String(reason || 'user-activity')), { code: 'REVIEW_YIELD' });
async function abortable(work, signal) {
  signal.throwIfAborted();
  let listener;
  const aborted = new Promise((resolve, reject) => { listener = () => reject(signal.reason || new Error('review aborted')); signal.addEventListener('abort', listener, { once: true }); });
  try { return await Promise.race([work(), aborted]); }
  finally { signal.removeEventListener('abort', listener); }
}

/** The only review executor. beforeRun shares the existing tick; no scheduler
 * creates sessions, Router turns, tasks or a second set of module timers.
 * Processors must honour signal before every write and watermark commit. */
export function createAssistantReviewWorker({ review, process, beforeRun, shouldRun, workerId = `review-worker-${randomUUID()}`,
  batchSize = 1, leaseMs = 60_000, maxAttempts = 3, intervalMs = 30_000, logger } = {}) {
  if (!review?.claim || !review?.complete || !review?.fail) throw new Error('review worker 缺少队列');
  if (typeof process !== 'function') throw new Error('review worker 缺少处理器');
  if (beforeRun !== undefined && typeof beforeRun !== 'function' || shouldRun !== undefined && typeof shouldRun !== 'function') throw new Error('review worker 调度钩子无效');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10) throw new Error('review worker 批量数量无效');
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3600000) throw new Error('review worker 租约无效');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new Error('review worker 重试次数无效');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3600000) throw new Error('review worker 间隔无效');
  let closed = false, running = null, timer = null, active = null, controller = null, revision = 0, lastResult = null;
  let state = 'idle', lastCheckAt = null, nextCheckAt = null, lastYieldAt = null;
  const interrupt = (reason = 'user-activity') => { revision++; lastYieldAt = new Date().toISOString(); state = closed ? 'disabled' : 'yielded'; controller?.abort(yieldError(reason)); };
  const allowed = async item => !closed && (!shouldRun || await shouldRun(item));
  const release = (item, reason, refundBudget = false) => {
    if (review.release) review.release(item.id, { workerId, reason, refundBudget });
    else review.complete(item.id, { workerId, status: 'pending', result: { yielded: true, reason } });
  };
  const runOnce = async () => {
    if (closed) return { workerId, claimed: 0, completed: 0, failed: 0, retried: 0, yielded: 0, skipped: true };
    if (running) return running;
    const startRevision = revision;
    lastCheckAt = new Date().toISOString();
    nextCheckAt = timer ? new Date(Date.now() + intervalMs).toISOString() : null;
    state = 'checking';
    running = (async () => {
      let claimed = 0, completed = 0, failed = 0, retried = 0, yielded = 0, budget;
      await beforeRun?.();
      for (let index = 0; index < batchSize; index++) {
        if (closed || startRevision !== revision) break;
        const pending = review.list?.({ status: 'pending', limit: 1 })?.[0];
        if (!await allowed(pending) || startRevision !== revision) { state = 'yielded'; lastYieldAt = new Date().toISOString(); break; }
        const claim = review.claim({ workerId, limit: 1, leaseMs });
        budget = claim.budget;
        const item = claim.items[0];
        if (!item) break;
        claimed++;
        if (!await allowed(item) || startRevision !== revision) { release(item, 'user-activity', true); state = 'yielded'; lastYieldAt = new Date().toISOString(); yielded++; break; }
        if (item.attempts > maxAttempts) { review.fail(item.id, { workerId, error: `review attempts exceeded ${maxAttempts}` }); failed++; continue; }
        controller = new AbortController();
        const timeout = AbortSignal.timeout(Math.max(1, Date.parse(item.leaseUntil) - Date.now()));
        const signal = AbortSignal.any([timeout, controller.signal]);
        active = { id: item.id, kind: item.kind, task: item.payload?.task || (item.kind === 'learning' ? 'memory-upkeep' : item.kind), startedAt: new Date().toISOString(), deadlineAt: item.leaseUntil };
        state = 'running';
        try {
          const result = await abortable(() => process(item, { workerId, signal }), signal);
          signal.throwIfAborted();
          const status = ['rejected', 'pending'].includes(result?.status) ? result.status : 'completed';
          review.complete(item.id, { workerId, result: result ?? { candidate: true }, status,
            refundBudget: status !== 'pending' && result?.modelUsed === false });
          completed++;
        } catch (error) {
          const message = String(error?.message || error || 'review failed').slice(0, 4000);
          if (controller.signal.aborted) { release(item, message); yielded++; break; }
          if (item.attempts < maxAttempts) {
            try { review.complete(item.id, { workerId, result: { candidate: false, retryable: true, error: message }, status: 'pending' }); retried++; }
            catch (retryError) { logger?.warn?.(`Assistant review retry failed: ${retryError.message}`); failed++; }
          } else {
            try { review.fail(item.id, { workerId, error: message }); } catch (failError) { logger?.warn?.(`Assistant review failure commit failed: ${failError.message}`); }
            failed++;
          }
        } finally { active = null; controller = null; }
      }
      lastResult = { workerId, claimed, completed, failed, retried, yielded, ...(budget ? { budget: review.budget?.() || budget } : {}), finishedAt: new Date().toISOString() };
      if (!closed && state !== 'yielded') state = 'idle';
      return lastResult;
    })();
    try { return await running; } finally { running = null; if (!active && state === 'checking') state = closed ? 'disabled' : 'idle'; }
  };
  const tick = () => runOnce().catch(error => { logger?.warn?.(`Assistant review worker: ${error.message}`); return { workerId, error: error.message }; });
  const start = () => { if (closed || timer) return; timer = setInterval(tick, intervalMs); timer.unref?.(); nextCheckAt = new Date(Date.now() + intervalMs).toISOString(); };
  const stop = async () => { closed = true; if (timer) clearInterval(timer); timer = null; nextCheckAt = null; interrupt('stopped'); if (running) await running.catch(() => {}); };
  return { workerId, runOnce, tick, start, stop, dispose: stop, interrupt,
    status: () => ({ workerId, enabled: !closed, schedulerActive: !!timer, state, running: !!active, active: active ? { ...active } : null,
      deadlineAt: active?.deadlineAt || null, lastCheckAt, nextCheckAt, lastYieldAt, lastResult: lastResult ? structuredClone(lastResult) : null }) };
}
