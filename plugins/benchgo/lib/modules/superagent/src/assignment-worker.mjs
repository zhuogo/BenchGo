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

  async function perform(assignment, { onReady } = {}) {
    const controller = new AbortController();
    controllers.add(controller);
    const ownership = { owner: workerId, fence: assignment.fence, leaseMs };
    let heartbeat = null, renewal = null, stage = 'execution', resultReady = false;
    const renew = () => {
      if (renewal) return renewal;
      renewal = (async () => {
        controller.signal.throwIfAborted();
        const policy = await readPolicy();
        if (resultReady) return database.getAssignment(assignment.id);
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
      const result = await execute(assignment, { ticket, signal: controller.signal, renew, onReady });
      resultReady = true;
      clearInterval(heartbeat); heartbeat = null;
      const beforeCommit = async () => {
        if (renewal) await renewal;
      };
      // Saving an existing draft never authorizes another execution against
      // current settings; lifecycle association is handled by the result store.
      stage = 'result';
      await onResult(result, { assignment, ticket, signal: controller.signal, beforeCommit });
      clearInterval(heartbeat); heartbeat = null;
      controller.signal.throwIfAborted();
      const state = database.getAssignment(assignment.id)?.state;
      if (!['completed', 'waiting', 'paused', 'queued'].includes(state)) database.finishAssignment(assignment.id, { ...ownership, status: 'completed' });
      return { id: assignment.id, status: ['waiting', 'paused', 'queued'].includes(state) ? state : 'completed' };
    } catch (error) {
      if (error?.resultDraft) { try { await onResult(error.resultDraft, { assignment, ticket: { id: assignment.ticketId }, signal: controller.signal, beforeCommit: async () => {} }); } catch { /* Run/session and runtime retain the draft for persistence retry. */ } }
      let runs = [];
      try { runs = database.runs(assignment.id); } catch { /* The retained draft survives diagnostic read failure. */ }
      const effects = error?.executionEffects || (stage === 'execution' && !runs.some(run => ['submitted', 'running', 'verifying', 'uncertain'].includes(run.state))
        ? { effectsVerified: true, unknownCallIds: [] } : undefined);
      const uncertain = effects?.effectsVerified !== true;
      try { database.recordAssignmentFailure(assignment.id, { ...ownership, stage, code: error?.code, phase: error?.executionPhase,
        message: String(error?.message || error), effects, cleanupFailure: error?.cleanupFailure }); } catch { /* Preserve the original failure. */ }
      try {
        if (uncertain) database.renewAssignment(assignment.id, { ...ownership, validateMandate: () => false });
        else database.finishAssignment(assignment.id, { ...ownership, status: 'failed' });
      } catch { /* Lost leases are reconciled by the store's next claim. */ }
      logger?.warn?.(`Assignment ${assignment.id}: ${error?.message || error}`);
      return { id: assignment.id, status: uncertain ? 'uncertain' : 'failed', error: String(error?.message || error) };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      controller.abort();
      controllers.delete(controller);
    }
  }

  async function runOnce() {
    if (stopped) return { claimed: 0, results: [], skipped: true };
    const batch = running ||= (async () => {
      if (!database.hasAssignmentWork()) return [];
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
  const resuming = new Map();
  async function resumeExecutionSession({ sessionId }) {
    if (stopped) throw new Error('Assignment worker stopped');
    if (resuming.has(sessionId)) return resuming.get(sessionId);
    const readiness = (async () => {
      const policy = await readPolicy();
      if (stopped) throw new Error('Assignment worker stopped');
      const assignment = database.resumeWorkerConversation(sessionId, { owner: workerId, leaseMs,
        validateMandate: (mandate, context) => validateMandate(mandate, { ...context, policy }) === true });
      let ready, fail, isReady = false;
      const admitted = new Promise((resolve, reject) => { ready = resolve; fail = reject; });
      const work = perform(assignment, { onReady: agent => { isReady = true; ready(agent); } }).then(result => {
        if (!isReady) fail(new Error(result.error || 'Worker continuation did not become ready'));
        return result;
      }).finally(() => active.delete(assignment.id));
      active.set(assignment.id, work);
      work.catch(fail);
      return admitted;
    })().finally(() => resuming.delete(sessionId));
    resuming.set(sessionId, readiness);
    return readiness;
  }
  return { workerId, runOnce, tick, start, stop, resumeExecutionSession, dispose: stop };
}
