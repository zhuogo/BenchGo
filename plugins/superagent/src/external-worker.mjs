import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { askNativeQuestion } from '../../base/src/questions.mjs';
import { scanWorkerProgressLine, workerProgressInstruction } from '../../base/shared/worker-progress.mjs';
import { workerTimeContext } from '../../base/shared/worker-time.mjs';
import { nativeModelConfig } from '../../base/shared/runtime-setting-fields.mjs';
import { nativeExecutionProgress } from '../../harness/src/remote-execution-progress.mjs';
import { attentionBatchAnswers } from './worker-attention.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });

function resultText(text) {
  const scan = {};
  return text.split('\n').filter(line => !scanWorkerProgressLine(line, scan)).join('\n').trim();
}

export function assertExternalWorkerTask(task, assignment = {}) {
  const mandate = task.mandate || {};
  if ([task.toolScope, mandate.toolScope, mandate.scope?.toolNames, assignment.appliedSnapshot?.toolScope].some(scope => scope != null)) {
    throw fail('NATIVE_WORKER_SCOPE_UNSUPPORTED', '外部 Harness 当前无法落实此工单的工具范围，请选择官方 Harness');
  }
}

export async function assertExternalWorkerModel(ctx, { harness, providerId, modelId, options }, signal) {
  signal?.throwIfAborted();
  if (!['codex', 'claude'].includes(harness)) throw fail('WORKER_MODEL_ROUTE', '外部 Worker Harness 未接入');
  const commander = ctx.get?.('commander');
  if (!commander?.prepareExecution || !commander?.registerExecutionHandler || !commander?.stopExecution)
    throw fail('WORKER_MODEL_ROUTE', '外部 Harness 执行服务不可用');
  const catalog = await commander.pickerCatalog?.list();
  signal?.throwIfAborted();
  const route = catalog?.routes?.find(route => route.tool === harness && route.providerId === providerId && route.nativeModelId === modelId);
  if (!route)
    throw fail('WORKER_MODEL_ROUTE', '此 Harness、供应商和模型组合当前不可用');
  try {
    const defaults = await commander.routeService?.defaultConfig?.(harness, providerId, modelId);
    signal?.throwIfAborted();
    return { commander, advancedConfig: nativeModelConfig(harness, defaults, route.reasoning, options) };
  } catch (error) {
    signal?.throwIfAborted();
    throw fail('WORKER_MODEL_ROUTE', error.message);
  }
}

export async function executeExternalWorker({ ctx, database, assignment, task, signal, renew, run, directory, workingDirectory, model, resumed, sourceReference }) {
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  let snapshot = database.appliedTaskSnapshot(assignment.id);
  assertExternalWorkerTask({ ...task, ...snapshot }, assignment);
  const { commander, advancedConfig } = resumed ? { commander: ctx.get?.('commander') } : await assertExternalWorkerModel(ctx, model, signal);
  const prior = resumed && commander?.executionSession(run.id);
  if (resumed && (!prior?.nativeId || prior.id !== run.sessionId
    || (!assignment.contextContinuation && !assignment.pauseContinuation))) {
    throw fail('NATIVE_WORKER_CONTINUATION_UNSUPPORTED', '原生执行缺少可确认的续接条件，请检查原会话');
  }
  const sessionId = run.sessionId;
  const projection = database.getExecutionProjection(sessionId);
  const previous = projection?.runId === run.id ? projection.state : null;
  const progress = nativeExecutionProgress(sessionId, previous?.activityHistory?.length ? { worker: {
    ...previous, id: sessionId, history: previous.activityHistory, historyTruncated: previous.activityHistoryTruncated,
  } } : undefined);
  let instructionRevision = snapshot?.instructionRevision ?? assignment.instructionRevision;
  const prompt = (continuing, messages) => (continuing ? 'Continue the original execution from its saved history. Preserve completed actions.\n' : '')
    + 'Execute this BenchGo task in the bound project. Follow its current mandate. Ask the user for missing information through the native question tool. Leave approvals and product configuration to the Router. Preserve existing work and report results and unresolved issues from observed evidence.\n'
    + workerProgressInstruction + '\n'
    + workerTimeContext(task.mandate.requestTime, task.createdAt) + '\n'
    + JSON.stringify({ target: snapshot?.target ?? task.target, acceptance: snapshot?.acceptance ?? task.acceptance,
      executionScope: snapshot?.executionScope || assignment.text, mandate: snapshot?.mandate ?? task.mandate,
      context: snapshot?.context, ownerMessages: messages.map(({ content }) => content), sourceReference });
  let session, releaseHandler, submitted = false, terminal, result, primaryFailure, waiting = 0;
  const lifecycle = new AbortController();
  const lifeSignal = AbortSignal.any([signal, lifecycle.signal]);
  const inspect = () => {
    lifeSignal.throwIfAborted();
    const liveTask = database.getTask(task.id);
    if (liveTask?.executionControl?.stopRequested || liveTask?.executionControl?.stopped)
      throw fail('NATIVE_WORKER_STOP_REQUESTED', '工单已请求停止');
    return liveTask?.executionControl?.pauseRequested === true;
  };
  const messagesForTurn = () => {
    const pending = new Map(database.pendingTaskInputs(task.id).filter(input => input.kind === 'context').map(input => [input.triggerId, input]));
    return pending.size ? database.pendingSubscriptionMessages(task.id).filter(message => pending.has(message.id))
      .map(message => ({ ...message, content: pending.get(message.id).snapshot?.text ?? message.content })) : [];
  };
  const observe = (status, seq, observedAt, kind, complete = false) => {
    const worker = progress.snapshot()?.worker;
    const activity = status === 'running' && worker?.activity || { running: '外部 Harness 正在执行', waiting: '等待答复', completed: '执行已结束',
      cancelled: '执行已停止', failed: '执行失败' }[status];
    database.recordExecutionProjection({ ...ownership, taskId: task.id, assignmentId: assignment.id, runId: run.id, sessionId,
      cursor: seq, complete, state: { status, activity, updatedAt: status === 'running' && worker?.updatedAt || observedAt,
        activitySource: status === 'running' ? worker?.activitySource : 'runtime',
        activityHistory: worker?.history, activityHistoryTruncated: worker?.historyTruncated }, kind,
      live: { status: status === 'running' ? 'running' : status === 'waiting' ? 'idle' : 'disposed', observedAt } });
  };
  try {
    inspect();
    session = await commander.prepareExecution({ executionId: run.id, sessionId, provider: model.harness, cwd: workingDirectory,
      route: prior?.route || { providerId: model.providerId, model: model.modelId }, advancedConfig, projectId: task.mandate?.project?.id, title: task.title,
      metadata: { taskId: task.id, assignmentId: assignment.id, runId: run.id, instructionRevision } });
    inspect();
    releaseHandler = commander.registerExecutionHandler(session.id, (request, requestSignal) => {
      if (request.kind !== 'question') return { allow: false };
      return askNativeQuestion(model.harness, request, async ({ questions }) => {
        if (inspect()) throw fail('NATIVE_WORKER_PAUSING', '工单正在暂停');
        waiting++;
        try {
          const callId = String(request.nativeRequestId ?? request.id);
          const entries = database.openAttention(assignment.id, { ...ownership, sessionId, callId, questions });
          const observed = commander.snapshot(sessionId);
          observe('waiting', observed.cursor, observed.updatedAt, 'external.question');
          const questionSignal = requestSignal ? AbortSignal.any([lifeSignal, requestSignal]) : lifeSignal;
          for (;;) {
            questionSignal.throwIfAborted();
            if (inspect()) throw fail('NATIVE_WORKER_PAUSING', '工单正在暂停');
            if (database.getTask(task.id).instructionRevision !== instructionRevision)
              throw fail('NATIVE_WORKER_QUESTION_SUPERSEDED', '原问题已被修订替换');
            const answers = database.attentions(task.id).filter(item => item.sessionId === sessionId && item.callId === callId);
            if (entries.every(entry => answers.some(item => item.id === entry.id && item.answerTriggerId)))
              return { answers: attentionBatchAnswers(database, task.id, { sessionId, callId, questions }) };
            await delay(250, undefined, { signal: questionSignal });
          }
        } finally { waiting--; }
      });
    });
    await renew();
    inspect();
    database.updateRun(run.id, { ...ownership, state: 'submitted' });
    submitted = true;
    let cursor = session.cursor ?? 0, continuing = !!resumed;
    let requestId = resumed
      ? `worker:${run.id}:${assignment.pauseContinuation ? 'pause' : 'context'}:${resumed.evidence?.transcript?.lastSeq}`
      : `worker:${run.id}`;
    let summaryDraft, digest, firstTurn = true;
    for (;;) {
      inspect();
      const liveTask = database.getTask(task.id);
      assertExternalWorkerTask(liveTask);
      const next = database.taskRevisions(task.id).findLast(row => row.instructionRevision === liveTask.instructionRevision);
      if (next && next.instructionRevision > instructionRevision) {
        snapshot = { ...next, executionScope: assignment.wholeTaskScope === false ? assignment.text : next.target };
        instructionRevision = next.instructionRevision;
      }
      const messages = messagesForTurn();
      terminal = undefined;
      const receipt = await commander.submit(session.id, prompt(continuing, messages), { requestId });
      if (receipt.status !== 'accepted') throw fail('NATIVE_WORKER_UNCERTAIN', '原生工具尚未确认已收到工单');
      await commander.persist();
      database.applyTaskRevision(assignment.id, { ...ownership, runId: run.id,
        boundaryId: `native:${receipt.turnId}`, receivedRevision: instructionRevision });
      for (const message of messages) database.acknowledgeSubscriptionMessage(assignment.id, { ...ownership,
        triggerId: message.id, sessionId, messageId: `${receipt.turnId}:${message.id}` });
      if (firstTurn) {
        database.updateRun(run.id, { ...ownership, state: 'running' });
        firstTurn = false;
      }
      digest = createHash('sha256');
      summaryDraft = '';
      for (;;) {
        const pausing = inspect();
        const batch = commander.events(session.id, cursor, 500);
        if (batch.truncated) throw fail('NATIVE_WORKER_HISTORY_TRUNCATED', '原生事件不完整，无法核实工单终态');
        cursor = batch.cursor;
        const previousProgress = progress.snapshot()?.worker;
        for (const event of batch.events) {
          if (event.turnId !== receipt.turnId) continue;
          digest.update(JSON.stringify(event) + '\n');
          progress.observe(event);
          if (event.type === 'text.delta') summaryDraft = (summaryDraft + (event.data?.text || '')).slice(-32_000);
          if (event.type === 'turn.completed') terminal = event;
        }
        const activity = progress.snapshot()?.worker;
        if (!terminal && !waiting && activity && activity !== previousProgress)
          observe('running', cursor, activity.updatedAt, 'external.progress');
        if (terminal) break;
        if (cursor < batch.latest) continue;
        const changed = database.getTask(task.id).instructionRevision !== instructionRevision || (!waiting && messagesForTurn().length > 0);
        if (pausing || changed) {
          const stopped = await commander.stopExecution(session.id);
          if (stopped.status !== 'idle' || stopped.cursor === cursor)
            throw fail('NATIVE_WORKER_STOP_UNCONFIRMED', '原生执行中断尚未核实');
          continue;
        }
        const state = await commander.wait(session.id, { timeout: 500, signal: lifeSignal });
        if (state.status === 'running') observe('running', state.cursor, state.updatedAt, 'external.progress');
        if (['closed', 'disconnected', 'failed', 'idle'].includes(state.status) && state.cursor === cursor)
          throw fail('NATIVE_WORKER_UNCERTAIN', '原生会话结束时缺少可核实的工单回执');
      }
      if (inspect() || !['completed', 'interrupted', 'cancelled'].includes(terminal.data?.status)
        || (database.getTask(task.id).instructionRevision === instructionRevision && !messagesForTurn().length)) break;
      requestId = `worker:${run.id}:input:${terminal.seq}`;
      continuing = true;
    }
    await commander.persist();
    const finalText = terminal.data?.result;
    const summary = (typeof finalText === 'string' ? resultText(finalText.slice(-32_000)) : '') || resultText(summaryDraft);
    const waitingPause = inspect() && ['completed', 'interrupted', 'cancelled'].includes(terminal.data?.status);
    if (!waitingPause && (terminal.data?.status !== 'completed' || !summary)) throw fail('NATIVE_WORKER_FAILED', '外部 Harness 没有返回已完成的工单结果');
    result = { summary, transcript: { lastSeq: terminal.seq, hash: digest.digest('hex') },
      completion: { kind: waitingPause ? 'blocked' : 'completed', at: terminal.time }, instructionRevision, sessionId, runId: run.id, directory,
      ...(waitingPause ? { waitingPause: true } : {}),
      nativeExecution: { provider: model.harness, sessionId, nativeId: commander.snapshot(session.id).nativeId },
      executionEffects: { effectsVerified: false, unknownCallIds: [] }, evidenceRefs: [{ sessionId, runId: run.id }] };
    database.saveWorkerDraft(assignment.id, { runId: run.id, ...ownership, result });
    database.updateRun(run.id, { ...ownership, state: 'verifying', evidence: result });
    observe(waitingPause ? 'waiting' : 'completed', terminal.seq, terminal.time, waitingPause ? 'external.paused' : 'external.completed', true);
    return result;
  } catch (error) {
    primaryFailure = Object.assign(new Error(error.message || String(error), { cause: error }), {
      code: error.code, executionPhase: submitted ? 'completion' : 'setup',
      executionEffects: { effectsVerified: !submitted, unknownCallIds: [] },
      ...(result && { resultDraft: result }),
    });
    throw primaryFailure;
  } finally {
    lifecycle.abort();
    releaseHandler?.();
    try {
      if (session && submitted && !['interrupted', 'cancelled', 'completed'].includes(terminal?.data?.status)) {
        const stopped = await commander.stopExecution(session.id);
        if (stopped.status !== 'idle' && !(stopped.archived && stopped.status === 'closed')) throw fail('NATIVE_WORKER_STOP_UNCONFIRMED', '原生执行停止尚未核实');
        observe('cancelled', stopped.cursor, stopped.updatedAt, 'external.stopped', true);
      }
      if (session) await commander.disconnect(session.id);
      database.confirmExecutionStopped(assignment.id, ownership);
    } catch (error) {
      try { database.updateRun(run.id, { ...ownership, state: 'uncertain' }); } catch { /* The original lease may have expired. */ }
      if (primaryFailure) primaryFailure.cleanupFailure = String(error.message || error);
      else throw Object.assign(error, { resultDraft: result, executionPhase: 'cleanup',
        executionEffects: { effectsVerified: false, unknownCallIds: [] } });
    }
  }
}
