import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { askNativeQuestion } from '../../base/src/questions.mjs';
import { attentionBatchAnswers } from './worker-attention.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });

export function assertExternalWorkerTask(task, assignment = {}) {
  const mandate = task.mandate || {};
  if ([task.toolScope, mandate.toolScope, mandate.scope?.toolNames, assignment.appliedSnapshot?.toolScope].some(scope => scope != null)) {
    throw fail('NATIVE_WORKER_SCOPE_UNSUPPORTED', '外部 Harness 当前无法落实此工单的工具范围，请选择官方 Harness');
  }
}

export async function assertExternalWorkerModel(ctx, { harness, providerId, modelId, options }, signal) {
  signal?.throwIfAborted();
  if (!['codex', 'claude'].includes(harness)) throw fail('WORKER_MODEL_ROUTE', '外部 Worker Harness 未接入');
  if (Object.keys(options ?? {}).length) throw fail('WORKER_MODEL_ROUTE', '外部 Worker 的运行参数在 Harness 高级设置中配置');
  const commander = ctx.get?.('commander');
  if (!commander?.prepareExecution || !commander?.registerExecutionHandler || !commander?.stopExecution)
    throw fail('WORKER_MODEL_ROUTE', '外部 Harness 执行服务不可用');
  const catalog = await commander.pickerCatalog?.list();
  signal?.throwIfAborted();
  if (!catalog?.routes?.some(route => route.tool === harness && route.providerId === providerId && route.nativeModelId === modelId))
    throw fail('WORKER_MODEL_ROUTE', '此 Harness、供应商和模型组合当前不可用');
  return commander;
}

export async function executeExternalWorker({ ctx, database, assignment, task, signal, renew, run, directory, workingDirectory, model, resumed, sourceReference }) {
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const snapshot = database.appliedTaskSnapshot(assignment.id);
  assertExternalWorkerTask({ ...task, ...snapshot }, assignment);
  const commander = resumed ? ctx.get?.('commander') : await assertExternalWorkerModel(ctx, model, signal);
  const prior = resumed && commander?.executionSession(run.id);
  if (resumed && (!prior?.nativeId || prior.id !== run.sessionId || !assignment.contextContinuation)) {
    throw fail('NATIVE_WORKER_CONTINUATION_UNSUPPORTED', '原生执行缺少可确认的续接条件，请检查原会话');
  }
  const sessionId = run.sessionId;
  const instructionRevision = snapshot?.instructionRevision ?? assignment.instructionRevision;
  const prompt = 'Execute this BenchGo task in the bound project. Follow its current mandate. Ask the user for missing information through the native question tool. Leave approvals and product configuration to the Router. Preserve existing work and report results and unresolved issues from observed evidence.\n'
    + JSON.stringify({ target: snapshot?.target ?? task.target, acceptance: snapshot?.acceptance ?? task.acceptance,
      executionScope: snapshot?.executionScope || assignment.text, mandate: snapshot?.mandate ?? task.mandate,
      context: snapshot?.context, sourceReference });
  let session, releaseHandler, submitted = false, terminal, result, primaryFailure;
  const lifecycle = new AbortController();
  const lifeSignal = AbortSignal.any([signal, lifecycle.signal]);
  const inspect = () => {
    lifeSignal.throwIfAborted();
    const liveTask = database.getTask(task.id);
    if (liveTask?.executionControl?.stopRequested || liveTask?.executionControl?.stopped)
      throw fail('NATIVE_WORKER_STOP_REQUESTED', '工单已请求停止');
    if (liveTask?.executionControl?.pauseRequested)
      throw fail('NATIVE_WORKER_PAUSE_UNSUPPORTED', '外部 Harness 当前没有可确认的暂停边界，正在停止原执行');
    if (liveTask?.instructionRevision !== instructionRevision)
      throw fail('NATIVE_WORKER_REVISION_UNSUPPORTED', '外部 Harness 当前无法应用修订，正在停止原执行');
  };
  const observe = (status, seq, observedAt, kind, complete = false) => {
    const activity = { running: '外部 Harness 正在执行', waiting: '等待答复', completed: '执行已结束',
      cancelled: '执行已停止', failed: '执行失败' }[status];
    database.recordExecutionProjection({ ...ownership, taskId: task.id, assignmentId: assignment.id, runId: run.id, sessionId,
      cursor: seq, complete, state: { status, activity, updatedAt: observedAt }, kind,
      live: { status: status === 'running' ? 'running' : status === 'waiting' ? 'idle' : 'disposed', observedAt } });
  };
  try {
    inspect();
    session = await commander.prepareExecution({ executionId: run.id, sessionId, provider: model.harness, cwd: workingDirectory,
      route: prior?.route || { providerId: model.providerId, model: model.modelId }, projectId: task.mandate?.project?.id, title: task.title,
      metadata: { taskId: task.id, assignmentId: assignment.id, runId: run.id, instructionRevision } });
    inspect();
    releaseHandler = commander.registerExecutionHandler(session.id, (request, requestSignal) => {
      if (request.kind !== 'question') return { allow: false };
      return askNativeQuestion(model.harness, request, async ({ questions }) => {
        inspect();
        const callId = String(request.nativeRequestId ?? request.id);
        const entries = database.openAttention(assignment.id, { ...ownership, sessionId, callId, questions });
        const observed = commander.snapshot(sessionId);
        observe('waiting', observed.cursor, observed.updatedAt, 'external.question');
        const questionSignal = requestSignal ? AbortSignal.any([lifeSignal, requestSignal]) : lifeSignal;
        for (;;) {
          questionSignal.throwIfAborted();
          inspect();
          const answers = database.attentions(task.id).filter(item => item.sessionId === sessionId && item.callId === callId);
          if (entries.every(entry => answers.some(item => item.id === entry.id && item.answerTriggerId)))
            return { answers: attentionBatchAnswers(database, task.id, { sessionId, callId, questions }) };
          await delay(250, undefined, { signal: questionSignal });
        }
      });
    });
    await renew();
    inspect();
    database.updateRun(run.id, { ...ownership, state: 'submitted' });
    submitted = true;
    let cursor = session.cursor ?? 0;
    const receipt = await commander.submit(session.id, prompt, { requestId: resumed
      ? `worker:${run.id}:context:${resumed.evidence?.transcript?.lastSeq}`
      : `worker:${run.id}` });
    if (receipt.status === 'uncertain') throw fail('NATIVE_WORKER_UNCERTAIN', '原生工具尚未确认已收到工单');
    database.updateRun(run.id, { ...ownership, state: 'running' });
    const digest = createHash('sha256');
    let summaryDraft = '';
    for (;;) {
      inspect();
      const batch = commander.events(session.id, cursor, 500);
      if (batch.truncated) throw fail('NATIVE_WORKER_HISTORY_TRUNCATED', '原生事件不完整，无法核实工单终态');
      cursor = batch.cursor;
      for (const event of batch.events) {
        if (event.turnId !== receipt.turnId) continue;
        digest.update(JSON.stringify(event) + '\n');
        if (event.type === 'text.delta') summaryDraft = (summaryDraft + (event.data?.text || '')).slice(-32_000);
        if (event.type === 'turn.completed') terminal = event;
      }
      if (terminal) break;
      const state = await commander.wait(session.id, { timeout: 500, signal: lifeSignal });
      if (state.status === 'running') observe('running', state.cursor, state.updatedAt, 'external.progress');
      if (['closed', 'disconnected', 'failed', 'idle'].includes(state.status) && state.cursor === cursor)
        throw fail('NATIVE_WORKER_UNCERTAIN', '原生会话结束时缺少可核实的工单回执');
    }
    await commander.persist();
    const summary = terminal.data?.result?.trim?.().slice(-32_000) || summaryDraft.trim();
    if (terminal.data?.status !== 'completed' || !summary) throw fail('NATIVE_WORKER_FAILED', '外部 Harness 没有返回已完成的工单结果');
    result = { summary, transcript: { lastSeq: terminal.seq, hash: digest.digest('hex') },
      completion: { kind: 'completed', at: terminal.time }, instructionRevision, sessionId, runId: run.id, directory,
      nativeExecution: { provider: model.harness, sessionId, nativeId: commander.snapshot(session.id).nativeId },
      executionEffects: { effectsVerified: false, unknownCallIds: [] }, evidenceRefs: [{ sessionId, runId: run.id }] };
    database.saveWorkerDraft(assignment.id, { runId: run.id, ...ownership, result });
    database.updateRun(run.id, { ...ownership, state: 'verifying', evidence: result });
    observe('completed', terminal.seq, terminal.time, 'external.completed', true);
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
        if (stopped.status !== 'idle') throw fail('NATIVE_WORKER_STOP_UNCONFIRMED', '原生执行停止尚未核实');
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
