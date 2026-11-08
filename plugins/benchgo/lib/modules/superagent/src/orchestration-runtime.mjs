import { deliverySuppression, validateDelivery } from './result-delivery.mjs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createAssignmentExecutor } from './assignment-executor.mjs';
import { createAssistantAssignmentWorker } from './assignment-worker.mjs';
import { readAssessmentPolicy, validateTicketMandate } from './assessment-policy.mjs';
import { recoveryStorage, withRecoveredEvidence, withRecoveredPause } from './execution-evidence.mjs';
import { createWorkerCheckpointStore } from './worker-checkpoint-store.mjs';
import { createCheckpointService } from './checkpoint-service.mjs';
import { createDirectReplyDelivery } from './direct-reply-delivery.mjs';
import { commitWorkerResult } from './result-commit.mjs';
import { knownNotSent } from './channels/delivery-outcome.mjs';
import { createTaskExecutionProgress } from './task-execution-progress.mjs';

/** One local control plane for Ticket and Goal execution. */
export function createOrchestrationRuntime({ ctx, store, feishu, channels, deliverDesktop, execute, intervalMs = 1000, now = Date.now }) {
  const database = store.orchestration, owner = `delivery:${randomUUID()}`, shutdown = new AbortController();
  const executionProgress = createTaskExecutionProgress({ ctx, database, now });
  const readPolicy = threadId => readAssessmentPolicy(store, ctx.workspaceRegistry, threadId);
  const directReplies = createDirectReplyDelivery({ database, readPolicy, signal: shutdown.signal,
    getAdapter: channel => channels?.get(channel) || (channel === 'feishu' ? feishu : null) });
  const checkpointStore = createWorkerCheckpointStore({ directory: join(store.paths.workspace, 'checkpoints') });
  const checkpoints = createCheckpointService({ database, checkpoints: checkpointStore, readPolicy, agents: ctx.agents });
  async function commitResult(result, { assignment, ticket, signal, beforeCommit }) {
    const policy = await readPolicy();
    if (!validateTicketMandate(ticket.mandate, { policy })) throw new Error('Ticket authorization changed');
    signal.throwIfAborted(); shutdown.signal.throwIfAborted();
    await beforeCommit();
    return commitWorkerResult({ database, ticket: database.getTicket(ticket.id), result, assignment,
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
      if (!context.assignment.verificationOnly) return commitResult(result, context);
      const run = database.runs(context.assignment.id).find(row => row.id === result.runId && row.fence === context.assignment.fence);
      if (!run) throw new Error('Recovery execution identity changed');
      return withRecoveredEvidence({ ctx, run, signal: context.signal }, saved => commitResult(saved, context));
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

  let timer, running, recovery;
  async function cycle() {
    const policy = await readPolicy();
    database.queueAnsweredAttention({ validateMandate: mandate => validateTicketMandate(mandate, { policy }) });
    for (const ticket of database.listTickets({ status: 'open', limit: 1000 })) {
      shutdown.signal.throwIfAborted();
      if (!validateTicketMandate(ticket.mandate, { policy }) || !policy.model) continue;
      // The Router's persisted acceptance carries the task package. Scheduling
      // only materializes that decision; it does not make another model decision.
      if (!database.assignments(ticket.id).length) database.createAssignment(ticket.id, {
        id: `initial:${ticket.id}`, executor: 'harness',
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
      if (payload.type === 'ticket.result') {
        try { payload.publication = validateDelivery(payload.publication); payload.text = payload.publication.text; }
        catch { database.finishOutbox(delivery.id, { owner, sent: true, receipt: { status: 'suppressed', reason: 'invalid-publication' } }); continue; }
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
        const notSent = knownNotSent(error);
        database.finishOutbox(delivery.id, { owner, uncertain: !notSent, retryMs: 30000,
          error: notSent ? '来源确认未发送，稍后重试' : '来源发送结果待核实',
          ...(error?.receipt && typeof error.receipt === 'object' ? { receipt: error.receipt } : {}) });
        ctx.logger?.warn?.(notSent ? 'SuperAgent 结果已保存，来源确认未发送' : 'SuperAgent 结果已保存，来源发送待核实');
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
    tick,
    state() {
      const progress = executionProgress.batch();
      return database.listTickets({ limit: 1000 }).map(ticket => {
        const assignments = database.assignments(ticket.id);
        return { ...ticket, revisions: database.ticketRevisions(ticket.id), assignments, attentions: database.attentions(ticket.id), attentionResolutions: database.attentionResolutions(ticket.id), results: database.results(ticket.id), deliveries: database.deliveries(ticket.id), execution: progress(ticket, assignments) };
      });
    },
    start() { if (timer || shutdown.signal.aborted) return; timer = setInterval(tick, intervalMs); timer.unref?.(); void tick(); },
    async stop() {
      shutdown.abort(); clearInterval(timer);
      executionProgress.dispose();
      const stopped = worker.stop();
      await running;
      await Promise.allSettled([recovery, stopped, directReplies.stop()]);
    },
  };
}
