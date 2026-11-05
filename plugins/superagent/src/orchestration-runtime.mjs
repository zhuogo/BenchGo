import { deliverySuppression, validateDelivery, systemStateDelivery } from './result-delivery.mjs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createAssignmentExecutor } from './assignment-executor.mjs';
import { createAssistantAssignmentWorker } from './assignment-worker.mjs';
import { readAssessmentPolicy, validateTicketMandate } from './assessment-policy.mjs';
import { reviewTicketResult, recoverableReview } from './ticket-review.mjs';
import { createReviewContinuation } from './review-continuation.mjs';
import { recoveryStorage, withRecoveredEvidence, withRecoveredPause, verifyExecutionArtifacts } from './execution-evidence.mjs';
import { createWorkerCheckpointStore } from './worker-checkpoint-store.mjs';
import { createCheckpointService } from './checkpoint-service.mjs';
import { createDirectReplyDelivery } from './direct-reply-delivery.mjs';
import { createReviewEvidenceReader } from './review-evidence-reader.mjs';
import { commitReviewedResult } from './review-result-commit.mjs';

/** One local control plane for Ticket and Goal execution. */
export function createOrchestrationRuntime({ ctx, store, feishu, channels, deliverDesktop, execute, review = reviewTicketResult, intervalMs = 1000, now = Date.now }) {
  const database = store.orchestration, owner = `delivery:${randomUUID()}`, shutdown = new AbortController();
  const readPolicy = threadId => readAssessmentPolicy(store, ctx.workspaceRegistry, threadId);
  const directReplies = createDirectReplyDelivery({ database, readPolicy, signal: shutdown.signal,
    getAdapter: channel => channels?.get(channel) || (channel === 'feishu' ? feishu : null) });
  const checkpointStore = createWorkerCheckpointStore({ directory: join(store.paths.workspace, 'checkpoints') });
  const checkpoints = createCheckpointService({ database, checkpoints: checkpointStore, readPolicy, agents: ctx.agents });
  async function reviewAndCommit(result, { assignment, ticket, signal, beforeCommit }) {
      const policy = await readPolicy();
      if (!validateTicketMandate(ticket.mandate, { policy })) throw new Error('Ticket authorization changed before review');
      const reviewSignal = AbortSignal.any([signal, shutdown.signal, AbortSignal.timeout(120000)]);
      const verifyArtifacts = async () => {
        if (!ticket.mandate.project) return;
        const run = database.runs(assignment.id).find(item => item.id === result.runId && item.fence === assignment.fence);
        await verifyExecutionArtifacts(run, result, signal);
      };
      await verifyArtifacts();
      let readEvidence;
      if (ctx.sessionQuery?.readSession && result.runId) {
        const run = database.runs(assignment.id).find(item => item.id === result.runId && item.fence === assignment.fence);
        if (!run || run.sessionId !== result.sessionId) throw new Error('Review evidence belongs to another execution');
        readEvidence = createReviewEvidenceReader({ ctx, result });
      }
      const answeredAttentions = database.answeredAttentionForReview(ticket.id, { instructionRevision: ticket.instructionRevision,
        runId: result.runId, sessionId: result.sessionId });
      const verdict = await recoverableReview(review, { llm: ctx.llm, database, model: (ticket.mandate.source?.channel === 'desktop' ? assignment.model : undefined) || policy.model, ticket, result, rules: policy.rules, signal: reviewSignal, routingConfig: policy.routingConfig, readEvidence, answeredAttentions }, signal);
      signal.throwIfAborted();
      shutdown.signal.throwIfAborted();
      await verifyArtifacts();
      await beforeCommit();
      const current = await readPolicy();
      const versionKey = ticket.mandate.source?.channel === 'desktop' ? 'desktopVersion' : 'version';
      if (current[versionKey] !== policy[versionKey] || !validateTicketMandate(ticket.mandate, { policy: current })) throw new Error('Ticket authorization changed during review');
      // Result, execution completion and the single delivery record are one transaction.
      return commitReviewedResult({ database, ticket, result, verdict, assignment, model: assignment.model || policy.model,
        uniqueKey: `assignment-result:${assignment.id}:${result.runId || 'execution'}:${assignment.fence}` });
  }
  const executeTask = execute || createAssignmentExecutor({ ctx, database, workspaceRoot: join(store.paths.workspace, 'workers'), readPolicy,
    authorizeAction: async ({ policy, mandate }) => ({ allowed: validateTicketMandate(mandate, { policy }) }),
    readContext: sessionId => store.getSessionContext(sessionId), memory: store.memory, checkpoints: checkpointStore,
    readSourceContext: input => input.source?.channel === 'feishu' ? feishu?.readContext?.(input) : undefined,
  });
  const worker = createAssistantAssignmentWorker({
    database, readPolicy, validateMandate: validateTicketMandate, logger: ctx.logger,
    getConcurrency: async () => (await store.getConfig()).workerConcurrency ?? 2,
    execute: async (assignment, context) => {
      if (!assignment.verificationOnly) return executeTask(assignment, context);
      const run = database.runs(assignment.id).find(row => row.id === assignment.verificationOnly.runId && row.fence === assignment.fence);
      if (!run?.evidence) throw new Error('Recovery has no saved execution evidence');
      await checkpointStore.assertRunnable(run.id);
      return run.evidence;
    },
    onResult: async (result, context) => {
      if (result.waitingPause) {
        await context.beforeCommit();
        return database.parkPause(context.assignment.id, { owner: context.assignment.owner, fence: context.assignment.fence, result });
      }
      if (result.waitingAttention) {
        await context.beforeCommit();
        return database.parkAttention(context.assignment.id, { owner: context.assignment.owner, fence: context.assignment.fence, result });
      }
      if (!context.assignment.verificationOnly) return reviewAndCommit(result, context);
      const run = database.runs(context.assignment.id).find(row => row.id === result.runId && row.fence === context.assignment.fence);
      if (!run) throw new Error('Recovery execution identity changed');
      return withRecoveredEvidence({ ctx, run, signal: context.signal }, saved => reviewAndCommit(saved, context));
    },
  });
  async function recoverPending() {
    shutdown.signal.throwIfAborted();
    if (!recoveryStorage(ctx)?.open || !ctx.agents?.get) return;
    for (const { assignment, run } of database.pauseRecoveryCandidates()) {
      shutdown.signal.throwIfAborted();
      const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(60000)]);
      try {
        await checkpointStore.assertRunnable(run.id);
        await withRecoveredPause({ ctx, run, signal }, (_saved, observation) => {
          signal.throwIfAborted();
          database.recoverParkPause(assignment.id, { fence: assignment.fence, runId: run.id, observation });
        });
      } catch (error) {
        database.deferPauseRecovery(assignment.id, { fence: assignment.fence });
      }
    }
    for (const { assignment, run } of database.verificationCandidates()) {
      shutdown.signal.throwIfAborted();
      const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(run.environment ? 60000 : 15000)]);
      try {
        await checkpointStore.assertRunnable(run.id);
        await withRecoveredEvidence({ ctx, run, signal }, async (_result, observation) => {
          const policy = await readPolicy();
          signal.throwIfAborted();
          database.queueVerification(assignment.id, { fence: assignment.fence, runId: run.id, observation,
            validateMandate: mandate => validateTicketMandate(mandate, { policy }) });
        });
      } catch (error) {
        // Persist inspection backoff so one busy/invalid session cannot starve
        // other candidates or restart a tight polling loop after a process restart.
        database.deferVerification(assignment.id, { fence: assignment.fence, reason: error.code || 'EVIDENCE_UNVERIFIED' });
      }
    }
  }

  const reviews = new Set(), activeReviews = new Map();
  const continueReview = createReviewContinuation({ ctx, database, readPolicy, review, signal: shutdown.signal });
  const isReviewWait = result => result?.review?.verdict === 'wait'
    && (result.review.waitKind === 'review_wait' || (!result.review.waitKind && result.review.retryable === true))
    && result.review.retryable !== false && !result.review.userDecision;
  function deferReview(ticket, diagnostic) {
    if (!ticket || ticket.status !== 'waiting') return;
    const previous = database.results(ticket.id).at(-1);
    if (!isReviewWait(previous)) return;
    const attempts = Math.max(ticket.reviewRetry?.attempts || 0, previous.review.retryAttempts || 0);
    return database.deferReview(ticket.id, { expectedResultVersion: ticket.resultVersion,
      nextAttemptAt: now() + Math.min(900000, 30000 * 2 ** Math.min(attempts, 5)),
      diagnostic: diagnostic || previous.review.diagnostic, now: now() });
  }
  async function performReview(ticketId, options) {
    shutdown.signal.throwIfAborted();
    const budget = database.checkGoalBudget({ ticketId, now: now() });
    if (!budget.allowed) throw Object.assign(new Error('工单资源条件暂不满足核验要求'), { code: 'GOAL_BUDGET_EXHAUSTED' });
    for (const assignment of database.assignments(ticketId)) for (const run of database.runs(assignment.id)) await checkpointStore.assertRunnable(run.id);
    const ticket = database.getTicket(ticketId);
    if (ticket?.status === 'open' && ticket.resultVersion === 0 && options?.expectedResultVersion === 0) {
      const candidates = database.assignments(ticketId).filter(item => item.state === 'uncertain');
      if (candidates.length !== 1) throw new Error('原执行恢复状态不唯一，请刷新工单');
      const assignment = candidates[0];
      const run = database.runs(assignment.id).find(item => item.fence === assignment.fence && item.evidence);
      if (!run) throw new Error('原执行证据不可用');
      const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(60000)]);
      const pending = withRecoveredEvidence({ ctx, run, signal }, async (_saved, observation) => {
        const policy = await readPolicy();
        signal.throwIfAborted();
        const queued = database.queueVerification(assignment.id, { fence: assignment.fence, runId: run.id, observation,
          ownerRetry: true, validateMandate: mandate => validateTicketMandate(mandate, { policy }) });
        return { ticket: database.getTicket(ticketId), assignment: queued, queued: true };
      });
      reviews.add(pending);
      try { return await pending; } finally { reviews.delete(pending); }
    }
    const pending = continueReview(ticketId, options);
    reviews.add(pending);
    try { return await pending; }
    finally { reviews.delete(pending); }
  }
  function retryReview(ticketId, options) {
    if (shutdown.signal.aborted) return Promise.reject(shutdown.signal.reason);
    const current = activeReviews.get(ticketId);
    if (current) {
      if (current.expectedResultVersion !== options?.expectedResultVersion) return Promise.reject(Object.assign(new Error('工单正在核验，请等待当前核验完成'), { code: 'REVIEW_IN_PROGRESS' }));
      return current.promise;
    }
    const ticket = database.getTicket(ticketId);
    if (ticket?.resultVersion === options?.expectedResultVersion) deferReview(ticket);
    const promise = performReview(ticketId, options).finally(() => {
      activeReviews.delete(ticketId);
      const latest = database.getTicket(ticketId);
      if (latest?.resultVersion !== ticket?.resultVersion) deferReview(latest);
    });
    activeReviews.set(ticketId, { expectedResultVersion: options?.expectedResultVersion, promise });
    return promise;
  }
  async function performResumeReviewWork(ticketId, expectedResultVersion, { additionalExecutionMs = 0 } = {}) {
    shutdown.signal.throwIfAborted();
    const ticket = database.getTicket(ticketId), result = database.results(ticketId).at(-1);
    if (!Number.isSafeInteger(expectedResultVersion) || ticket?.status !== 'waiting'
      || ticket.resultVersion !== expectedResultVersion || (result?.review?.waitKind !== 'continuation_wait'
        && ticket.continuationWait?.sourceResultVersion !== expectedResultVersion)) throw new Error('工单续做状态已变化，请刷新');
    if (!Number.isSafeInteger(additionalExecutionMs) || additionalExecutionMs < 0 || additionalExecutionMs > 600000) throw new Error('续做时长须在0到10分钟之间');
    const budgetWait = ticket.continuationWait;
    if (budgetWait?.code === 'EXECUTION_EFFECTS_UNKNOWN') return { queued: false, code: budgetWait.code, ticket };
    if (budgetWait?.code === 'EXECUTION_BUDGET_EXHAUSTED' && budgetWait.assignmentId && budgetWait.runId) {
      const run = database.runs(budgetWait.assignmentId).find(item => item.id === budgetWait.runId && item.sessionId === budgetWait.sessionId);
      if (!run?.evidence?.waitingExecutionBudget) throw new Error('原执行额度等待记录不可用');
      await checkpointStore.assertRunnable(run.id);
      const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(60000)]);
      return withRecoveredPause({ ctx, run, signal }, async () => {
        const policy = await readPolicy();
        signal.throwIfAborted();
        return database.queueBudgetContinuation(ticketId, { expectedResultVersion, additionalExecutionMs,
          validateMandate: mandate => validateTicketMandate(mandate, { policy }), now: now() });
      });
    }
    const assignment = database.assignments(ticketId).find(item => database.runs(item.id).some(run => run.id === result.runId));
    const run = assignment && database.runs(assignment.id).find(item => item.id === result.runId);
    if (!run) throw new Error('原执行记录不可用');
    await checkpointStore.assertRunnable(run.id);
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(60000)]);
    return withRecoveredEvidence({ ctx, run, signal }, async () => {
      const policy = await readPolicy();
      signal.throwIfAborted();
      const validateMandate = mandate => validateTicketMandate(mandate, { policy });
      if (result.review?.waitKind === 'blocked') return database.queueAnsweredReviewContinuation(ticketId, {
        sourceResultVersion: expectedResultVersion, validateMandate, ownerRetry: true, additionalExecutionMs, now: now() });
      return database.queueReviewContinuation(ticketId, { assignmentId: assignment.id, runId: run.id,
        sourceResultVersion: expectedResultVersion, resetProgress: true, additionalExecutionMs,
        validateMandate, now: now() });
    });
  }
  async function resumeReviewWork(ticketId, expectedResultVersion, options) {
    const pending = performResumeReviewWork(ticketId, expectedResultVersion, options);
    reviews.add(pending);
    try { return await pending; } finally { reviews.delete(pending); }
  }
  let timer, running, recovery;
  async function cycle() {
    const policy = await readPolicy();
    database.queueAnsweredAttention({ validateMandate: mandate => validateTicketMandate(mandate, { policy }) });
    const waitingTickets = database.listTickets({ status: 'waiting', limit: 1000 });
    for (const ticket of waitingTickets) {
      const previous = database.results(ticket.id).at(-1);
      if (!isReviewWait(previous) || activeReviews.has(ticket.id)
        || !validateTicketMandate(ticket.mandate, { policy })) continue;
      const retry = ticket.reviewRetry?.resultVersion === ticket.resultVersion ? ticket.reviewRetry : null;
      const reportedAt = Date.parse(previous.review.diagnostic?.at || previous.committedAt);
      const nextAttemptAt = retry?.nextAttemptAt ?? (Number.isFinite(reportedAt) ? reportedAt + 30000 : now() + 30000);
      if (nextAttemptAt > now()) {
        if (!retry) database.deferReview(ticket.id, { expectedResultVersion: ticket.resultVersion, nextAttemptAt, now: now(), diagnostic: previous.review.diagnostic });
        continue;
      }
      void retryReview(ticket.id, { expectedResultVersion: ticket.resultVersion })
        .catch(() => { /* Evidence, authorization and result fences stay authoritative. */ });
    }
    for (const ticket of database.listTickets({ status: 'open', limit: 1000 })) {
      shutdown.signal.throwIfAborted();
      if (!validateTicketMandate(ticket.mandate, { policy }) || !policy.model) continue;
      // The Router's persisted acceptance carries the task package. Scheduling
      // only materializes that decision; it does not make another model decision.
      if (!database.assignments(ticket.id).length) database.createAssignment(ticket.id, {
        id: `initial:${ticket.id}`, executor: 'harness', model: policy.model,
        text: ticket.target, acceptance: ticket.acceptance,
      });
    }
    // Recovery may wait on disk ownership. Keep source delivery and scheduling independent.
    recovery ||= recoverPending().catch(error => {
      if (!shutdown.signal.aborted) ctx.logger?.warn?.(`SuperAgent 核实未完成：${error.message}`);
    }).finally(() => { recovery = undefined; });
    // Do not await long executions here: source delivery must keep progressing.
    void worker.tick();
    const pending = database.claimOutbox(owner, { limit: 1, leaseMs: 60000 });
    for (const delivery of pending) {
      if (shutdown.signal.aborted) break;
      const payload = delivery.payload;
      const deliveryTicket = database.getTicket(delivery.ticketId);
      const suppressed = deliverySuppression(database, delivery)
        || (deliveryTicket && !validateTicketMandate(deliveryTicket.mandate, { policy }) ? 'authorization-changed' : null);
      if (suppressed) {
        database.finishOutbox(delivery.id, { owner, sent: true, receipt: { status: 'suppressed', reason: suppressed } });
        continue;
      }
      // Existing queued records may predate the publication contract. Never replay
      // their embedded Worker prose into a newly protected human channel.
      if (payload.type === 'ticket.result' && !payload.publication) {
        payload.publication = systemStateDelivery({ state: 'delivery_wait', code: 'LEGACY_PUBLICATION_MISSING', stage: 'publication' });
        payload.text = payload.publication.text;
      }
      if (payload.type === 'ticket.result') {
        try {
          payload.publication = validateDelivery(payload.publication);
          payload.text = payload.publication.text;
        } catch {
          database.finishOutbox(delivery.id, { owner, sent: true, receipt: { status: 'suppressed', reason: 'invalid-publication' } });
          continue;
        }
      }
      if (payload.source?.channel === 'desktop' && deliverDesktop) {
        try {
          // This callback must durably deduplicate by delivery.uniqueKey before
          // acknowledging. Local notification retries never rerun the Worker.
          const receipt = await deliverDesktop(delivery);
          if (receipt?.status !== 'accepted' || !receipt.messageId) throw new Error('Desktop notification was not durably accepted');
          database.finishOutbox(delivery.id, { owner, sent: true, receipt });
        } catch {
          database.finishOutbox(delivery.id, { owner, error: '桌面通知保存失败，稍后重试', retryMs: 30000 });
        }
        continue;
      }
      const adapter = channels?.get(payload.source?.channel) || (payload.source?.channel === 'feishu' ? feishu : null);
      if (!adapter?.send) {
        database.finishOutbox(delivery.id, { owner, error: '来源交付服务不可用', retryMs: 30000 });
        continue;
      }
      try {
        const options = payload.publication?.options;
        const text = options?.length ? `${payload.text}\n\n可回复：\n${options.map(option => `• ${option}`).join('\n')}` : payload.text;
        const receipt = await adapter.send({ source: payload.source, text, idempotencyKey: delivery.uniqueKey });
        if (receipt?.status !== 'accepted' || !receipt.messageId) throw new Error('来源未返回确定回执');
        database.finishOutbox(delivery.id, { owner, sent: true, receipt });
      } catch (error) {
        // A failed/expired network request may already have sent. Preserve it for
        // receipt reconciliation, never rerun the task or blindly resend.
        database.finishOutbox(delivery.id, { owner, uncertain: true, error: '来源发送结果待核实' });
        ctx.logger?.warn?.('SuperAgent 结果已保存，来源发送待核实');
      }
    }
  }
  function tick() {
    if (shutdown.signal.aborted) return Promise.resolve();
    const replies = directReplies.tick().catch(() => { if (!shutdown.signal.aborted) ctx.logger?.warn?.('SuperAgent 渠道回复交付待重试'); });
    running ||= cycle().catch(error => { if (!shutdown.signal.aborted) ctx.logger?.warn?.(`SuperAgent 编排未完成：${error.message}`); }).finally(() => { running = undefined; });
    return Promise.all([running, replies]);
  }
  return {
    checkpoints,
    retryReview,
    resumeReviewWork,
    tick,
    state: () => database.listTickets({ limit: 1000 }).map(ticket => ({ ...ticket, revisions: database.ticketRevisions(ticket.id), assignments: database.assignments(ticket.id), attentions: database.attentions(ticket.id), results: database.results(ticket.id), deliveries: database.deliveries(ticket.id) })),
    start() { if (timer || shutdown.signal.aborted) return; timer = setInterval(tick, intervalMs); timer.unref?.(); void tick(); },
    async stop() {
      shutdown.abort(); clearInterval(timer);
      const stopped = worker.stop();
      await running;
      await Promise.allSettled([recovery, stopped, directReplies.stop(), ...reviews, ...[...activeReviews.values()].map(item => item.promise)]);
    },
  };
}
