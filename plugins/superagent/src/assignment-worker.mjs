import { randomUUID } from 'node:crypto';

/** Owns execution leases. Ambiguous execution is never automatically retried. */
export function createAssistantAssignmentWorker({
  database, execute, readPolicy, validateMandate, onResult,
  workerId = `assignment-worker-${randomUUID()}`, leaseMs = 60_000,
  intervalMs = 5_000, concurrency = 1, getConcurrency, logger,
} = {}) {
  if (!database?.claimAssignments || !database?.renewAssignment) throw new Error('Assignment worker requires a database');
  for (const callback of [execute, readPolicy, validateMandate, onResult]) {
    if (typeof callback !== 'function') throw new Error('Assignment worker requires execution, policy and result callbacks');
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000) throw new Error('Invalid assignment lease');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100) throw new Error('Invalid assignment interval');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid assignment concurrency');
  let stopped = false, timer = null, running = null;
  const controllers = new Set();
  const active = new Map();

  async function perform(assignment) {
    const controller = new AbortController();
    controllers.add(controller);
    const ownership = { owner: workerId, fence: assignment.fence, leaseMs };
    let heartbeat = null, renewal = null, stage = 'execution';
    const renew = () => {
      if (renewal) return renewal;
      renewal = (async () => {
        controller.signal.throwIfAborted();
        const policy = await readPolicy();
        controller.signal.throwIfAborted();
        const result = database.renewAssignment(assignment.id, {
          ...ownership, validateMandate: (mandate, context) => validateMandate(mandate, { ...context, policy }) === true,
        });
        if (!result.allowed) throw new Error('Assignment authorization revoked');
        return result.assignment;
      })();
      return renewal.finally(() => { renewal = null; });
    };
    try {
      await renew();
      heartbeat = setInterval(() => {
        renew().catch(error => controller.abort(error));
      }, Math.max(100, Math.floor(leaseMs / 3)));
      heartbeat.unref?.();
      const ticket = database.getTicket(assignment.ticketId);
      const result = await execute(assignment, { ticket, signal: controller.signal, renew });
      await renew();
      const beforeCommit = async () => {
        clearInterval(heartbeat); heartbeat = null;
        if (renewal) await renewal;
        await renew();
      };
      // Keep leases alive during Router review; quiesce heartbeat before its
      // atomic terminal commit so a late renewal cannot revoke a completed run.
      stage = 'review';
      await onResult(result, { assignment, ticket, signal: controller.signal, beforeCommit });
      clearInterval(heartbeat); heartbeat = null;
      controller.signal.throwIfAborted();
      const state = database.getAssignment?.(assignment.id)?.state;
      if (!['completed', 'waiting', 'paused', 'queued'].includes(state)) database.finishAssignment(assignment.id, { ...ownership, status: 'completed' });
      return { id: assignment.id, status: ['waiting', 'paused', 'queued'].includes(state) ? state : 'completed' };
    } catch (error) {
      // Neither exceptions nor shutdown prove that an external action did not happen.
      try { database.recordAssignmentFailure?.(assignment.id, { ...ownership, stage, code: error?.code }); } catch { /* Preserve the original failure. */ }
      try { database.renewAssignment(assignment.id, { ...ownership, validateMandate: () => false }); }
      catch { /* Lost leases are reconciled by the store's next claim. */ }
      logger?.warn?.(`Assignment ${assignment.id}: ${error?.message || error}`);
      return { id: assignment.id, status: 'uncertain', error: String(error?.message || error) };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      controller.abort();
      controllers.delete(controller);
    }
  }

  async function runOnce() {
    if (stopped) return { claimed: 0, results: [], skipped: true };
    const batch = running ||= (async () => {
      const policy = await readPolicy();
      const configured = getConcurrency ? await getConcurrency() : concurrency;
      if (!Number.isSafeInteger(configured) || configured < 1) throw new Error('Invalid assignment concurrency');
      if (stopped) return [];
      const capacity = Math.max(0, configured - active.size);
      if (!capacity) return [];
      const assignments = database.claimAssignments(workerId, {
        leaseMs, limit: capacity,
        validateMandate: (mandate, context) => validateMandate(mandate, { ...context, policy }) === true,
      });
      return assignments.map(assignment => {
        const work = perform(assignment).finally(() => active.delete(assignment.id));
        active.set(assignment.id, work);
        return work;
      });
    })().finally(() => { running = null; });
    const jobs = await batch;
    return { claimed: jobs.length, results: await Promise.all(jobs), skipped: stopped && !jobs.length };
  }
  function tick() { return runOnce().catch(error => { logger?.warn?.(`Assignment worker: ${error.message}`); return { claimed: 0, error: error.message }; }); }
  function start() {
    if (stopped || timer) return;
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  }
  async function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    for (const controller of controllers) controller.abort(new Error('Assignment worker stopped'));
    if (running) await running.catch(() => {});
    await Promise.allSettled([...active.values()]);
  }
  return { workerId, runOnce, tick, start, stop, dispose: stop };
}
