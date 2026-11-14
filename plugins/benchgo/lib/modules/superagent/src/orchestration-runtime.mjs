import { deliverySuppression } from './result-delivery.mjs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createAssignmentExecutor, workerExecutionBinding } from './assignment-executor.mjs';
import { createAssistantAssignmentWorker } from './assignment-worker.mjs';
import { readAssessmentPolicy, validateTaskMandate } from './assessment-policy.mjs';
import { withRecoveredEvidence } from './execution-evidence.mjs';
import { createDirectReplyDelivery } from './direct-reply-delivery.mjs';
import { commitWorkerResult } from './result-commit.mjs';
import { sendSourceDelivery, deliveryLease } from './source-delivery.mjs';
import { createTaskExecutionProgress } from './task-execution-progress.mjs';
import { executionSessionProjection, findExecutionSessionOwner } from './execution-session.mjs';
import { taskExecutionBlocked, taskPaused } from './task-lifecycle.mjs';
import { executionUncertainty, executionStopConfirmation } from './execution-uncertainty.mjs';
import { requestInterruptedContinuation } from './interrupted-continuation.mjs';

/** One local control plane for Task and Goal execution. */
export function createOrchestrationRuntime({ ctx, store, feishu, channels, deliverDesktop, notifyTaskResult, notifyExecutionInput, onDelivered, observeRemote, maintainTasks, execute, intervalMs = 1000, now = Date.now }) {
  const database = store.orchestration, owner = `delivery:${randomUUID()}`, shutdown = new AbortController();
  const finishDelivery = (id, options) => database.finishOutbox(id, { now: now(), ...options });
  const mirrored = new Set(), mirrorRetry = new Map(), mirrorPending = new Map();
  function mirrorDelivered(row) {
    if (!onDelivered || shutdown.signal.aborted || row?.state !== 'sent' || row.receipt?.status !== 'accepted' || !row.receipt.messageId) return;
    const key = `${row.uniqueKey || row.kind || 'direct'}:${row.id}`;
    if (mirrorPending.has(key)) return mirrorPending.get(key);
    if (mirrored.has(key) || (mirrorRetry.get(key)?.nextAt || 0) > now()) return;
    // Reserve before invoking the sink: commit observers, live delivery and
    // startup recovery may all reach the same receipt while its flush awaits.
    const pending = Promise.resolve().then(() => onDelivered(row)).then(() => {
      mirrored.add(key); mirrorRetry.delete(key);
    }, () => { mirrorRetry.set(key, { row, nextAt: now() + 30000 }); }).finally(() => mirrorPending.delete(key));
    mirrorPending.set(key, pending);
    return pending;
  }
  // Subscribe before taking the immutable rowid cut. New rows and old queued
  // rows that finish during recovery arrive through the committed live hook.
  const stopMirrors = onDelivered ? database.onSentDelivery(mirrorDelivered) : null;
  const mirrorCut = onDelivered ? database.sentDeliveryCut() : null;
  const mirrorRecovery = mirrorCut ? [
    { page: options => database.sentDeliveryPage(options), after: 0, through: mirrorCut.outbox },
    { page: options => database.sentDirectReplyPage(options), after: 0, through: mirrorCut.direct },
  ] : [];
  async function retryMirrors() {
    let retried = 0;
    for (const { row, nextAt } of mirrorRetry.values()) {
      if (shutdown.signal.aborted || retried >= 100) break;
      if (nextAt > now()) continue;
      retried++; await mirrorDelivered(row);
    }
  }
  async function recoverMirrors() {
    while (!shutdown.signal.aborted) {
      for (const recovery of mirrorRecovery) {
        if (shutdown.signal.aborted || recovery.after >= recovery.through) continue;
        const page = recovery.page({ after: recovery.after, through: recovery.through, limit: 100 });
        for (const row of page.entries) {
          if (shutdown.signal.aborted) return;
          await mirrorDelivered(row);
        }
        recovery.after = page.cursor;
      }
      if (mirrorRecovery.every(recovery => recovery.after >= recovery.through)) return;
      // Drain startup promptly, but let requests, timers and live delivery run
      // between bounded pages instead of waiting one scheduler second per page.
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  const executionProgress = createTaskExecutionProgress({ ctx, database, now });
  // Activation awaits this promise. Domain-only synchronous readers remain
  // usable during preparation; a missing official dependency still rejects it.
  executionProgress.ready.catch(() => {});
  const readPolicy = threadId => readAssessmentPolicy(store, ctx.workspaceRegistry, threadId);
  const directReplies = createDirectReplyDelivery({ database, readPolicy, signal: shutdown.signal, onDelivered: mirrorDelivered,
    getAdapter: channel => channels?.get(channel) || (channel === 'feishu' ? feishu : null) });
  const pendingDrafts = new Map();
  async function commitResult(result, { assignment, task, beforeCommit }) {
    if (beforeCommit) { try { await beforeCommit(); } catch { /* Lease renewal cannot discard an existing draft. */ } }
    return commitWorkerResult({ database, task: database.getTask(task.id), result, assignment,
      uniqueKey: `assignment-result:${assignment.id}:${result.runId || 'execution'}:${assignment.fence}` });
  }
  const executeTask = execute || createAssignmentExecutor({ ctx, database, workspaceRoot: join(store.paths.workspace, 'workers'), readPolicy,
    notifyExecutionInput,
    authorizeAction: async ({ policy, mandate }) => ({ allowed: validateTaskMandate(mandate, { policy }) }),
    readContext: sessionId => store.getSessionContext(sessionId), memory: store.memory,
    readSourceContext: input => input.source?.channel === 'feishu' ? feishu?.readContext?.(input) : undefined,
  });
  const worker = createAssistantAssignmentWorker({
    database, readPolicy, validateMandate: validateTaskMandate, logger: ctx.logger,
    getConcurrency: async () => (await store.getConfig()).workerConcurrency ?? 2,
    execute: executeTask,
    onResult: async (result, context) => {
      pendingDrafts.set(context.assignment.id, { result, context });
      if (result.waitingPause) {
        await context.beforeCommit();
        const parked = database.parkPause(context.assignment.id, { owner: context.assignment.owner, fence: context.assignment.fence, result });
        await commitResult(result, { ...context, beforeCommit: undefined });
        pendingDrafts.delete(context.assignment.id);
        return parked;
      }
      if (result.waitingAttention) {
        await context.beforeCommit();
        const parked = database.parkAttention(context.assignment.id, { owner: context.assignment.owner, fence: context.assignment.fence, result });
        await commitResult(result, { ...context, beforeCommit: undefined });
        pendingDrafts.delete(context.assignment.id);
        return parked;
      }
      const saved = await commitResult(result, context);
      pendingDrafts.delete(context.assignment.id);
      return saved;
    },
  });
  async function acceptSavedCompletion({ assignment, task, run }) {
    const save = result => commitWorkerResult({ database, task, result: { ...result, completionPending: false }, assignment,
      uniqueKey: `assignment-result:${assignment.id}:${run.id}:${assignment.fence}` });
    // Current executors persist the official ending with the draft. Recovery is
    // persistence work and does not need to reopen or re-verify that execution.
    if (run.evidence?.completion) return save(run.evidence);
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]);
    try {
      return await withRecoveredEvidence({ ctx, run, signal }, result => {
        database.saveWorkerDraft(assignment.id, { runId: run.id, owner: run.owner, fence: run.fence, result });
        return save(result);
      });
    } catch (error) {
      if (run.evidence?.summary) {
        // Retain the raw text even when the official storage is temporarily
        // unavailable. Unknown completion remains running; it is not success.
        commitWorkerResult({ database, task, result: { ...run.evidence, completionPending: true }, assignment,
          uniqueKey: `assignment-result:${assignment.id}:${run.id}:${assignment.fence}` });
      }
      throw error;
    }
  }
  async function acceptSavedResults() {
    for (const [id, entry] of pendingDrafts) {
      if (!entry.result.completion && entry.result.runId) {
        try {
          await commitResult({ ...entry.result, completionPending: true }, entry.context);
          database.saveWorkerDraft(entry.context.assignment.id, { runId: entry.result.runId,
            owner: entry.context.assignment.owner, fence: entry.context.assignment.fence, result: entry.result });
          pendingDrafts.delete(id);
        } catch { /* Keep the only in-memory copy until it is durably retained. */ }
        continue;
      }
      try { await commitResult(entry.result, entry.context); pendingDrafts.delete(id); }
      catch { /* Durable Run/session drafts and this in-memory copy remain available. */ }
    }
    if (!database.hasPendingResultRecovery({ now: now() })) return;
    for (const task of database.listTasks({ limit: 1000 })) {
      for (const assignment of database.assignments(task.id)) {
        if (pendingDrafts.has(assignment.id) || assignment.state === 'claimed' && assignment.leaseUntil > now()) continue;
        const run = database.runs(assignment.id).find(row => row.fence === assignment.fence);
        if (!run?.evidence?.summary) continue;
        if (!run || run.resultSaved && !run.resultSaved.completionPending && !run.resultSaved.notificationPending) continue;
        if (!['uncertain', 'cancelled', 'verifying', 'submitted', 'running', 'completed', 'failed'].includes(run.state)) continue;
        const previous = assignment.savedResultRecovery?.fence === assignment.fence && assignment.savedResultRecovery?.runId === run.id ? assignment.savedResultRecovery : null;
        if (previous?.nextAttemptAt > now()) continue;
        const attempts = (previous?.attempts || 0) + 1;
        try { await acceptSavedCompletion({ assignment, task: database.getTask(task.id), run }); }
        catch {
          if (shutdown.signal.aborted) return;
          database.recordSavedResultRecovery(assignment.id, { fence: assignment.fence, runId: run.id, attempts,
            nextAttemptAt: now() + Math.min(300000, 30000 * 2 ** Math.min(attempts - 1, 4)),
            code: 'RESULT_PERSISTENCE_UNAVAILABLE', reason: '原稿收尾暂不可用，系统将在存储恢复后自动补存。', now: now() });
          ctx.logger?.warn?.('SuperAgent 结果收尾暂不可用，将自动重试');
        }
        return;
      }
    }
  }

  let timer, running, remoteRunning, mirroring, replaying, replayRetryAt = 0, schedulerHeartbeat = null;
  async function cycle() {
    await acceptSavedResults();
    let policy;
    const currentPolicy = async () => policy ||= await readPolicy();
    if (database.hasAnsweredAttention()) {
      await currentPolicy();
      database.queueAnsweredAttention({ validateMandate: mandate => validateTaskMandate(mandate, { policy }) });
    }
    for (const task of database.schedulingTasks({ limit: 1000 })) {
      shutdown.signal.throwIfAborted();
      if (taskExecutionBlocked(task) || task.continuationWait && task.continuationWait.stage !== 'scheduling' || task.resultVersion > 0) continue;
      if (database.assignments(task.id).length) continue;
      await currentPolicy();
      const schedulingBlocker = !validateTaskMandate(task.mandate, { policy }) ? 'MANDATE_REVOKED' : !policy.workerModels?.length ? 'WORKER_MODEL_ROUTE' : null;
      database.setSchedulingBlocker(task.id, { code: schedulingBlocker, now: now() });
      if (schedulingBlocker) continue;
      // The Router's persisted acceptance carries the task package. Scheduling
      // only materializes that decision; it does not make another model decision.
      database.createAssignment(task.id, {
        id: `initial:${task.id}`, executor: 'harness',
        text: task.target, acceptance: task.acceptance,
      });
    }
    // Do not await long executions here: source delivery must keep progressing.
    void worker.tick();
    const pending = database.claimOutbox(owner, { limit: 1, leaseMs: 60000, now: now() });
    for (let delivery of pending) {
      if (shutdown.signal.aborted) break;
      const lease = deliveryLease(() => database.renewOutbox(delivery.id, { owner, now: now() }));
      try {
      let payload = delivery.payload;
      const suppressed = deliverySuppression(database, delivery);
      if (suppressed) {
        finishDelivery(delivery.id, { owner, sent: true, receipt: { status: 'suppressed', reason: suppressed } });
        continue;
      }
      if (payload.source?.channel === 'link') {
          // The source device reads this immutable result through its executionRef.
          // Never create a target-local owner conversation for an incoming device.
          finishDelivery(delivery.id, { owner, sent: true, receipt: { status: 'available', transport: 'link-reference', messageId: delivery.id } });
          continue;
      }
      if (payload.type === 'task.result') {
        // State notices use the same durable inbox boundary as saved results.
        // Acceptance only means the Router owns the expression, not delivery.
        const accepted = await enqueueResultNotice(delivery);
        if (accepted) finishDelivery(delivery.id, { owner, sent: true, receipt: accepted });
        else finishDelivery(delivery.id, { owner, error: 'Router inbox unavailable', retryMs: 30000 });
        continue;
      }
      if (payload.source?.channel === 'desktop' && deliverDesktop) {
        lease.check();
        // The desktop sink durably deduplicates by uniqueKey, including retries
        // after a process crash between persistence and acknowledgement.
        await sendSourceDelivery({ send: () => deliverDesktop(delivery), durableDeduplication: true,
          finish: options => finishDelivery(delivery.id, { owner, ...options }), onDelivered: mirrorDelivered });
        continue;
      }
      const adapter = channels?.get(payload.source?.channel) || (payload.source?.channel === 'feishu' ? feishu : null);
      if (!adapter?.send) {
        finishDelivery(delivery.id, { owner, error: '来源交付服务不可用', retryMs: 30000 });
        continue;
      }
      lease.check();
      {
        const options = payload.publication?.options;
        const text = options?.length ? `${payload.text}\n\n可回复：\n${options.map(option => `• ${option}`).join('\n')}` : payload.text;
        await sendSourceDelivery({ send: () => adapter.send({ source: payload.source, text, idempotencyKey: delivery.uniqueKey }),
          finish: options => finishDelivery(delivery.id, { owner, ...options }), onDelivered: mirrorDelivered });
      }
      } finally { lease.stop(); }
    }
  }
  async function enqueueResultNotice(notice) {
    try {
      const receipt = await notifyTaskResult?.(notice);
      if (receipt?.status === 'suppressed') return { status: 'suppressed', reason: receipt.reason || 'task-superseded' };
      if (receipt?.status === 'accepted' && receipt.messageId) return { status: 'enqueued', transport: 'router-inbox', messageId: receipt.messageId };
    } catch (cause) {
      const identity = String(cause?.code || cause?.name || 'UNKNOWN');
      const code = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(identity) ? identity : 'UNKNOWN';
      ctx.logger?.warn?.(`SuperAgent Router inbox pending: ${code}`);
    }
    return null;
  }
  let notifying;
  async function notifyResults() {
    for (const notice of database.pendingResultNotifications({ now: now(), limit: 20 })) {
      if (shutdown.signal.aborted) return;
      if (notice.payload.source?.channel === 'link') {
        database.finishResultNotification(notice.taskId, notice.uniqueKey, { status: 'accepted', messageId: notice.uniqueKey, now: now() });
        continue;
      }
      const receipt = await enqueueResultNotice(notice);
      database.finishResultNotification(notice.taskId, notice.uniqueKey, { now: now(),
        status: receipt?.status === 'enqueued' ? 'accepted' : receipt?.status,
        messageId: receipt?.messageId, reason: receipt?.reason });
    }
  }
  function tick() {
    if (shutdown.signal.aborted) return Promise.resolve();
    mirroring ||= retryMirrors().finally(() => { mirroring = undefined; });
    const mirrors = mirroring;
    if (now() >= replayRetryAt && mirrorRecovery.some(recovery => recovery.after < recovery.through))
      replaying ||= recoverMirrors().catch(() => {
        replayRetryAt = now() + 30000;
        if (!shutdown.signal.aborted) ctx.logger?.warn?.('SuperAgent delivery mirror recovery pending');
      }).finally(() => { replaying = undefined; });
    const replay = replaying;
    remoteRunning ||= Promise.resolve().then(() => observeRemote?.()).catch(() => { if (!shutdown.signal.aborted) ctx.logger?.warn?.('跨设备任务状态待核实'); }).finally(() => { remoteRunning = undefined; });
    const remote = remoteRunning;
    notifying ||= notifyResults().catch(() => { if (!shutdown.signal.aborted) ctx.logger?.warn?.('SuperAgent result notification persistence pending'); }).finally(() => { notifying = undefined; });
    const notifications = notifying;
    const replies = directReplies.tick().catch(() => { if (!shutdown.signal.aborted) ctx.logger?.warn?.('SuperAgent 渠道回复交付待重试'); });
    running ||= (maintainTasks ? Promise.resolve().then(() => maintainTasks()).then(() => cycle()) : cycle()).then(() => {
      // This control-plane cycle really completed. Reading evidence, a timer
      // firing, or an unfinished/failed cycle must not manufacture liveness.
      if (!shutdown.signal.aborted) schedulerHeartbeat = { at: timestamp(now()), bootId: executionProgress.bootId };
    }).catch(error => { if (!shutdown.signal.aborted) ctx.logger?.warn?.(`SuperAgent 编排未完成：${error.message}`); }).finally(() => { running = undefined; });
    return Promise.all([running, replies, remote, mirrors, replay, notifications]);
  }
  const stopResultNotifications = database.onResultNotification(() => { setImmediate(() => { if (!shutdown.signal.aborted) void tick(); }); });
  const runtime = {
    tick,
    async manageExecution({ taskId, assignmentId, fence, instructionRevision, operation }) {
      const task = database.getTask(taskId);
      if (!task || task.instructionRevision !== instructionRevision)
        throw Object.assign(new Error('恢复处置的授权或要求已变化'), { code: 'MANDATE_REVOKED' });
      const fact = executionUncertainty(database, task, { now: now() });
      if (!fact || fact.assignmentId !== assignmentId || fact.fence !== fence)
        return { status: 'blocked', reason: '执行身份或核查状态已变化，请重新读取事实' };
      if (operation !== 'resume') throw new Error('Only explicit original-session continuation is supported');
      const run = database.runs(assignmentId).find(row => row.fence === fence);
      if (taskExecutionBlocked(task)) return { status: 'blocked', reason: 'The task is paused or stopped' };
      const assignment = database.getAssignment(assignmentId);
      if (fact.hasCompletedResult) {
        const saved = await acceptSavedCompletion({ assignment, task, run });
        // Legacy drafts may not include an ending until their official log is
        // read. Saving an aborted draft is not a completed continuation.
        if (saved.result?.completion?.kind === 'completed') return { status: 'completed', result: saved };
      }
      const continuation = await requestInterruptedContinuation({ ctx, database, assignmentId, fence, instructionRevision,
        readPolicy, signal: shutdown.signal, now: now() });
      void tick();
      return continuation;
    },
    state({ newestFirst = false, archived, taskId, limit = 1000, offset = 0 } = {}) {
      const progress = executionProgress.batch();
      const boundedLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 1000;
      const tasks = taskId === undefined ? database.listTasks({ limit: boundedLimit, offset, newestFirst, archived }) : [database.getTask(taskId)].filter(Boolean);
      return tasks.map(task => {
        const assignments = database.assignments(task.id);
        const inputDiagnostics = database.taskInputs(task.id).filter(input => input.snapshot?.executionInput?.outcome === 'failed')
          .map(input => ({ id: input.id, triggerId: input.triggerId, state: input.state, receivedAt: input.receivedAt,
            code: input.snapshot.executionInput.code, reason: input.snapshot.executionInput.reason }));
        const uncertainty = executionUncertainty(database, task, { now: now() });
        const execution = progress(task, assignments);
        const stopping = executionStopConfirmation(database, task, { now: now() });
        const stoppedAssignment = stopping.stopRequestedAt && assignments.find(row => row.stopRequest?.at === stopping.stopRequestedAt);
        const projected = execution || (uncertainty || stoppedAssignment ? { assignmentId: uncertainty?.assignmentId || stoppedAssignment.id,
          runId: uncertainty ? uncertainty.runId : database.runs(stoppedAssignment.id).find(row => row.fence === stoppedAssignment.fence)?.id,
          instructionRevision: task.instructionRevision } : null);
        return { ...task, inputDiagnostics, revisions: database.taskRevisions(task.id), assignments, attentions: database.attentions(task.id), attentionResolutions: database.attentionResolutions(task.id), results: database.results(task.id), deliveries: database.deliveries(task.id), executionSession: executionSessionProjection(database, task.id),
          execution: projected ? { ...projected, uncertainty, ...stopping } : null };
      });
    },
    async start() { await executionProgress.ready; if (timer || shutdown.signal.aborted) return; timer = setInterval(tick, intervalMs); timer.unref?.(); void tick(); },
    async stop() {
      shutdown.abort(); clearInterval(timer); stopMirrors?.(); stopResultNotifications();
      const observations = executionProgress.dispose();
      const stopped = worker.stop();
      await running;
      await Promise.allSettled([notifying, stopped, observations, executionProgress.ready, directReplies.stop(), remoteRunning, mirroring, replaying, ...mirrorPending.values()]);
    },
  };
  const timestamp = value => value != null && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
  function evidenceRuntime(task, requestedRunId) {
    const assignments = database.assignments(task.id);
    const assignment = requestedRunId ? assignments.find(row => database.runs(row.id).some(run => run.id === requestedRunId)) : assignments.at(-1);
    const run = assignment && (requestedRunId ? database.runs(assignment.id).find(row => row.id === requestedRunId)
      : database.runs(assignment.id).filter(row => row.fence === assignment.fence).at(-1));
    if (requestedRunId && !run) throw Object.assign(new Error('Execution does not belong to this Task'), { code: 'EXECUTION_FACT_BINDING' });
    const projections = database.executionProjections({ taskId: task.id, ...(run ? { runId: run.id } : {}) });
    const source = projections.find(row => row.sessionId === run?.sessionId);
    const agent = run && ctx.agents?.get?.(run.sessionId);
    const uncertainty = executionUncertainty(database, task, { now: now() });
    const stopping = executionStopConfirmation(database, task, { now: now() });
    const attention = database.attentions(task.id).find(row => row.state === 'waiting');
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
    const jobs = ctx.get ? ctx.get('jobs') : ctx.jobs;
    const backgroundJobs = jobs?.list ? [...owners].flatMap(owner => jobs.list(owner)
      .filter(job => job.owner === owner && ['running', 'stopping'].includes(job.status))
      .map(job => ({ startedAt: timestamp(job.startedAt) }))) : [];
    const waitKind = taskPaused(task) ? 'paused' : pending.some(row => row.event === 'approval/request') ? 'approval'
      : attention || pending.some(row => row.event === 'user-questions/request') ? 'user'
      : task.continuationWait ? 'continuation' : backgroundJobs.length && agent?.status !== 'running' ? 'background-job'
        : ['waiting', 'uncertain'].includes(assignment?.state) ? 'unknown' : 'none';
    return {
      evidenceCursor: database.executionTaskCursor(task.id),
      task: { id: task.id, status: task.status, executionControl: task.executionControl, instructionRevision: task.instructionRevision ?? 1 },
      assignment: assignment ? { id: assignment.id, state: assignment.state, owner: assignment.owner ?? null, fence: assignment.fence,
        leaseUntil: assignment.leaseUntil ?? null, updatedAt: assignment.updatedAt } : null,
      run: run ? { id: run.id, state: run.state, sessionId: run.sessionId, instructionRevision: run.instructionRevision ?? assignment.instructionRevision ?? 1, updatedAt: run.updatedAt } : null,
      executionAlive: { status: !run || !ctx.agents?.get ? 'unknown' : agent?.status === 'running' ? 'running' : agent?.status === 'idle' ? 'idle' : 'absent',
        observedAt: timestamp(now()), bootId: executionProgress.bootId },
      request, wait: { kind: waitKind, since: waitKind === 'background-job' ? backgroundJobs.map(job => job.startedAt).filter(Boolean).sort()[0] || null
        : timestamp(attention?.createdAt || task.pauseReason?.at || task.continuationWait?.at), expectedUntil: null },
      stop: { requestedAt: stopping.stopRequestedAt || assignment?.stopRequest?.at || null,
        confirmedAt: assignment?.executionStopped && assignment.executionStopped.fence === assignment.fence ? assignment.executionStopped.at : null,
        confirmationOverdue: stopping.stopConfirmationOverdue },
      recovery: uncertainty ? { reasonCode: uncertainty.reasonCode, hasCompletedResult: uncertainty.hasCompletedResult } : null,
      watermarks: projections.map(row => ({ sessionId: row.sessionId, sourceSeq: row.cursor, flushedSeq: row.flushedCursor,
        sourceDurability: row.sourceDurability, complete: row.complete, missingReason: row.missingReason })),
    };
  }
  let decorateTasks = rows => rows;
  runtime.executionFacts = {
    ready: executionProgress.ready,
    currentCursor: () => database.executionFactCursor(),
    subscribe: listener => database.onExecutionFacts(listener),
    page: options => database.executionFactPage(options),
    setTaskProjection(project) { if (typeof project !== 'function') throw new TypeError('Task projection must be a function'); decorateTasks = project; },
    snapshot({ taskId } = {}) {
      const rows = [];
      for (let offset = 0; ; offset += 1000) {
        const page = runtime.state({ newestFirst: true, taskId, limit: 1000, offset });
        rows.push(...page);
        if (taskId !== undefined || page.length < 1000) break;
      }
      const tasks = decorateTasks(rows), truncated = false;
      // Match the existing Fetch route's JSON representation: optional domain
      // fields are absent on the wire, never JavaScript undefined values.
      return JSON.parse(JSON.stringify({ cursor: database.executionFactCursor(), tasks, publicChatNotifications: true, bootId: executionProgress.bootId, observedAt: timestamp(now()),
        completeness: { complete: !truncated && tasks.every(task => !task.execution || task.execution.completeness === 'complete'), truncated } }));
    },
    evidence(input) {
      const evidence = database.executionEvidence(input), task = database.getTask(input.taskId);
      if (!task) throw Object.assign(new Error('Task not found'), { code: 'TASK_NOT_FOUND' });
      return { ...evidence, runtime: evidenceRuntime(task, input.runId), bootId: executionProgress.bootId, observedAt: timestamp(now()) };
    },
    evidenceSnapshot({ limit = 1000 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('Invalid execution evidence limit');
      const tasks = database.listTasks({ archived: false, limit, newestFirst: true });
      const truncated = database.listTasks({ archived: false, limit: 1, offset: limit }).length > 0;
      const executions = tasks.map(task => evidenceRuntime(task));
      const cursor = database.executionFactCursor();
      return { cursor, currentCursor: cursor, observedAt: timestamp(now()), bootId: executionProgress.bootId, executions,
        complete: !truncated && executions.every(row => !row.run || row.watermarks.length > 0 && row.watermarks.every(source => source.complete)),
        truncated, schedulerHeartbeat: schedulerHeartbeat && { ...schedulerHeartbeat } };
    },
  };
  runtime.resumeExecutionSession = input => {
    const agent = ctx.agents?.get(input.sessionId);
    if (agent) {
      const execution = findExecutionSessionOwner(database, input.sessionId);
      const gate = workerExecutionBinding(agent);
      if (execution && gate?.runId === execution.run.id && gate?.assignmentId === execution.assignment.id
        && gate?.owner === execution.assignment.owner && gate?.fence === execution.assignment.fence
        && execution.assignment.state === 'claimed' && execution.assignment.leaseUntil > Date.now()) return Promise.resolve(agent);
      throw new Error('Worker conversation is already open without its current execution inbox');
    }
    return worker.resumeExecutionSession(input);
  };
  return runtime;
}
