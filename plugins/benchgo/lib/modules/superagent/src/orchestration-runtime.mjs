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
import { requestInterruptedContinuation } from './interrupted-continuation.mjs';
import { interruptedContinuationPolicy } from './interrupted-continuation-policy.mjs';
import { createExecutionSummaryInput } from './execution-summary-input.mjs';

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
  // Activation awaits this promise. Domain-only synchronous readers remain
  // usable during preparation; a missing official dependency still rejects it.
  executionProgress.ready.catch(() => {});
  const readPolicy = threadId => readAssessmentPolicy(store, ctx.workspaceRegistry, threadId);
  const directReplies = createDirectReplyDelivery({ database, readPolicy, signal: shutdown.signal, onDelivered: mirrorDelivered,
    getAdapter: channel => channels?.get(channel) || (channel === 'feishu' ? feishu : null) });
  const checkpointStore = createWorkerCheckpointStore({ directory: join(store.paths.workspace, 'checkpoints'),
    onObservation: observation => database.recordExecutionArtifactObservation(observation),
    onObservationError: metadata => ctx.logger?.warn?.(`SuperAgent 文件观察未入账：${metadata.code}`) });
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
    const immediate = new Map();
    for (const [key, request] of requestedChecks) if (!request.nextAt || request.nextAt <= now()) {
      immediate.set(key, request); requestedChecks.delete(key);
    }
    for (const request of database.takeInterruptedContinuationRequests({ now: now() }))
      if (!immediate.has(request.assignmentId)) immediate.set(request.assignmentId, request);
    for (const identity of immediate.values()) {
      if (!['resume-interrupted', 'inspect'].includes(identity.operation)) continue;
      const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(15000)]);
      const assignment = database.getAssignment(identity.assignmentId), ticket = assignment && database.getTicket(assignment.ticketId);
      const run = database.runs(identity.assignmentId).find(row => row.fence === identity.fence);
      if (!assignment || assignment.fence !== identity.fence || ticket?.instructionRevision !== identity.instructionRevision || !run) continue;
      try {
        if (identity.operation === 'resume-interrupted') {
          await requestInterruptedContinuation({ ctx, database, ...identity, now: now(), readPolicy, checkpoints: checkpointStore, signal });
          continue;
        }
        let observed, code;
        const fact = executionUncertainty(database, ticket, { now: now() });
        if (fact?.automatic) {
          await (ticket.status === 'pausing' ? withRecoveredPause : withRecoveredEvidence)({ ctx, run, signal }, (saved, observation) => {
            if (saved.executionEffects?.effectsVerified === false)
              throw Object.assign(new Error('External effects remain unknown'), { code: 'EXECUTION_EFFECTS_UNKNOWN' });
            observed = observation; code = ticket.status === 'pausing' ? 'VERIFIED_PAUSED' : 'VERIFIED_COMPLETED';
          });
        } else {
          const inspected = await requestInterruptedContinuation({ ctx, database, ...identity, inspectOnly: true,
            readPolicy, checkpoints: checkpointStore, signal });
          observed = inspected.observation; code = 'VERIFIED_INTERRUPTED';
        }
        const policy = await readPolicy(); signal.throwIfAborted();
        if (!validateTicketMandate(database.getTicket(ticket.id)?.mandate, { policy }))
          throw Object.assign(new Error('Recovery authorization changed'), { code: 'MANDATE_REVOKED' });
        database.recordExecutionInspection(identity.assignmentId, { ...identity, runId: run.id,
          id: randomUUID(), status: 'verified', code, observation: observed, now: now() });
      } catch (error) {
        try { database.recordExecutionInspection(identity.assignmentId, { ...identity, runId: run.id,
          id: randomUUID(), status: 'blocked', code: error.code || 'EVIDENCE_UNVERIFIED', now: now() }); }
        catch { /* A simultaneous user stop or changed execution wins over the obsolete inspection. */ }
      }
    }
    const forced = [...immediate.values()].map(identity => {
      if (['resume-interrupted', 'inspect'].includes(identity.operation)) return null;
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

  let timer, running, recovery, recoveryNotifications, schedulerHeartbeat = null;
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
    running ||= cycle().then(() => {
      // This control-plane cycle really completed. Reading evidence, a timer
      // firing, or an unfinished/failed cycle must not manufacture liveness.
      if (!shutdown.signal.aborted) schedulerHeartbeat = { at: timestamp(now()), bootId: executionProgress.bootId };
    }).catch(error => { if (!shutdown.signal.aborted) ctx.logger?.warn?.(`SuperAgent 编排未完成：${error.message}`); }).finally(() => { running = undefined; });
    return Promise.all([running, replies]);
  }
  const runtime = {
    checkpoints,
    tick,
    async manageExecution({ ticketId, assignmentId, fence, instructionRevision, operation, automatic = true }) {
      const ticket = database.getTicket(ticketId), policy = await readPolicy();
      if (!ticket || ticket.instructionRevision !== instructionRevision || !validateTicketMandate(ticket.mandate, { policy }))
        throw Object.assign(new Error('恢复处置的授权或要求已变化'), { code: 'MANDATE_REVOKED' });
      const fact = executionUncertainty(database, ticket, { now: now() });
      if (!fact || fact.assignmentId !== assignmentId || fact.fence !== fence)
        return { status: 'blocked', reason: '执行身份或核查状态已变化，请重新读取事实' };
      if (operation === 'wait') return { status: 'waiting', uncertainty: fact };
      if (!['check-now', 'resume', 'fail'].includes(operation)) throw new Error('未知恢复处置');
      const assignment = database.getAssignment(assignmentId), run = database.runs(assignmentId).find(row => row.fence === fence);
      if (!recoveryStorage(ctx)?.open || !ctx.agents?.get) return { status: 'blocked', reason: '官方原会话核查接缝暂不可用', uncertainty: fact };
      if (operation === 'check-now') {
        if (!run?.sessionId) return { status: 'blocked', reason: '缺少原执行会话，无法核对真实记录', uncertainty: fact };
        if (fact.lastInspection && now() - Date.parse(fact.lastInspection.at) < 30_000)
          return { status: 'waiting', reason: '刚完成一次核查，先按已有事实决定处置，避免相同原因的紧密重复核查', uncertainty: fact };
        requestedChecks.set(assignment.id, { assignmentId, fence, instructionRevision, operation: 'inspect' });
        void tick();
        return { status: 'scheduled', action: 'inspect-only', reason: '已异步安排一次只读复核，结果将回到 Router；不会续跑或重发', uncertainty: fact };
      }
      if (operation === 'resume' && (fact.reasonCode === 'external-effects-unknown' || ticket.status !== 'open'))
        return { status: 'blocked', reason: '外部效果未核清或用户暂停尚未解除，只能核查，不能续跑', uncertainty: fact };
      if (operation === 'resume' && !fact.automatic) {
        if (!run?.sessionId || assignment.stopRequest || assignment.retiredExecution)
          return { status: 'blocked', reason: '原执行会话缺失或已停止，不能安全续接', uncertainty: fact };
        const retry = interruptedContinuationPolicy(run, { now: now() });
        if (automatic !== false && retry.exhausted)
          return { status: 'blocked', reason: '自动续接已达上限，保留原执行待核实；只能只读核查或等待用户明确决定', uncertainty: fact };
        const nextAt = automatic !== false && retry.backingOff ? retry.nextAttemptAt : undefined;
        if (nextAt) database.deferInterruptedContinuation(assignment.id, { fence, instructionRevision, now: now() });
        else requestedChecks.set(assignment.id, { assignmentId, fence, instructionRevision,
          automatic: automatic !== false, operation: 'resume-interrupted' });
        void tick();
        return { status: 'scheduled', action: 'inspect-interrupted-continuation',
          ...(nextAt ? { nextAttemptAt: new Date(nextAt).toISOString() } : {}),
          reason: nextAt ? '已按持久退避安排原会话核查续接，等待期间不执行工具'
            : '正在异步核查原会话写锁、全部工具回执与外部效果；安全证据通过后才续接原会话，不新建执行', uncertainty: fact };
      }
      if (!fact.automatic) return { status: 'blocked', reason: fact.recoveryBlocked, uncertainty: fact };
      if (operation === 'fail' && (fact.reasonCode === 'external-effects-unknown' || run?.evidence?.outcome !== 'failed'
        || !run.evidence.selfCheck?.summary || !run.evidence.failure?.attempted || !run.evidence.failure?.cause || !run.evidence.failure?.resumeConditions))
        return { status: 'blocked', reason: '没有已保存的结构性失败证据与自检说明，不得凭空报失败或关单', uncertainty: fact };
      requestedChecks.set(assignment.id, { assignmentId, fence, instructionRevision });
      void tick();
      return { status: 'scheduled', action: 'inspect-saved-evidence',
        reason: '已排入现有只读核查；只有可信结束证据确认后才走原有收尾，不重跑外部动作', uncertainty: fact };
    },
    state({ newestFirst = false, archived, ticketId, limit = 1000, offset = 0 } = {}) {
      const progress = executionProgress.batch();
      const boundedLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 1000;
      const tickets = ticketId === undefined ? database.listTickets({ limit: boundedLimit, offset, newestFirst, archived }) : [database.getTicket(ticketId)].filter(Boolean);
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
    async start() { await executionProgress.ready; if (timer || shutdown.signal.aborted) return; timer = setInterval(tick, intervalMs); timer.unref?.(); void tick(); },
    async stop() {
      shutdown.abort(); clearInterval(timer);
      const observations = executionProgress.dispose();
      const stopped = worker.stop();
      await running;
      await Promise.allSettled([recovery, recoveryNotifications, stopped, observations, executionProgress.ready, directReplies.stop()]);
    },
  };
  const timestamp = value => value != null && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
  function evidenceRuntime(ticket, requestedRunId) {
    const assignments = database.assignments(ticket.id);
    const assignment = requestedRunId ? assignments.find(row => database.runs(row.id).some(run => run.id === requestedRunId)) : assignments.at(-1);
    const run = assignment && (requestedRunId ? database.runs(assignment.id).find(row => row.id === requestedRunId)
      : database.runs(assignment.id).filter(row => row.fence === assignment.fence).at(-1));
    if (requestedRunId && !run) throw Object.assign(new Error('Execution does not belong to this Ticket'), { code: 'EXECUTION_FACT_BINDING' });
    const projections = database.executionProjections({ ticketId: ticket.id, ...(run ? { runId: run.id } : {}) });
    const source = projections.find(row => row.sessionId === run?.sessionId);
    const agent = run && ctx.agents?.get?.(run.sessionId);
    const uncertainty = executionUncertainty(database, ticket, { now: now() });
    const stopping = executionStopConfirmation(database, ticket, { now: now() });
    const attention = database.attentions(ticket.id).find(row => row.state === 'waiting');
    let request = agent && source?.live?.bootId === executionProgress.bootId && source.live.request
      || { state: 'unknown', startedAt: null, settledAt: null, deadline: null };
    if (request.state === 'inflight' && source.state?.request?.state === 'settled'
      && Date.parse(source.state.request.settledAt) >= Date.parse(request.startedAt)) request = { ...request, state: 'settled', settledAt: source.state.request.settledAt };
    const gateway = ctx.get?.('typertGateway');
    const pending = run && gateway?.getPendingRemoteEvents ? gateway.getPendingRemoteEvents().filter(row => String(row.agentId) === run.sessionId
      || projections.some(source => source.parentSessionId === run.sessionId && source.sessionId === String(row.agentId))) : [];
    const owners = new Set(run ? [run.sessionId, ...projections.filter(row => row.parentSessionId === run.sessionId).map(row => row.sessionId)] : []);
    // Official list(caller) also includes unowned jobs. They do not prove
    // anything about this execution, and labels/progress/output stay private.
    const jobs = ctx.get?.('jobs') || ctx.jobs;
    const backgroundJobs = jobs?.list ? [...owners].flatMap(owner => jobs.list(owner)
      .filter(job => job.owner === owner && ['running', 'stopping'].includes(job.status))
      .map(job => ({ startedAt: timestamp(job.startedAt) }))) : [];
    const waitKind = ['paused', 'pausing'].includes(ticket.status) ? 'paused' : pending.some(row => row.event === 'approval/request') ? 'approval'
      : attention || pending.some(row => row.event === 'user-questions/request') ? 'user'
      : ticket.continuationWait ? 'continuation' : backgroundJobs.length && agent?.status !== 'running' ? 'background-job'
        : ['waiting', 'uncertain'].includes(assignment?.state) ? 'unknown' : 'none';
    const inspected = uncertainty?.lastInspection;
    return {
      evidenceCursor: database.executionTicketCursor(ticket.id),
      ticket: { id: ticket.id, status: ticket.status, instructionRevision: ticket.instructionRevision ?? 1 },
      assignment: assignment ? { id: assignment.id, state: assignment.state, owner: assignment.owner ?? null, fence: assignment.fence,
        leaseUntil: assignment.leaseUntil ?? null, updatedAt: assignment.updatedAt } : null,
      run: run ? { id: run.id, state: run.state, sessionId: run.sessionId, instructionRevision: run.instructionRevision ?? assignment.instructionRevision ?? 1, updatedAt: run.updatedAt } : null,
      executionAlive: { status: !run || !ctx.agents?.get ? 'unknown' : agent?.status === 'running' ? 'running' : agent?.status === 'idle' ? 'idle' : 'absent',
        observedAt: timestamp(now()), bootId: executionProgress.bootId },
      request, wait: { kind: waitKind, since: waitKind === 'background-job' ? backgroundJobs.map(job => job.startedAt).filter(Boolean).sort()[0] || null
        : timestamp(attention?.createdAt || ticket.pauseReason?.at || ticket.continuationWait?.at), expectedUntil: null },
      stop: { requestedAt: stopping.stopRequestedAt || assignment?.stopRequest?.at || null,
        confirmedAt: assignment?.executionStopped && assignment.executionStopped.fence === assignment.fence ? assignment.executionStopped.at : null,
        confirmationOverdue: stopping.stopConfirmationOverdue },
      recovery: uncertainty ? { reasonCode: uncertainty.reasonCode, attempts: uncertainty.attempts, nextCheckAt: uncertainty.nextCheckAt,
        automatic: uncertainty.automatic, escalated: uncertainty.escalated,
        ...(inspected ? { lastInspection: { id: inspected.id ?? null, at: inspected.at ?? null, status: inspected.status ?? inspected.outcome ?? null, code: inspected.code ?? null } } : {}) } : null,
      watermarks: projections.map(row => ({ sessionId: row.sessionId, sourceSeq: row.cursor, flushedSeq: row.flushedCursor,
        sourceDurability: row.sourceDurability, complete: row.complete, missingReason: row.missingReason })),
      artifactCoverage: checkpointStore.observationCoverage?.(run?.id) || { known: false, complete: false },
    };
  }
  function existingEvidence(ticket, requestedRunId) {
    const runtime = evidenceRuntime(ticket, requestedRunId), watermark = database.executionFactCursor();
    // One bounded suffix of the existing journal feeds both local and remote
    // observers. No transcript, checkpoint blob or workspace scan is read here.
    const facts = { ...database.executionEvidence({ ticketId: ticket.id, ...(runtime.run ? { runId: runtime.run.id } : {}),
      instructionRevision: ticket.instructionRevision ?? 1, after: Math.max(0, watermark - 200), limit: 200 }),
      runtime, observedAt: timestamp(now()) };
    const modelEvidence = createExecutionSummaryInput({ ticketId: ticket.id, runId: runtime.run?.id || '',
      instructionRevision: ticket.instructionRevision ?? 1, watermark, target: ticket.target, acceptance: ticket.acceptance,
      facts });
    return { ...runtime, modelEvidence };
  }
  let decorateTickets = rows => rows;
  runtime.executionFacts = {
    ready: executionProgress.ready,
    currentCursor: () => database.executionFactCursor(),
    subscribe: listener => database.onExecutionFacts(listener),
    page: options => database.executionFactPage(options),
    setTicketProjection(project) { if (typeof project !== 'function') throw new TypeError('Ticket projection must be a function'); decorateTickets = project; },
    snapshot({ ticketId } = {}) {
      const rows = [];
      for (let offset = 0; ; offset += 1000) {
        const page = runtime.state({ newestFirst: true, ticketId, limit: 1000, offset });
        rows.push(...page);
        if (ticketId !== undefined || page.length < 1000) break;
      }
      const tickets = decorateTickets(rows), truncated = false;
      // Match the existing Fetch route's JSON representation: optional domain
      // fields are absent on the wire, never JavaScript undefined values.
      return JSON.parse(JSON.stringify({ cursor: database.executionFactCursor(), tickets, bootId: executionProgress.bootId, observedAt: timestamp(now()),
        completeness: { complete: !truncated && tickets.every(ticket => !ticket.execution || ticket.execution.completeness === 'complete'), truncated } }));
    },
    evidence(input) {
      const evidence = database.executionEvidence(input), ticket = database.getTicket(input.ticketId);
      if (!ticket) throw Object.assign(new Error('Ticket not found'), { code: 'TICKET_NOT_FOUND' });
      return { ...evidence, runtime: existingEvidence(ticket, input.runId), bootId: executionProgress.bootId, observedAt: timestamp(now()) };
    },
    evidenceSnapshot({ limit = 1000 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('Invalid execution evidence limit');
      const tickets = database.listTickets({ archived: false, limit, newestFirst: true });
      const truncated = database.listTickets({ archived: false, limit: 1, offset: limit }).length > 0;
      const executions = tickets.map(ticket => existingEvidence(ticket));
      const cursor = database.executionFactCursor();
      return { cursor, currentCursor: cursor, observedAt: timestamp(now()), bootId: executionProgress.bootId, executions,
        complete: !truncated && executions.every(row => !row.run || row.watermarks.length > 0 && row.watermarks.every(source => source.complete)),
        truncated, schedulerHeartbeat: schedulerHeartbeat && { ...schedulerHeartbeat } };
    },
  };
  return runtime;
}
