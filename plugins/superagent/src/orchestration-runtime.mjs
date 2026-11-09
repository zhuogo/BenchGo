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
import { archiveClosedExecutionSessions, executionSessionProjection } from './execution-session.mjs';
import { executionUncertainty, executionStopConfirmation } from './execution-uncertainty.mjs';

/** One local control plane for Ticket and Goal execution. */
export function createOrchestrationRuntime({ ctx, store, feishu, channels, deliverDesktop, prepareTicketReply, notifyExecutionInput, notifyExecutionRecovery, onDelivered, execute, intervalMs = 1000, now = Date.now }) {
  const database = store.orchestration, owner = `delivery:${randomUUID()}`, shutdown = new AbortController();
  const archived = new Set(), archiveRetry = new Map();
  const requestedChecks = new Map();
  const finishDelivery = (id, options) => database.finishOutbox(id, { now: now(), ...options });
  const mirrored = new Set(), mirrorRetry = new Map();
  async function mirrorDelivered(row) {
    if (!onDelivered || row?.state !== 'sent' || row.receipt?.status !== 'accepted' || !row.receipt.messageId) return;
    const key = `${row.uniqueKey || row.kind || 'direct'}:${row.id}`;
    if (mirrored.has(key) || (mirrorRetry.get(key) || 0) > now()) return;
    try { await onDelivered(row); mirrored.add(key); mirrorRetry.delete(key); }
    catch { mirrorRetry.set(key, now() + 30000); }
  }
  const executionProgress = createTaskExecutionProgress({ ctx, database, now });
  const readPolicy = threadId => readAssessmentPolicy(store, ctx.workspaceRegistry, threadId);
  const directReplies = createDirectReplyDelivery({ database, readPolicy, signal: shutdown.signal, onDelivered: mirrorDelivered,
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
    notifyExecutionInput,
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
    const immediate = new Map(requestedChecks); requestedChecks.clear();
    const forced = [...immediate.values()].map(identity => {
      const assignment = database.getAssignment(identity.assignmentId), ticket = assignment && database.getTicket(assignment.ticketId);
      if (!assignment || assignment.fence !== identity.fence || ticket?.instructionRevision !== identity.instructionRevision) return null;
      const run = database.runs(assignment.id).find(row => row.fence === assignment.fence);
      return run && { assignment, ticket, run };
    }).filter(Boolean);
    const pauseCandidates = database.pauseRecoveryCandidates({ now: now() });
    for (const candidate of forced.filter(row => row.ticket.status === 'pausing' && row.run.evidence?.waitingPause
      && (row.assignment.state === 'uncertain' || row.assignment.state === 'claimed' && row.assignment.leaseUntil <= now())))
      if (!pauseCandidates.some(row => row.assignment.id === candidate.assignment.id)) pauseCandidates.push(candidate);
    for (const { assignment, run } of pauseCandidates) {
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
    const verificationCandidates = database.verificationCandidates({ now: now() });
    for (const candidate of forced.filter(row => row.ticket.status === 'open' && row.assignment.state === 'uncertain'
      && executionUncertainty(database, row.ticket, { now: now() })?.automatic))
      if (!verificationCandidates.some(row => row.assignment.id === candidate.assignment.id)) verificationCandidates.push(candidate);
    for (const { assignment, run } of verificationCandidates) {
      shutdown.signal.throwIfAborted();
      const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(run.environment ? 60000 : 15000)]);
      try {
        await checkpointStore.assertRunnable(run.id);
        await withRecoveredEvidence({ ctx, run, signal }, async (_result, observation) => {
          const policy = await readPolicy();
          signal.throwIfAborted();
          database.queueVerification(assignment.id, { fence: assignment.fence, runId: run.id, observation,
            ownerRetry: immediate.has(assignment.id), now: now(),
            validateMandate: mandate => validateTicketMandate(mandate, { policy }) });
        });
      } catch (error) {
        // Persist inspection backoff so one busy/invalid session cannot starve
        // other candidates or restart a tight polling loop after a process restart.
        database.deferVerification(assignment.id, { fence: assignment.fence, now: now(), reason: error.code || 'EVIDENCE_UNVERIFIED' });
      }
    }
  }

  let timer, running, recovery, recoveryNotifications;
  async function cycle() {
    const policy = await readPolicy();
    // The existing Router inbox owns delivery and prioritizes human messages.
    // Notification work must not wait for log locks or occupy this cycle.
    if (notifyExecutionRecovery) recoveryNotifications ||= (async () => {
      for (const ticket of database.listTickets({ limit: 1000 })) await notifyExecutionRecovery({ ticketId: ticket.id });
    })().catch(error => ctx.logger?.warn?.(`SuperAgent 恢复提醒待重试：${error.code || error.name}`))
      .finally(() => { recoveryNotifications = undefined; });
    if (onDelivered) {
      for (const ticket of database.listTickets({ limit: 1000 })) for (const row of database.deliveries(ticket.id)) await mirrorDelivered(row);
      for (const row of database.directReplies?.({ state: 'sent', limit: 1000 }) || []) await mirrorDelivered(row);
    }
    // Archival follows confirmed closure; a failed official call remains retryable.
    if ((ctx.get?.('workspaceRegistry') || ctx.workspaceRegistry)?.archiveSession) {
      for (const ticket of database.listTickets({ limit: 1000 })) {
        if (!['completed', 'failed', 'cancelled'].includes(ticket.status) || archived.has(ticket.id) || (archiveRetry.get(ticket.id) || 0) > now()) continue;
        try { await archiveClosedExecutionSessions(ctx, database, ticket.id); archived.add(ticket.id); archiveRetry.delete(ticket.id); }
        catch { archiveRetry.set(ticket.id, now() + 30000); }
      }
    }
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
    const pending = database.claimOutbox(owner, { limit: 1, leaseMs: 60000, now: now() });
    for (let delivery of pending) {
      if (shutdown.signal.aborted) break;
      let payload = delivery.payload;
      const deliveryTicket = database.getTicket(delivery.ticketId);
      const suppressed = deliverySuppression(database, delivery)
        || (deliveryTicket && !validateTicketMandate(deliveryTicket.mandate, { policy }) ? 'authorization-changed' : null);
      if (suppressed) {
        finishDelivery(delivery.id, { owner, sent: true, receipt: { status: 'suppressed', reason: suppressed } });
        continue;
      }
      if (payload.type === 'ticket.result') {
        if (payload.publication?.origin !== 'router') {
          let stage = 'prepare';
          try {
            const reply = await prepareTicketReply?.(delivery);
            if (reply?.status === 'suppressed') {
              finishDelivery(delivery.id, { owner, sent: true, receipt: { status: 'suppressed', reason: reply.reason || 'reply-superseded' } });
              continue;
            }
            if (reply?.status !== 'ready' || typeof reply.text !== 'string' || !reply.text.trim()) {
              finishDelivery(delivery.id, { owner, error: 'Router 自然回复待生成', retryMs: 30000 });
              continue;
            }
            stage = 'persist';
            delivery = database.saveOutboxReply(delivery.id, { owner,
              publication: { action: 'deliver', origin: 'router', text: reply.text }, messageId: reply.messageId, now: now() });
            payload = delivery.payload;
          } catch (cause) {
            // Keep only bounded error identity, never provider text, prompts or credentials.
            const identity = String(cause?.code || cause?.name || 'UNKNOWN');
            const code = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(identity) ? identity : 'UNKNOWN';
            const reason = stage === 'persist' ? 'Router 回复投递记录保存失败' : 'Router 回复准备失败';
            ctx.logger?.warn?.(`SuperAgent ticket reply ${stage} failed: ${code}`);
            finishDelivery(delivery.id, { owner, error: `${reason}（${code}），等待重试`, retryMs: 30000 });
            continue;
          }
        }
        try {
          const publication = validateDelivery(payload.publication);
          if (publication.origin !== 'router') throw new Error('Router reply required');
          payload.text = publication.text;
        } catch { finishDelivery(delivery.id, { owner, error: 'Router 回复格式无效', retryMs: 30000 }); continue; }
        // Model generation may span a source/configuration change. Recheck at
        // the actual send boundary; a saved reply never grants authorization.
        const currentPolicy = await readPolicy(), currentTicket = database.getTicket(delivery.ticketId);
        const changed = deliverySuppression(database, delivery)
          || (!currentTicket || !validateTicketMandate(currentTicket.mandate, { policy: currentPolicy }) ? 'authorization-changed' : null);
        if (changed) {
          finishDelivery(delivery.id, { owner, sent: true, receipt: { status: 'suppressed', reason: changed } });
          continue;
        }
      }
      if (payload.source?.channel === 'desktop' && deliverDesktop) {
        try {
          // This callback must durably deduplicate by delivery.uniqueKey before
          // acknowledging. Local notification retries never rerun the Worker.
          const receipt = await deliverDesktop(delivery);
          if (receipt?.status !== 'accepted' || !receipt.messageId) throw new Error('Desktop notification was not durably accepted');
          const saved = finishDelivery(delivery.id, { owner, sent: true, receipt });
          await mirrorDelivered(saved);
        } catch {
          finishDelivery(delivery.id, { owner, error: '桌面通知保存失败，稍后重试', retryMs: 30000 });
        }
        continue;
      }
      const adapter = channels?.get(payload.source?.channel) || (payload.source?.channel === 'feishu' ? feishu : null);
      if (!adapter?.send) {
        finishDelivery(delivery.id, { owner, error: '来源交付服务不可用', retryMs: 30000 });
        continue;
      }
      try {
        const options = payload.publication?.options;
        const text = options?.length ? `${payload.text}\n\n可回复：\n${options.map(option => `• ${option}`).join('\n')}` : payload.text;
        const receipt = await adapter.send({ source: payload.source, text, idempotencyKey: delivery.uniqueKey });
        if (receipt?.status !== 'accepted' || !receipt.messageId) throw new Error('来源未返回确定回执');
        const saved = finishDelivery(delivery.id, { owner, sent: true, receipt });
        await mirrorDelivered(saved);
      } catch (error) {
        // A failed/expired network request may already have sent. Preserve it for
        // receipt reconciliation, never rerun the task or blindly resend.
        const notSent = knownNotSent(error);
        finishDelivery(delivery.id, { owner, uncertain: !notSent, retryMs: 30000,
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
    async manageExecution({ ticketId, assignmentId, fence, instructionRevision, operation }) {
      const ticket = database.getTicket(ticketId), policy = await readPolicy();
      if (!ticket || ticket.instructionRevision !== instructionRevision || !validateTicketMandate(ticket.mandate, { policy }))
        throw Object.assign(new Error('恢复处置的授权或要求已变化'), { code: 'MANDATE_REVOKED' });
      const fact = executionUncertainty(database, ticket, { now: now() });
      if (!fact || fact.assignmentId !== assignmentId || fact.fence !== fence)
        return { status: 'blocked', reason: '执行身份或核查状态已变化，请重新读取事实' };
      if (operation === 'wait') return { status: 'waiting', uncertainty: fact };
      if (!['check-now', 'resume', 'fail'].includes(operation)) throw new Error('未知恢复处置');
      if (!fact.automatic) return { status: 'blocked', reason: fact.recoveryBlocked, uncertainty: fact };
      const assignment = database.getAssignment(assignmentId), run = database.runs(assignmentId).find(row => row.fence === fence);
      if (operation === 'resume' && (fact.reasonCode === 'external-effects-unknown' || ticket.status !== 'open'))
        return { status: 'blocked', reason: '外部效果未核清或用户暂停尚未解除，只能核查，不能续跑', uncertainty: fact };
      if (operation === 'fail' && (fact.reasonCode === 'external-effects-unknown' || run?.evidence?.outcome !== 'failed'
        || !run.evidence.selfCheck?.summary || !run.evidence.failure?.attempted || !run.evidence.failure?.cause || !run.evidence.failure?.resumeConditions))
        return { status: 'blocked', reason: '没有已保存的结构性失败证据与自检说明，不得凭空报失败或关单', uncertainty: fact };
      requestedChecks.set(assignment.id, { assignmentId, fence, instructionRevision });
      void tick();
      return { status: 'scheduled', action: 'inspect-saved-evidence',
        reason: '已排入现有只读核查；只有可信结束证据确认后才走原有收尾，不重跑外部动作', uncertainty: fact };
    },
    state({ newestFirst = false, archived, ticketId, limit = 1000 } = {}) {
      const progress = executionProgress.batch();
      const boundedLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 1000;
      const tickets = ticketId === undefined ? database.listTickets({ limit: boundedLimit, newestFirst, archived }) : [database.getTicket(ticketId)].filter(Boolean);
      return tickets.map(ticket => {
        const assignments = database.assignments(ticket.id);
        const inputDiagnostics = (database.ticketInputs?.(ticket.id) || []).filter(input => input.snapshot?.executionInput?.outcome === 'failed')
          .map(input => ({ id: input.id, triggerId: input.triggerId, state: input.state, receivedAt: input.receivedAt,
            code: input.snapshot.executionInput.code, reason: input.snapshot.executionInput.reason }));
        const uncertainty = executionUncertainty(database, ticket, { now: now() });
        const execution = progress(ticket, assignments);
        const stopping = executionStopConfirmation(database, ticket, { now: now() });
        const stoppedAssignment = stopping.stopRequestedAt && assignments.find(row => row.stopRequest?.at === stopping.stopRequestedAt);
        const projected = execution || (uncertainty || stoppedAssignment ? { assignmentId: uncertainty?.assignmentId || stoppedAssignment.id,
          runId: uncertainty ? uncertainty.runId : database.runs(stoppedAssignment.id).find(row => row.fence === stoppedAssignment.fence)?.id,
          instructionRevision: ticket.instructionRevision } : null);
        return { ...ticket, inputDiagnostics, revisions: database.ticketRevisions(ticket.id), assignments, attentions: database.attentions(ticket.id), attentionResolutions: database.attentionResolutions(ticket.id), results: database.results(ticket.id), deliveries: database.deliveries(ticket.id), executionSession: executionSessionProjection(database, ticket.id),
          execution: projected ? { ...projected, uncertainty, ...stopping } : null };
      });
    },
    start() { if (timer || shutdown.signal.aborted) return; timer = setInterval(tick, intervalMs); timer.unref?.(); void tick(); },
    async stop() {
      shutdown.abort(); clearInterval(timer);
      executionProgress.dispose();
      const stopped = worker.stop();
      await running;
      await Promise.allSettled([recovery, recoveryNotifications, stopped, directReplies.stop()]);
    },
  };
}
