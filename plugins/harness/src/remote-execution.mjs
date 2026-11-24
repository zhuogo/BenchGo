import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';
import { openRemoteExecutionStore, executionError, executionTerminal, executionFingerprint } from './remote-execution-store.mjs';
import { nativeExecutionProgress, officialExecutionProgress } from './remote-execution-progress.mjs';
import { askNativeQuestion } from '../../base/src/questions.mjs';
import { installWorkerProgressPrompt, workerProgressInstruction } from '../../base/shared/worker-progress.mjs';
import { workerTimeContext } from '../../base/shared/worker-time.mjs';
import { nativeModelConfig } from '../../base/shared/runtime-setting-fields.mjs';
import plugin from '../../base/package.json' with { type: 'json' };

export const REMOTE_EXECUTION_VERSION = 2;
export const REMOTE_EXECUTION_OPERATIONS = Object.freeze(['catalog', 'submit', 'get', 'input', 'control', 'ack', 'archive', 'archives']);
const required = (value, label, max = 512) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw executionError('INVALID_EXECUTION_REQUEST', `${label}无效`, 400);
  return value;
};
const revision = value => { if (!Number.isSafeInteger(value) || value < 1) throw executionError('INVALID_EXECUTION_REVISION', '要求版本必须由业务宿主提供正整数', 400); return value; };

const assignedWorkspaceGuidance = 'Execute the assigned scope in the bound working directory. Use mandate.instruction and its source to check the original wording and applicable constraints. Device or project references that only select the execution location, and requests to create or dispatch this task, describe routing already handled by the owner. Carry out any cross-device access, transfer or comparison that is explicitly part of the assigned work within its authorized scope.';
const getService = (ctx, name) => ctx.get ? ctx.get(name) : ctx[name];
const hasModelActivity = log => {
  const events = log?.events ?? [];
  const turnStart = events.findLastIndex(event => event.type === 'turn/start');
  return events.slice(turnStart + 1).some(event => ['request/header', 'assistant/message'].includes(event.type));
};
const startupFailure = (row, log, evidence) => evidence.completion?.kind === 'error'
  && evidence.completion.error?.code === 'TOOL_ACTIVATION_FAILED' && row.appliedInstructionRevision === 0
  && !row.pauseRequested && !row.cancelRequested && evidence.executionEffects.effectsVerified
  && !log.events.some(event => ['request/header', 'assistant/message', 'tool/result', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch'].includes(event.type));
const neverStarted = message => ({ reason: message, error: { code: 'EXECUTION_NEVER_STARTED', message },
  executionEffects: { effectsVerified: true, unknownCallIds: [] } });
const publicExecution = row => {
  const { principal, messages, pendingInputs, pendingCommands, nativeSubmission, text, binding, ...value } = row;
  return { ...value, executionId: row.id };
};

/** Derive terminal evidence from the real official transcript, never an idle handle. */
export function remoteExecutionEvidence(log, row) {
  const events = log?.events || [];
  let completion;
  const texts = [], calls = new Map();
  for (const event of events) {
    if (['turn/start', 'step/start', 'assistant/message', 'tool/result', 'user/message'].includes(event.type)) completion = undefined;
    if (event.type === 'turn/end') completion = event.data?.reason;
    if (event.type === 'assistant/message') {
      const blocks = event.data?.message?.content || [];
      const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (text.trim()) texts.push(text);
      for (const block of blocks) if (block.type === 'tool-call') calls.set(block.id, { name: block.name });
    }
    if (event.type === 'tool/result') {
      const message = event.data?.message, id = message?.toolCallId ?? message?.source?.callId;
      const call = calls.get(id);
      if (call) call.settled = !message?.isError && !event.data?.error;
    }
    if (event.type === 'tool/ptc-dispatch-start') calls.set(event.data?.subCallId, { name: event.data?.name });
    if (event.type === 'tool/ptc-dispatch') {
      const id = event.data?.subCallId;
      calls.set(id, { name: event.data?.name, settled: !event.data?.isError && !event.data?.error });
    }
  }
  const readOnly = new Set(['web_search', 'web_fetch', 'read', 'read_image', 'glob', 'grep']);
  const unknownCallIds = [...calls].filter(([, call]) => !call.settled && !readOnly.has(call.name)).map(([id]) => id);
  return { summary: texts.at(-1) || '', sessionId: row.sessionId,
    transcript: { lastSeq: events.at(-1)?.seq ?? null, hash: createHash('sha256').update(JSON.stringify(events)).digest('hex') },
    completion, instructionRevision: row.appliedInstructionRevision,
    executionEffects: { effectsVerified: !unknownCallIds.length, unknownCallIds } };
}

/** An authenticated host submits execution instances; no SuperAgent or Task database is involved. */
export async function createRemoteExecutionService({ ctx, directory, commander = getService(ctx, 'commander'), maxConcurrent = 4 }) {
  const store = openRemoteExecutionStore(directory), live = new Map(), officialProgressOwners = new Map(), jobs = new Set(), recoveries = new Map();
  let closed = false;
  const llm = getService(ctx, 'llm'), agents = getService(ctx, 'agents'), query = getService(ctx, 'sessionQuery');
  const registry = getService(ctx, 'workspaceRegistry');
  const recordArchive = (sessionId, archived = true) => {
    const row = store.bySession(sessionId);
    if (!row?.sessionOwned) return;
    const needsStop = archived && !row.cancelRequested && !executionTerminal(row.phase);
    store.tx(() => {
      store.archiveSession(row, archived);
      if (needsStop) { row.cancelRequested = true; store.save(row); }
    });
    if (needsStop) {
      const running = live.get(row.id);
      if (running) running.abort.abort(executionError('EXECUTION_CANCELLED', '执行会话已归档'));
      else if (row.phase === 'paused' && row.writerReleasedAt) emitPhase(row, 'stopped');
      else void recover(row.id, true).catch(() => {});
    }
  };
  const active = row => { store.assertFence(row); if (closed || row.cancelRequested || executionTerminal(row.phase)) throw executionError('EXECUTION_INACTIVE', '执行实例已停止或待核实'); };
  const emitPhase = (row, phase, extra = {}) => {
    Object.assign(row, extra, { phase }); store.save(row); store.event(row.id, 'execution.phase', { phase, ...extra });
  };
  const publishProgress = (id, progress = live.get(id)?.progress) => {
    try { store.publishProgress(id, progress?.snapshot()); }
    catch { ctx.logger?.warn?.('Could not save public execution progress'); }
  };
  const response = (row, input = {}) => {
    publishProgress(row.id);
    return { version: REMOTE_EXECUTION_VERSION, execution: publicExecution(row), ...store.page(row.id, input.after, input.limit),
      ...(input.requestId && store.receipt(row.principal, input.requestId) ? { receipt: store.receipt(row.principal, input.requestId) } : {}) };
  };
  const projects = () => (registry?.list?.() || []).filter(item => isAbsolute(item.path || '')).map(({ id, path, title }) => ({ id, path, title: title || id }));
  const modelCatalog = async () => {
    const rows = (await commander?.pickerCatalog?.list())?.routes ?? [];
    const native = !!(commander?.prepareExecution && commander?.stopExecution && commander?.registerExecutionHandler);
    return rows.filter(row => row.tool === 'deepseek' || native && ['codex', 'claude'].includes(row.tool)).map(row => ({
      harness: row.tool === 'deepseek' ? 'official' : row.tool,
      providerId: row.providerId, modelId: row.nativeModelId, name: row.name || row.nativeModelId,
      ...(row.reasoning ? { reasoning: row.reasoning } : {}),
      ...(row.protocol ? { protocol: row.protocol } : {}),
    }));
  };
  const checkModel = async (config, candidates) => {
    const harness = config?.harness;
    if (!['official', 'codex', 'claude'].includes(harness)
      || !Array.isArray(config.models) || config.models.length !== 1)
      throw executionError('UNSUPPORTED_EXECUTION_CONFIG', '执行实例必须冻结目标设备目录中的一个 Harness、供应商与模型组合', 422);
    const model = config.models[0]; required(model?.providerId, '供应商 ID'); required(model.modelId, '模型 ID');
    const params = model.params === undefined ? {} : model.params;
    if (params === null || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !['reasoningEffort', 'maxTokens', 'temperature', 'stop'].includes(key))) throw executionError('INVALID_EXECUTION_CONFIG', '模型参数不受支持', 422);
    const candidate = candidates.find(item => item.harness === harness && item.providerId === model.providerId && item.modelId === model.modelId);
    if (!candidate)
      throw executionError('EXECUTION_MODEL_UNAVAILABLE', '冻结 Harness/API/模型组合不在目标设备可用目录中', 422);
    let binding;
    if (harness === 'official') {
      const info = await llm.resolveModelInfo(model.providerId, model.modelId);
      if (info.provider !== model.providerId || info.id !== model.modelId) throw executionError('EXECUTION_MODEL_MISMATCH', '执行设备返回了不同模型', 422);
      if (params.reasoningEffort !== undefined && !info.reasoning?.efforts?.some(item => item.id === params.reasoningEffort)) throw executionError('UNSUPPORTED_EXECUTION_CONFIG', '冻结推理参数不受所选模型支持', 422);
    } else {
      if (!commander?.providers?.has(harness) || typeof commander.routeService?.capture !== 'function')
        throw executionError('EXECUTION_ADAPTER_UNAVAILABLE', '目标设备未提供该外部 Harness 的 API 执行适配器', 422);
      const defaults = await commander.routeService.defaultConfig?.(harness, model.providerId, model.modelId) ?? await commander.advancedConfig(harness);
      let advancedConfig;
      try { advancedConfig = nativeModelConfig(harness, defaults, candidate.reasoning, params); }
      catch (error) { throw executionError('UNSUPPORTED_EXECUTION_CONFIG', error.message, 422); }
      try { binding = await commander.routeService.capture({ tool: harness, providerId: model.providerId, model: model.modelId, ...(advancedConfig ? { advancedConfig } : {}) }); }
      catch (error) { throw executionError(error.code || 'EXECUTION_ROUTE_UNAVAILABLE', error.message, 422); }
    }
    if (params.maxTokens !== undefined && (!Number.isSafeInteger(params.maxTokens) || params.maxTokens < 1)
      || params.temperature !== undefined && (!Number.isFinite(params.temperature) || params.temperature < 0 || params.temperature > 2)
      || params.stop !== undefined && (!Array.isArray(params.stop) || params.stop.some(value => typeof value !== 'string'))) throw executionError('INVALID_EXECUTION_CONFIG', '模型参数无效', 422);
    return binding;
  };
  const workerPreference = async (models, signal) => {
    const worker = await getService(ctx, 'assistant')?.readWorkerModels?.();
    signal?.throwIfAborted();
    if (!worker?.models.length) return undefined;
    for (const model of worker.models) {
      const config = { harness: worker.harness, models: [model] };
      try { await checkModel(config, models); }
      catch { signal?.throwIfAborted(); continue; }
      signal?.throwIfAborted();
      return { config };
    }
    return { error: { code: 'EXECUTION_WORKER_UNAVAILABLE', message: '目标设备已配置 Worker，但其 Harness、模型或参数当前均不可用，请检查目标设备的工作模型设置' } };
  };
  const checkConfig = async input => {
    const binding = await checkModel(input.config, await modelCatalog());
    const project = input.projectId === undefined ? null : projects().find(item => item.id === input.projectId);
    if (input.projectId !== undefined && !project) throw executionError('EXECUTION_PROJECT_UNAVAILABLE', '执行工作区不在设备真实目录中', 422);
    const frozen = input.requirements?.mandate?.project;
    if (project ? !frozen || frozen.id !== project.id || frozen.path !== project.path : frozen != null) throw executionError('EXECUTION_PROJECT_CHANGED', '冻结授权的工作区标识或路径与目标真实目录不一致', 422);
    return { project, binding };
  };
  const assertSessionAbsent = async sessionId => {
    if (agents?.get?.(sessionId) || store.bySession(sessionId)) throw executionError('EXECUTION_SESSION_CONFLICT', '执行会话 ID 已被占用，拒绝接管已有会话');
    try { await query.readSession(sessionId); }
    catch (error) {
      if (['SESSION_QUERY_SESSION_NOT_FOUND', 'ENOENT'].includes(error.code) || error.name === 'SessionPersistenceNotFoundError') {
        if (agents?.get?.(sessionId) || store.bySession(sessionId)) throw executionError('EXECUTION_SESSION_CONFLICT', '执行会话 ID 已被占用');
        return;
      }
      throw error;
    }
    throw executionError('EXECUTION_SESSION_CONFLICT', '执行会话 ID 已有官方历史，拒绝接管已有会话');
  };
  const persistMessage = (row, text, source = {}) => {
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'benchgo-execution', executionId: row.id, ...source } });
    row.messages.push(message.id);
    const command = row.pendingCommands.find(command => command.requestId === source.requestId);
    if (command) command.messageId = message.id;
    store.save(row); return message;
  };
  const settleEvidence = (row, log, { failure, recovering = false } = {}) => {
    const progress = live.get(row.id)?.progress || officialExecutionProgress(row.sessionId, store.progress(row.id));
    progress.replay(log);
    publishProgress(row.id, progress);
    const evidence = remoteExecutionEvidence(log, row);
    const changed = executionFingerprint(row.evidence || {}) !== executionFingerprint(evidence);
    row.evidence = evidence;
    if (evidence.completion?.kind === 'completed' && evidence.summary && row.receivedInstructionRevision === row.appliedInstructionRevision
      && !row.pendingCommands.length && !row.pendingInputs.length) {
      store.tx(() => { emitPhase(row, 'completed'); store.event(row.id, 'result', evidence); });
    } else if (startupFailure(row, log, evidence)) {
      emitPhase(row, 'failed', { reason: '远端首次模型请求前加载工具失败', error: { code: 'TOOL_ACTIVATION_FAILED', message: '远端首次模型请求前加载工具失败' } });
    } else if (row.submittedAt && !row.pauseRequested && !row.cancelRequested && evidence.executionEffects.effectsVerified && hasModelActivity(log)
      && (evidence.completion?.kind === 'error' || (!evidence.completion && (failure || recovering)))) {
      const cause = evidence.completion?.error ?? failure;
      const reason = cause ? String(cause.message || '远端模型执行出错') : '执行端重启中断了正在运行的任务';
      emitPhase(row, 'failed', { reason, error: { code: cause?.code || (recovering && !failure && !evidence.completion ? 'EXECUTION_INTERRUPTED' : 'EXECUTION_FAILED'), message: reason },
        executionEffects: evidence.executionEffects });
    } else if (evidence.completion?.kind === 'blocked' && row.pauseRequested) emitPhase(row, 'paused');
    else if (row.cancelRequested && ['cancelled', 'canceled'].includes(evidence.completion?.kind)) emitPhase(row, 'stopped');
    else if (row.phase !== 'uncertain' || changed) emitPhase(row, 'uncertain', {
      reason: '官方会话结束边界、要求版本或工具结果需要业务宿主核实',
      ...(failure ? { error: { code: failure.code || 'EXECUTION_FAILED', message: String(failure.message || failure) } } : {}),
    });
    else store.save(row);
    return evidence;
  };
  const externalPrompt = (row, submission) => [
    'Continue this single assignment in the frozen project. The owning host retains the business task and authorization. Do not create another task, delegate through BenchGo, or repeat completed actions.',
    assignedWorkspaceGuidance,
    'Ask the owner through the current question flow when required information is missing. Report factual results, changed files, and unresolved work.',
    workerProgressInstruction,
    workerTimeContext(submission.requirements.mandate.requestTime),
    JSON.stringify({ ...submission.requirements, identity: row.identity, workingDirectory: row.workingDirectory,
      ownerMessages: submission.commands.filter(command => command.kind === 'context').map(command => command.text) }),
    row.nativeResumeRequestId ? 'Resume the original paused native session and continue remaining work.' : row.text,
  ].filter(Boolean).join('\n\n');
  const externalEvidence = (row, events) => {
    const turn = events.filter(event => event.turnId === row.nativeTurnId);
    const ended = turn.findLast(event => event.type === 'turn.completed');
    const summary = ended?.data?.result?.trim?.()
      || turn.filter(event => event.type === 'text.delta').map(event => event.data?.text || '').join('').trim();
    return {
      summary, sessionId: row.sessionId,
      transcript: { lastSeq: ended?.seq ?? null, hash: createHash('sha256').update(JSON.stringify(turn)).digest('hex') },
      completion: ended ? { kind: ended.data.status, at: ended.time } : null,
      instructionRevision: row.appliedInstructionRevision,
      executionEffects: { effectsVerified: false, unknownCallIds: [] },
    };
  };
  const externalEvents = row => {
    const events = [];
    let cursor = row.nativeStartCursor, batch;
    do {
      batch = commander.events(row.sessionId, cursor, 500);
      if (batch.truncated) throw executionError('EXECUTION_HISTORY_TRUNCATED', '原生事件已截断，不能核实工单结果');
      events.push(...batch.events);
      cursor = batch.cursor;
    } while (batch.events.length && cursor < batch.latest);
    return events;
  };
  const supersedeExternalQuestion = row => {
    if (!row.question) return;
    store.event(row.id, 'question.superseded', { questionId: row.question.questionId,
      instructionRevision: row.receivedInstructionRevision });
    delete row.question;
  };
  const settleExternal = (row, evidence) => {
    if (evidence.completion?.kind !== 'completed' || !evidence.summary) return false;
    store.tx(() => {
      row.evidence = evidence;
      delete row.question;
      emitPhase(row, 'completed');
      store.event(row.id, 'result', evidence);
    });
    return true;
  };
  const markExternalApplied = (row, turnId) => {
    row.nativeTurnId = turnId;
    const submission = row.nativeSubmission ?? (!row.appliedInstructionRevision && {
      requirements: row.requirements, commands: row.pendingCommands.filter(command => command.kind === 'submit'),
    });
    if (!submission) { store.save(row); return; }
    store.tx(() => {
      row.appliedInstructionRevision = submission.requirements.instructionRevision;
      row.appliedRequirements = submission.requirements;
      const sent = new Set(submission.commands.map(command => command.requestId));
      row.pendingCommands = row.pendingCommands.filter(command => !sent.has(command.requestId));
      for (const { requestId, kind } of submission.commands) {
        const receipt = { requestId, kind, accepted: true, state: 'applied',
          instructionRevision: row.appliedInstructionRevision, receivedInstructionRevision: row.receivedInstructionRevision };
        store.updateCommand(row.principal, requestId, receipt);
        store.event(row.id, 'instruction.applied', receipt);
      }
      delete row.nativeSubmission;
      store.save(row);
    });
  };
  const runExternal = async (id, resume = false) => {
    const state = { abort: new AbortController(), questions: new Map() };
    live.set(id, state);
    let row = store.get(id), session, releaseHandler, terminal, continueInput = false;
    try {
      active(row);
      await mkdir(row.directory, { recursive: true });
      row = store.get(id); active(row);
      if (row.project && !projects().some(item => item.id === row.project.id && item.path === row.workingDirectory))
        throw executionError('EXECUTION_PROJECT_CHANGED', '冻结工作区已变化');
      if (resume) {
        const previous = commander.executionSession(id);
        const evidence = previous?.id === row.sessionId && previous.nativeId && externalEvidence(row, externalEvents(row));
        if (!evidence || evidence.transcript.hash !== row.evidence?.transcript.hash)
          throw executionError('EXECUTION_RESUME_UNVERIFIED', '无法核实原生会话的暂停记录');
      }
      session = await commander.prepareExecution({
        executionId: row.id, sessionId: row.sessionId, provider: row.config.harness, cwd: row.workingDirectory,
        route: row.binding, projectId: row.project?.id, title: row.requirements.target?.slice(0, 80),
        metadata: { identity: row.identity, instructionRevision: row.receivedInstructionRevision },
      });
      row = store.get(id); active(row);
      releaseHandler = commander.registerExecutionHandler(session.id, (request, requestSignal) => {
        if (request.kind !== 'question') return { allow: false };
        return askNativeQuestion(row.config.harness, request, async ({ questions }) => {
          const current = store.get(id); active(current);
          if (current.pauseRequested) throw executionError('EXECUTION_PAUSING', '工单正在暂停');
          const questionId = randomUUID();
          const callId = String(request.nativeRequestId ?? request.id ?? questionId);
          const signal = requestSignal ? AbortSignal.any([state.abort.signal, requestSignal]) : state.abort.signal;
          const turnId = commander.snapshot(session.id).turnId;
          if (!turnId) throw executionError('EXECUTION_QUESTION_UNAVAILABLE', '原生提问缺少执行轮次');
          if (current.question) throw executionError('EXECUTION_QUESTION_BUSY', '原生执行已有待答问题');
          markExternalApplied(current, turnId);
          return await new Promise((resolve, reject) => {
            const abort = () => {
              state.questions.delete(questionId);
              reject(signal.reason);
            };
            const answer = value => {
              signal.removeEventListener('abort', abort);
              state.questions.delete(questionId);
              resolve({ answers: value });
            };
            signal.throwIfAborted();
            current.question = { questionId, callId, version: 1, questions: structuredClone(questions), instructionRevision: current.appliedInstructionRevision };
            store.tx(() => { emitPhase(current, 'waiting'); store.event(id, 'question', current.question); });
            state.questions.set(questionId, answer);
            signal.addEventListener('abort', abort, { once: true });
          });
        });
      });
      row.sessionOwned = true;
      row.nativeStartCursor = session.cursor;
      if (resume) row.nativeTurnId = null;
      const submission = { requirements: structuredClone(row.requirements), commands: structuredClone(row.pendingCommands) };
      row.nativeSubmission = submission;
      row.submittedAt = new Date().toISOString();
      emitPhase(row, 'running');
      const receipt = await commander.submit(session.id, externalPrompt(row, submission), { requestId: row.nativeResumeRequestId || row.submitRequestId });
      if (receipt.status !== 'accepted') throw executionError('EXECUTION_SUBMISSION_UNCERTAIN', '原生工具尚未确认收到任务');
      await commander.persist();
      row = store.get(id); active(row);
      markExternalApplied(row, receipt.turnId);
      state.progress = nativeExecutionProgress(row.sessionId, store.progress(id));
      let cursor = session.cursor;
      const transcript = [];
      while (!terminal) {
        state.abort.signal.throwIfAborted();
        const current = store.get(id);
        active(current);
        const batch = commander.events(session.id, cursor, 500);
        if (batch.truncated) throw executionError('EXECUTION_HISTORY_TRUNCATED', '原生事件已截断，不能确认执行结果');
        cursor = batch.cursor;
        let progress = '';
        const flushProgress = () => {
          if (progress) store.event(id, 'progress', { text: progress });
          progress = '';
        };
        for (const event of batch.events) {
          if (event.turnId !== receipt.turnId) continue;
          transcript.push(event);
          state.progress.observe(event);
          if (event.type === 'text.delta') {
            const text = event.data?.text || '';
            if (progress.length + text.length > 8192) flushProgress();
            progress += text;
          } else flushProgress();
          if (event.type === 'turn.completed') terminal = event;
        }
        flushProgress();
        if (terminal || cursor < batch.latest) continue;
        if (current.pauseRequested || current.pendingCommands.length && (!current.question || current.receivedInstructionRevision > current.appliedInstructionRevision)) {
          const stopped = await commander.stopExecution(session.id);
          if (stopped.status !== 'idle' || stopped.cursor === cursor)
            throw executionError('EXECUTION_STOP_UNVERIFIED', '原生暂停尚未核实');
          continue;
        }
        const status = commander.snapshot(session.id).status;
        if (['idle', 'failed', 'closed', 'disconnected'].includes(status))
          throw executionError('EXECUTION_TERMINAL_UNCERTAIN', '原生会话缺少可核实的结束事件');
        await commander.wait(session.id, { timeout: 250, signal: state.abort.signal });
      }
      await commander.persist();
      row = store.get(id); active(row);
      publishProgress(id);
      const evidence = externalEvidence(row, transcript);
      await commander.disconnect(session.id);
      session = null;
      row = store.get(id);
      row.writerReleasedAt = new Date().toISOString();
      if (row.cancelRequested) { delete row.question; emitPhase(row, 'stopped'); }
      else if ((row.pauseRequested || row.pendingCommands.length) && ['completed', 'interrupted', 'cancelled'].includes(evidence.completion?.kind)) {
        row.evidence = evidence;
        store.tx(() => {
          supersedeExternalQuestion(row);
          if (row.pauseRequested) emitPhase(row, 'paused');
          else {
            row.nativeResumeRequestId = `native-input:${evidence.transcript.lastSeq}`;
            store.save(row);
            continueInput = true;
          }
        });
      }
      else if (!settleExternal(row, evidence)) emitPhase(row, 'uncertain', {
        error: { code: 'NATIVE_WORKER_INCOMPLETE', message: '外部 Harness 未返回可核实的完成结果' },
      });
    } catch (error) {
      row = store.get(id);
      let stopped = !row.submittedAt;
      try {
        session ??= resume && !row.nativeTurnId ? undefined : commander.executionSession(id);
        if (session) {
          if (row.submittedAt && !terminal) {
            const result = await commander.stopExecution(session.id);
            stopped = ['idle', 'closed'].includes(result.status);
          }
          await commander.disconnect(session.id);
          row.writerReleasedAt = new Date().toISOString();
        } else if (!row.submittedAt) row.writerReleasedAt = new Date().toISOString();
      } catch { stopped = false; }
      delete row.question;
      if (!executionTerminal(row.phase)) {
        const phase = row.cancelRequested && stopped ? 'stopped' : row.submittedAt ? 'uncertain' : 'failed';
        if (phase === 'stopped') emitPhase(row, phase);
        else emitPhase(row, phase, { error: { code: error.code || 'EXECUTION_FAILED', message: String(error.message || error) } });
      }
    } finally {
      publishProgress(id);
      state.abort.abort();
      releaseHandler?.();
      live.delete(id);
    }
    if (continueInput && !closed) {
      const continuation = runExternal(id, true);
      if (live.has(id)) live.get(id).completion = continuation;
      await continuation;
    }
  };
  const run = async (id, resume = false) => {
    let row = store.get(id);
    if (row.config?.harness !== 'official') return runExternal(id, resume);
    const state = { abort: new AbortController(), questions: new Map(), handle: null,
      progress: officialExecutionProgress(row.sessionId, store.progress(id)) };
    live.set(id, state);
    let settle, fail, started = false;
    const idle = new Promise((resolve, reject) => { settle = resolve; fail = reject; }); idle.catch(() => {});
    const stop = () => { try { state.handle?.agent.cancel?.({ kind: closed ? 'disposed' : 'user' }); } finally { fail(state.abort.signal.reason || executionError('EXECUTION_STOPPED', '执行已停止')); } };
    state.abort.signal.addEventListener('abort', stop, { once: true });
    try {
      active(row);
      // The release mark must describe this run only; recovery reads it as proof that the latest writer is gone.
      if (row.writerReleasedAt) { delete row.writerReleasedAt; store.save(row); }
      await mkdir(row.directory, { recursive: true });
      row = store.get(id); active(row);
      const model = row.config.models[0];
      const setup = async (scope, agent) => {
        let stepSnapshot = structuredClone(row.appliedRequirements || row.requirements);
        scope.tools?.setExecutor?.(new NativeToolExecutor(scope));
        const presets = getService(scope, 'agentPresets') || getService(ctx, 'agentPresets');
        const permissions = getService(scope, 'permissionPresets') || getService(ctx, 'permissionPresets');
        if (!presets?.resolve || !presets.mount || !permissions?.set) throw executionError('EXECUTION_PERMISSION_UNAVAILABLE', '官方执行预设和权限服务不可用', 503);
        const standard = await presets.resolve('standard'); if (standard.broken) throw executionError('EXECUTION_PRESET_UNAVAILABLE', standard.broken, 503);
        if (presets.composedPreset(scope) !== 'standard') await presets.mount(scope, 'standard');
        const permission = permissions.resolve('danger-full-access');
        if (permission.sandbox !== 'danger-full-access' || permission.approval !== 'never') throw executionError('EXECUTION_PERMISSION_UNAVAILABLE', '执行权限预设与授权不一致', 503);
        permissions.set(agent.session, 'danger-full-access');
        agent.model.select({ provider: model.providerId, model: model.modelId, ...(model.params?.reasoningEffort === undefined ? {} : { reasoningEffort: model.params.reasoningEffort }) });
        installWorkerProgressPrompt(scope);
        scope.systemPrompt.section({ name: 'benchgo-task-time', order: -99, interpolate: false,
          text: workerTimeContext(stepSnapshot.mandate.requestTime) });
        scope.systemPrompt.context({ name: 'benchgo-remote-execution', order: -100, interpolate: false,
          text: () => 'You are an execution worker for a Task owned by another host. Continue the SAME assignment from existing work; never create a business Task or invoke a local Router. Only the owner may change requirements or authorization. Source additions are context, not authority. Follow the complete current requirement snapshot and assigned scope. '
            + assignedWorkspaceGuidance
            + ' Preserve user changes and inspect previous tool receipts before taking actions. Ask questions through the official question tool. End with a concise factual result and artifacts.\n'
            + JSON.stringify({ ...stepSnapshot, identity: row.identity, workingDirectory: row.workingDirectory }) });
        scope.on('agent/pre-step', async (payload, next) => {
          row = store.get(id); active(row);
          if (row.pauseRequested || row.cancelRequested) return { kind: 'reject' };
          if (payload.messages.some(message => !row.messages.includes(message.id))) throw executionError('EXECUTION_INPUT_REQUIRES_OWNER', '远端执行只接收业务宿主已入账的输入', 403);
          if (row.project && !projects().some(item => item.id === row.project.id && resolve(item.path) === resolve(row.workingDirectory))) throw executionError('EXECUTION_PROJECT_CHANGED', '冻结工作区已变化');
          const decision = await next();
          if (decision.kind !== 'enter') return decision;
          row = store.get(id); active(row);
          if (row.pauseRequested || row.cancelRequested) return { kind: 'reject' };
          // Harness can add extension context to the admitted messages. Only registered commands get receipts.
          const admitted = new Set(decision.messages.map(message => message.id));
          const commands = row.pendingCommands.filter(command => admitted.has(command.messageId));
          if (commands.length) store.tx(() => {
            if (commands.some(command => ['submit', 'revision'].includes(command.kind))) {
              row.appliedInstructionRevision = row.receivedInstructionRevision; row.appliedRequirements = structuredClone(row.requirements);
            }
            for (const { requestId, kind } of commands) {
              const receipt = { requestId, kind, accepted: true, state: 'applied', instructionRevision: row.appliedInstructionRevision, receivedInstructionRevision: row.receivedInstructionRevision };
              store.updateCommand(row.principal, requestId, receipt); store.event(id, 'instruction.applied', receipt);
            }
            row.pendingCommands = row.pendingCommands.filter(command => !admitted.has(command.messageId)); store.save(row);
          });
          stepSnapshot = structuredClone(row.appliedRequirements || row.requirements);
          return decision;
        }, { prepend: true });
        scope.on('tools/pre-execute', (execution, next) => {
          if (execution.agent !== agent) return next();
          row = store.get(id);
          if (!row || closed || executionTerminal(row.phase) || row.cancelRequested || row.pauseRequested)
            return { kind: 'deny', reason: '远端执行已停止或暂停', info: { code: 'ABORTED_BEFORE_DISPATCH' } };
          store.assertFence(row); return next();
        }, { prepend: true });
        scope.on('agent/request', async (_payload, next) => {
          const { provider: _p, model: _m, reasoningEffort: _r, maxTokens: _t, temperature: _temp, stop: _stop, ...inherited } = await next();
          row = store.get(id); active(row);
          return { ...inherited, ...(model.params || {}), provider: model.providerId, model: model.modelId };
        });
        scope.on('user-questions/request', async (request, next) => {
          if (request.agent !== agent) return next();
          row = store.get(id); active(row);
          // The next model boundary consumes the queued revision. An obsolete
          // question must release this step before that boundary can be reached.
          if (row.receivedInstructionRevision > row.appliedInstructionRevision)
            throw executionError('EXECUTION_QUESTION_SUPERSEDED', '业务宿主已修订完整要求，请按新快照重新判断，旧问题已撤销');
          const questionId = randomUUID(), callId = request.wait?.callId || questionId;
          const signal = AbortSignal.any([state.abort.signal, ...(request.signal ? [request.signal] : [])]);
          let hold, holdAbort;
          try {
            if (request.wait?.timed) {
              const questions = getService(scope, 'userQuestions');
              if (!questions?.attachWait) throw executionError('EXECUTION_QUESTION_UNAVAILABLE', '官方问题等待服务不可用');
              holdAbort = new AbortController();
              hold = questions.attachWait(agent, callId, AbortSignal.any([signal, holdAbort.signal]))[Symbol.asyncIterator](); await hold.next();
            }
            row = store.get(id); active(row); signal.throwIfAborted();
            if (row.receivedInstructionRevision > row.appliedInstructionRevision)
              throw executionError('EXECUTION_QUESTION_SUPERSEDED', '业务宿主已修订完整要求，请按新快照重新判断，旧问题已撤销');
            row.question = { questionId, callId, version: 1, questions: structuredClone(request.questions), instructionRevision: row.appliedInstructionRevision };
            store.tx(() => { emitPhase(row, 'waiting'); store.event(id, 'question', row.question); });
            return await new Promise((resolve, reject) => {
              const abort = () => { state.questions.delete(questionId); reject(signal.reason); };
              signal.addEventListener('abort', abort, { once: true });
              const answer = value => { signal.removeEventListener('abort', abort); resolve({ answers: value }); };
              answer.reject = error => { signal.removeEventListener('abort', abort); reject(error); };
              state.questions.set(questionId, answer);
              if (signal.aborted) abort();
            });
          } finally { holdAbort?.abort(); await hold?.return?.(); }
        }, { prepend: true });
        scope.on('agent/status', ({ status }) => { if (status === 'running') started = true; if (started && status === 'idle') settle(); });
        scope.on('agent/error', ({ error }) => fail(error));
        // The official factory has exclusively created/opened this Session.
        // Publish ownership only at its synchronous registration boundary.
        return { commit() {
          const current = store.get(id); active(current); current.sessionOwned = true; store.save(current);
          officialProgressOwners.set(current.sessionId, state.progress);
        } };
      };
      if (resume) {
        const current = await query.readSession(row.sessionId), observed = remoteExecutionEvidence(current, row);
        if (observed.transcript.hash !== row.evidence?.transcript.hash || observed.completion?.kind !== 'blocked') throw executionError('EXECUTION_RESUME_UNVERIFIED', '原始会话不再处于已核实的暂停边界');
        state.progress.replay(current);
      }
      state.handle = resume ? await agents.resume({ resumeSessionId: row.sessionId, signal: state.abort.signal, setup })
        : await agents.create({ sessionId: row.sessionId, signal: state.abort.signal, meta: { cwd: row.workingDirectory, agentPreset: 'standard' }, setup });
      row = store.get(id); active(row);
      if (row.project) {
        const workspace = await registry.resolveByPath(row.project.path);
        if (!workspace?.attachSession) throw executionError('EXECUTION_PROJECT_CHANGED', '冻结工作区不可绑定');
        await workspace.attachSession(row.sessionId);
      }
      row = store.get(id); active(row);
      const text = resume ? 'Continue this same execution from its verified paused transcript. Preserve all completed tool effects. Apply the latest owner snapshot; do not restart the original Task.' : row.text;
      const message = persistMessage(row, text, { requestId: resume ? undefined : row.submitRequestId });
      // The write intent precedes official submission. A crash never triggers blind replay.
      emitPhase(row, 'running', { submittedAt: new Date().toISOString(), pauseRequested: false });
      state.handle.agent.followup(message);
      for (const input of row.pendingInputs) state.handle.agent.followup(input);
      row.pendingInputs = []; store.save(row);
      await idle; await state.handle.agent.whenIdle?.();
      const log = await query.readSession(row.sessionId); row = store.get(id); settleEvidence(row, log);
    } catch (error) {
      row = store.get(id);
      if (row.submittedAt && row.sessionOwned && !closed && !row.cancelRequested && !executionTerminal(row.phase)) {
        try {
          await state.handle?.agent.whenIdle?.();
          await state.handle?.dispose?.();
          state.handle = null;
          row = store.get(id);
          row.writerReleasedAt = new Date().toISOString();
          store.save(row);
          const log = await query.readSession(row.sessionId);
          row = store.get(id);
          if (!closed && !row.cancelRequested && !executionTerminal(row.phase)) settleEvidence(row, log, { failure: error });
        } catch { /* Keep the original failure when the writer or transcript cannot be verified. */ }
      }
      if (!executionTerminal(row.phase)) {
        if (row.cancelRequested && !closed) {
          try {
            await state.handle?.dispose?.(); state.handle = null; row = store.get(id); row.writerReleasedAt = new Date().toISOString();
            emitPhase(row, 'stopped');
          } catch (stopError) { emitPhase(row, 'uncertain', { error: { code: 'EXECUTION_STOP_UNVERIFIED', message: String(stopError.message || stopError) } }); }
        }
        // Before the write intent nothing reached a model, so the effects of this failure are known: there are none.
        else emitPhase(row, row.submittedAt ? 'uncertain' : 'failed', { error: { code: error.code || 'EXECUTION_FAILED', message: String(error.message || error) },
          ...(row.submittedAt ? {} : { executionEffects: { effectsVerified: true, unknownCallIds: [] } }) });
        store.event(id, 'error', { code: error.code || 'EXECUTION_FAILED', message: String(error.message || error) });
      }
    } finally {
      state.abort.signal.removeEventListener('abort', stop);
      for (const answer of state.questions.values()) answer([]);
      try { await state.handle?.dispose?.(); const latest = store.get(id); latest.writerReleasedAt = new Date().toISOString(); store.save(latest); }
      finally { publishProgress(id); officialProgressOwners.delete(row.sessionId); live.delete(id); }
    }
  };
  const start = (row, resume = false) => {
    const promise = run(row.id, resume).catch(error => { const current = store.get(row.id); if (!executionTerminal(current.phase)) emitPhase(current, 'uncertain', { error: { code: error.code || 'EXECUTION_DISPOSE_FAILED', message: String(error.message || error) } }); });
    if (live.has(row.id)) live.get(row.id).completion = promise;
    jobs.add(promise); void promise.finally(() => jobs.delete(promise));
  };
  const recoverExternal = async (row, cancel) => {
    try {
      const session = commander?.executionSession(row.id);
      if (session && session.id !== row.sessionId)
        throw executionError('EXECUTION_SESSION_CONFLICT', '原生会话身份不匹配');
      if (cancel && !row.submittedAt) {
        if (session && session.status !== 'closed') await commander.disconnect(session.id);
        row.writerReleasedAt = new Date().toISOString();
        delete row.question;
        emitPhase(row, 'stopped');
        return row;
      }
      if (!session || row.nativeStartCursor === undefined) throw executionError('EXECUTION_RECOVERY_UNAVAILABLE', '原生执行记录不可核实');
      if (session.archived && (cancel || row.cancelRequested)) {
        await commander.stopExecution(session.id);
        row.writerReleasedAt = new Date().toISOString();
        delete row.question;
        emitPhase(row, 'stopped');
        return row;
      }
      const events = externalEvents(row);
      const accepted = events.find(event => event.type === 'input.accepted' && event.data?.requestId === (row.nativeResumeRequestId || row.submitRequestId));
      if (accepted && !row.nativeTurnId) row.nativeTurnId = accepted.turnId;
      const evidence = externalEvidence(row, events);
      if (row.nativeTurnId) {
        const progress = nativeExecutionProgress(row.sessionId, store.progress(row.id));
        for (const event of events) if (event.turnId === row.nativeTurnId) progress.observe(event);
        publishProgress(row.id, progress);
      }
      if (evidence.completion && ['idle', 'closed', 'failed', 'disconnected'].includes(session.status)) {
        if (session.status !== 'disconnected' && session.status !== 'closed') await commander.disconnect(session.id);
        row.writerReleasedAt = new Date().toISOString();
        if (cancel || row.cancelRequested) { delete row.question; emitPhase(row, 'stopped'); return row; }
        if (row.pauseRequested && ['completed', 'interrupted', 'cancelled'].includes(evidence.completion.kind)) {
          row.evidence = evidence;
          store.tx(() => { supersedeExternalQuestion(row); emitPhase(row, 'paused'); });
          return row;
        }
        if (accepted) markExternalApplied(row, accepted.turnId);
        if (evidence.completion.kind === 'completed' && evidence.summary && !row.pendingCommands.length) {
          markExternalApplied(row, row.nativeTurnId);
          settleExternal(row, { ...evidence, instructionRevision: row.appliedInstructionRevision });
          return row;
        }
      }
    } catch { /* A missing original native handle cannot establish a terminal state. */ }
    if (row.phase !== 'uncertain') emitPhase(row, 'uncertain', { reason: '原生执行结束边界待核实，保留原身份和回执' });
    return row;
  };
  const recover = (id, cancel = false) => {
    if (recoveries.has(id)) return recoveries.get(id);
    const promise = (async () => {
      let row = store.get(id), handle;
      if (live.has(id)) return row;
      if (row.config.harness !== 'official') return recoverExternal(row, cancel);
      if (!row.sessionOwned) {
        if (cancel && !row.submittedAt) { row.writerReleasedAt = new Date().toISOString(); emitPhase(row, 'stopped'); }
        // Nothing was ever submitted and this execution never owned a session: it provably did not start. Saying so gives
        // the owner a reason and an exit; the existing session is still not taken over and nothing is replayed.
        else if (!row.submittedAt) { row.writerReleasedAt = new Date().toISOString(); emitPhase(row, 'failed', neverStarted('执行端在开始执行前重启或中断，任务没有开始执行')); }
        else if (row.phase !== 'uncertain') emitPhase(row, 'uncertain', { reason: '执行会话归属尚未发布，不接管既有官方会话，也不重放原提交' });
        return row;
      }
      try {
        const persistence = getService(ctx, 'sessionPersistence'), signal = AbortSignal.timeout(5000);
        if (!persistence?.open || agents?.get?.(row.sessionId)) throw executionError('EXECUTION_RECOVERY_UNAVAILABLE', '官方会话写锁不可核实');
        handle = await persistence.open(row.sessionId, 'write', { signal });
        const log = await handle.read(undefined, undefined, { signal });
        await handle.close(); handle = null;
        row = store.get(id); row.writerReleasedAt = new Date().toISOString();
        if (cancel || row.cancelRequested) { row.evidence = remoteExecutionEvidence(log, row); emitPhase(row, 'stopped'); }
        else settleEvidence(row, log, { recovering: row.phase === 'running' || Boolean(row.recoveryError) });
      } catch (error) {
        row = store.get(id);
        // The stop is durable and this execution released its writer: it can never act again, so an
        // unreadable or re-opened session must not keep the accepted stop unconfirmed.
        if ((cancel || row.cancelRequested) && row.writerReleasedAt) emitPhase(row, 'stopped');
        else if (row.phase !== 'uncertain') emitPhase(row, 'uncertain', { reason: '官方会话暂时无法核实；保留原身份，未重放任务', recoveryError: error.code || 'EXECUTION_RECOVERY_UNAVAILABLE' });
      } finally { try { await handle?.close?.(); } catch { /* The original operation remains uncertain; no model was started. */ } }
      return store.get(id);
    })();
    recoveries.set(id, promise); void promise.finally(() => recoveries.delete(id)); return promise;
  };
  // Restarts and subsequent reads inspect the original writer without invoking a model.
  const archivedOfficial = new Set(registry?.archivedSessionIds || []);
  for (const row of store.rows()) {
    if (row.sessionOwned && Boolean(row.sessionArchived) !== Boolean(row.config.harness === 'official'
      ? archivedOfficial.has(row.sessionId) : commander?.executionSession(row.id)?.archived)) {
      recordArchive(row.sessionId, !row.sessionArchived);
    }
    const current = store.get(row.id);
    if ((!executionTerminal(current.phase) && current.phase !== 'paused') || current.phase === 'uncertain') await recover(row.id);
  }
  const offProgress = [
    ctx.on?.('session/event', (session, event) => {
      const rootSessionId = session.header?.origin === 'subagent' ? session.header.parentSession : session.id;
      officialProgressOwners.get(rootSessionId)?.observe(session, event);
    }, { global: true }),
    ctx.on?.('subagent/start', info => {
      officialProgressOwners.get(info.parentSessionId)?.activate(info, agents?.get?.(info.id)?.session);
    }, { global: true }),
    ctx.on?.('subagent/end', info => {
      officialProgressOwners.get(info.parentSessionId)?.settle(info);
    }, { global: true }),
  ];
  const offGate = ctx.on?.('agent/pre-step', ({ agent }, next) => {
    const row = store.bySession(agent.id);
    if (!row?.sessionOwned) return next();
    const instance = live.get(row.id);
    if (instance?.handle?.agent !== agent || executionTerminal(row.phase)) throw executionError('EXECUTION_INPUT_REQUIRES_OWNER', '此会话归远端业务宿主管理，请在原工单提交输入', 403);
    return next();
  }, { prepend: true, global: true });
  const offArchive = ctx.on?.('domain/changed', change => {
    if (change.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return;
    const previous = new Set(registry?.archivedSessionIds || []), current = new Set(change.value?.archivedSessionIds || []);
    for (const id of current) if (!previous.has(id)) recordArchive(id);
    for (const id of previous) if (!current.has(id)) recordArchive(id, false);
  }, { global: true });
  const nativeArchive = ({ sessionId, archived }) => recordArchive(sessionId, archived);
  commander?.on?.('session/archive', nativeArchive);
  return {
    ownerOfSession(sessionId) { const row = store.bySession(sessionId); return row?.sessionOwned ? { ...row.identity, executionId: row.id, sessionId, promptable: false } : null; },
    async revokePrincipal(principal) {
      if (closed) return;
      const pending = [];
      for (const row of store.rows()) if (row.principal === principal && (!executionTerminal(row.phase) || row.phase === 'uncertain')) {
        row.cancelRequested = true; store.save(row); store.event(row.id, 'control', { control: 'cancel', state: 'accepted', reason: 'authorization-revoked' });
        const instance = live.get(row.id);
        if (instance) { instance.abort.abort(executionError('EXECUTION_AUTHORIZATION_REVOKED', '执行设备配对授权已撤销')); if (instance.completion) pending.push(instance.completion); }
        else if (row.phase === 'uncertain') pending.push(recover(row.id, true));
        else emitPhase(row, 'stopped');
      }
      await Promise.allSettled(pending);
    },
    async dispatch(input, { principal, signal, hostId, verifiedSourceHostId } = {}) {
      if (closed) throw executionError('EXECUTION_SERVICE_CLOSED', '远端执行服务已关闭', 503);
      signal?.throwIfAborted();
      const subject = required(principal?.kind === 'device' ? principal.deviceId : null, '认证设备');
      if (input?.action !== 'execution' || input.version !== REMOTE_EXECUTION_VERSION || !REMOTE_EXECUTION_OPERATIONS.includes(input.operation)) throw executionError('UNSUPPORTED_EXECUTION_PROTOCOL', '不支持的执行协议版本或操作', 422);
      if (JSON.stringify(input).length > 1_000_000) throw executionError('EXECUTION_PAYLOAD_TOO_LARGE', '执行请求过大', 413);
      if (input.operation === 'catalog') {
        const models = await modelCatalog();
        const worker = await workerPreference(models, signal);
        return { version: REMOTE_EXECUTION_VERSION, available: !!(commander?.pickerCatalog && agents?.create && agents?.resume && query?.readSession && llm?.resolveModelInfo),
          pluginVersion: plugin.version, models, projects: projects(), ...(models.some(row => row.harness !== 'official') ? { nativeContinuation: true } : {}),
          ...(worker ? { workerPreference: worker } : {}) };
      }
      if (input.operation === 'archives') {
        const after = input.after ?? 0, limit = input.limit ?? 100;
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw executionError('INVALID_EXECUTION_CURSOR', '归档游标无效', 400);
        return { version: REMOTE_EXECUTION_VERSION, archives: store.sessionArchives(subject, after, limit) };
      }
      if (input.operation === 'submit') {
        required(input.requestId, '请求 ID', 200); required(input.executionId, '执行 ID', 200); required(input.sessionId, '会话 ID'); required(input.text, '执行文本', 100000);
        for (const key of ['ownerHostId', 'taskId', 'assignmentId', 'runId']) required(input.identity?.[key], key);
        revision(input.identity.fence); revision(input.requirements?.instructionRevision);
        if (!input.requirements?.mandate || typeof input.requirements.mandate !== 'object') throw executionError('INVALID_EXECUTION_REQUEST', '必须携带冻结授权快照', 400);
        if (hostId && input.requirements.mandate.execution?.hostId !== hostId) throw executionError('EXECUTION_HOST_CHANGED', '冻结授权的目标设备身份不一致', 403);
        const frozenConfig = input.requirements.mandate.execution?.config;
        if (frozenConfig && executionFingerprint(frozenConfig) !== executionFingerprint(input.config))
          throw executionError('EXECUTION_CONFIG_CHANGED', '执行选择与工单冻结的组合不一致', 422);
        const replay = () => {
          const prior = store.receipt(subject, input.requestId, input);
          if (!prior) return;
          const row = store.owned(prior.executionId, subject);
          if (verifiedSourceHostId) store.tx(() => store.bindOwner(subject, row.identity.ownerHostId, verifiedSourceHostId));
          return response(row, input);
        };
        const prior = replay(); if (prior) return prior;
        const checked = await checkConfig(input); signal?.throwIfAborted();
        try { await assertSessionAbsent(input.sessionId); }
        catch (error) { const duplicate = replay(); if (duplicate) return duplicate; throw error; }
        const repeated = replay(); if (repeated) return repeated;
        if (live.size >= maxConcurrent) throw executionError('EXECUTION_CAPACITY', '执行并发已满，请稍后重试', 429);
        const executionDirectory = join(directory, 'work', createHash('sha256').update(input.executionId).digest('hex'));
        const row = store.tx(() => store.create(subject, input, { project: checked.project, binding: checked.binding,
          directory: executionDirectory, workingDirectory: checked.project?.path || executionDirectory }, verifiedSourceHostId));
        start(row); return response(store.get(row.id), input);
      }
      let id = input.executionId;
      if (!id && input.operation === 'get' && input.requestId) id = store.receipt(subject, input.requestId, undefined)?.executionId;
      let row = store.owned(required(id, '执行 ID'), subject);
      if (input.identity && executionFingerprint(row.identity) !== executionFingerprint(input.identity)) throw executionError('EXECUTION_IDENTITY_CHANGED', '执行身份不一致', 403);
      if (input.operation === 'archive') {
        if (!input.identity || input.sessionId !== row.sessionId || !row.sessionOwned) throw executionError('EXECUTION_IDENTITY_CHANGED', '会话归属无法核验', 409);
        required(input.requestId, '请求 ID');
        if (store.receipt(subject, input.requestId, input)) return response(row, input);
        store.assertFence(row);
        revision(input.instructionRevision);
        if (input.instructionRevision !== row.receivedInstructionRevision) throw executionError('EXECUTION_REVISION_CONFLICT', '工单要求已变更，请重新确认归档', 409);
        if (row.config.harness === 'official') await registry.archiveSession(row.sessionId, { stopActivity: true });
        else await commander.archive(row.sessionId, true, { stopActivity: true });
        recordArchive(row.sessionId);
        row = store.get(id);
        if (!store.receipt(subject, input.requestId, input)) {
          if (!row.sessionArchived || row.sessionArchiveInstructionRevision !== input.instructionRevision)
            throw executionError('EXECUTION_REVISION_CONFLICT', '会话的归档记录与当前工单要求版本不一致', 409);
          store.recordCommand(subject, input, id, { instructionRevision: row.sessionArchiveInstructionRevision, sessionArchiveCursor: row.sessionArchiveCursor });
        }
        return response(row, input);
      }
      if (input.operation === 'get') { if (row.phase === 'uncertain') row = await recover(id); return response(store.get(id), input); }
      store.assertFence(row);
      if (input.operation === 'ack') {
        if (!Number.isSafeInteger(input.through) || input.through < row.ackThrough || input.through > store.latest(id)) throw executionError('INVALID_EXECUTION_ACK', '事件确认水位无效', 400);
        row.ackThrough = input.through; store.save(row); return response(row, input);
      }
      required(input.requestId, '请求 ID');
      const prior = store.receipt(subject, input.requestId, input); if (prior) return { ...response(row, input), receipt: prior };
      if (input.operation === 'control') {
        if (!['pause', 'resume', 'cancel'].includes(input.control)) throw executionError('INVALID_EXECUTION_CONTROL', '不支持的执行控制', 422);
        if (input.control === 'resume') {
          if (row.phase !== 'paused' || live.has(id)) throw executionError('EXECUTION_NOT_PAUSED', '执行实例尚未处于可恢复的暂停边界');
          if (live.size >= maxConcurrent) throw executionError('EXECUTION_CAPACITY', '执行并发已满', 429);
          store.tx(() => {
            row.pauseRequested = false;
            row.cancelRequested = false;
            if (row.config.harness !== 'official') row.nativeResumeRequestId = input.requestId;
            store.save(row);
            store.recordCommand(subject, input, id, { accepted: true });
            store.event(id, 'control', { control: input.control, state: 'accepted' });
          });
          start(row, true);
        } else {
          if (executionTerminal(row.phase) && !(row.phase === 'uncertain' && input.control === 'cancel')) throw executionError('EXECUTION_INACTIVE', '执行已结束，不能再次控制');
          store.tx(() => { row[input.control === 'pause' ? 'pauseRequested' : 'cancelRequested'] = true; store.save(row); store.recordCommand(subject, input, id, { accepted: true }); store.event(id, 'control', { control: input.control, state: 'accepted' }); });
          if (input.control === 'cancel') { if (live.has(id)) live.get(id).abort.abort(executionError('EXECUTION_CANCELLED', '业务宿主取消执行')); else if (row.phase === 'uncertain') await recover(id, true); else emitPhase(row, 'stopped'); }
        }
        return response(store.get(id), input);
      }
      active(row);
      if (!['revision', 'context', 'answer'].includes(input.kind)) throw executionError('INVALID_EXECUTION_INPUT', '不支持的执行输入类型', 422);
      required(input.text, '输入文本', 100000); revision(input.instructionRevision);
      if (input.kind === 'revision' ? input.instructionRevision <= row.receivedInstructionRevision
        : input.kind === 'context' ? input.instructionRevision > row.receivedInstructionRevision : input.instructionRevision !== row.receivedInstructionRevision) throw executionError('EXECUTION_REVISION_CONFLICT', '输入要求版本不匹配');
      if (input.kind === 'revision' && row.receivedInstructionRevision !== row.appliedInstructionRevision) throw executionError('EXECUTION_REVISION_PENDING', '上一要求版本尚未到达官方应用边界，请保留请求 ID 稍后重试');
      const instance = live.get(id);
      if (input.kind === 'answer') {
        if (!row.question || row.question.questionId !== input.questionId || !instance?.questions.has(input.questionId)) throw executionError('EXECUTION_QUESTION_EXPIRED', '执行问题已失效或需要核实');
        const expected = row.question.questions;
        if (!Array.isArray(input.answers) || input.answers.length !== expected.length || new Set(input.answers.map(answer => answer?.id)).size !== expected.length
          || input.answers.some(answer => !expected.some(question => question.id === answer?.id) || !Array.isArray(answer.selected) || answer.selected.some(value => typeof value !== 'string')
            || typeof answer.custom !== 'string' || answer.custom.length > 100000)) throw executionError('INVALID_EXECUTION_ANSWER', '答复必须逐一对应当前问题的真实 ID', 422);
        const answers = structuredClone(input.answers);
        const receipt = { requestId: input.requestId, accepted: true, state: 'applied', instructionRevision: row.appliedInstructionRevision, kind: 'answer', questionId: input.questionId };
        store.tx(() => { delete row.question; emitPhase(row, 'running'); store.recordCommand(subject, input, id, receipt); store.event(id, 'instruction.applied', receipt); });
        instance.questions.get(input.questionId)(answers); instance.questions.delete(input.questionId);
      } else {
        if (input.kind === 'revision' && (!input.requirements?.mandate || input.requirements.instructionRevision !== input.instructionRevision)) throw executionError('INVALID_EXECUTION_INPUT', '修订必须携带完整冻结授权及相同要求版本', 422);
        if (input.kind === 'revision') {
          const { project, execution } = input.requirements.mandate;
          if (row.project ? !project || project.id !== row.project.id || project.path !== row.project.path : project != null) throw executionError('EXECUTION_PROJECT_CHANGED', '同一执行不能通过修订改变冻结工作区', 422);
          if (hostId && execution?.hostId !== hostId) throw executionError('EXECUTION_HOST_CHANGED', '修订目标设备身份不一致', 403);
          if (execution?.config && executionFingerprint(execution.config) !== executionFingerprint(row.config)) throw executionError('EXECUTION_CONFIG_CHANGED', '同一执行不能通过修订改变冻结模型', 422);
        }
        if (row.config.harness !== 'official') {
          if (!row.appliedInstructionRevision) throw executionError('EXECUTION_REVISION_PENDING', '原生会话尚未确认初始要求，请保留请求 ID 稍后重试');
          store.tx(() => {
            if (input.kind === 'revision') { row.requirements = structuredClone(input.requirements); row.receivedInstructionRevision = input.instructionRevision; }
            row.pendingCommands.push({ requestId: input.requestId, kind: input.kind, ...(input.kind === 'context' ? { text: input.text } : {}) });
            store.save(row);
            store.recordCommand(subject, input, id, { requestId: input.requestId, accepted: true, state: 'received', instructionRevision: null, receivedInstructionRevision: input.instructionRevision });
            store.event(id, 'instruction.received', { requestId: input.requestId, instructionRevision: input.instructionRevision, kind: input.kind });
          });
          return response(store.get(id), input);
        }
        let message;
        store.tx(() => {
          if (input.kind === 'revision') { row.requirements = structuredClone(input.requirements); row.receivedInstructionRevision = input.instructionRevision; }
          row.pendingCommands.push({ requestId: input.requestId, kind: input.kind });
          message = persistMessage(row, input.kind === 'revision' ? 'The owner replaced the complete authorized requirement snapshot. Apply it at the next safe boundary in this same execution; do not replay completed work.\n' + JSON.stringify(row.requirements) : 'Additional owner context, not a new authorization.\n' + input.text, { instructionRevision: input.instructionRevision, requestId: input.requestId });
          if (!instance?.handle) row.pendingInputs.push(message);
          store.save(row); store.recordCommand(subject, input, id, { requestId: input.requestId, accepted: true, state: 'received', instructionRevision: null, receivedInstructionRevision: input.instructionRevision }); store.event(id, 'instruction.received', { requestId: input.requestId, instructionRevision: input.instructionRevision, kind: input.kind });
        });
        // Queue steering before releasing a question so the next step sees the new requirement.
        instance?.handle?.agent.steer(message);
        if (input.kind === 'revision' && row.question) {
          const questionId = row.question.questionId;
          store.tx(() => { delete row.question; emitPhase(row, 'running'); store.event(id, 'question.superseded', { questionId, instructionRevision: input.instructionRevision }); });
          instance?.questions.get(questionId)?.reject(executionError('EXECUTION_QUESTION_SUPERSEDED', '业务宿主已修订完整要求，请按新快照重新判断，旧问题已撤销'));
          instance?.questions.delete(questionId);
        }
      }
      return response(store.get(id), input);
    },
    async close() {
      if (closed) return; closed = true; offGate?.(); offArchive?.(); commander?.off?.('session/archive', nativeArchive);
      for (const dispose of offProgress) dispose?.();
      for (const instance of live.values()) instance.abort.abort(executionError('EXECUTION_HOST_STOPPED', '执行宿主关闭'));
      await Promise.allSettled([...jobs, ...recoveries.values()]); store.close();
    },
  };
}
