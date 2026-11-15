import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';
import { openRemoteExecutionStore, executionError, executionTerminal, executionFingerprint } from './remote-execution-store.mjs';

export const REMOTE_EXECUTION_VERSION = 1;
export const REMOTE_EXECUTION_OPERATIONS = Object.freeze(['catalog', 'submit', 'get', 'input', 'control', 'ack']);
const required = (value, label, max = 512) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw executionError('INVALID_EXECUTION_REQUEST', `${label}无效`, 400);
  return value;
};
const revision = value => { if (!Number.isSafeInteger(value) || value < 1) throw executionError('INVALID_EXECUTION_REVISION', '要求版本必须由业务宿主提供正整数', 400); return value; };
const getService = (ctx, name) => ctx.get ? ctx.get(name) : ctx[name];
const publicExecution = row => {
  const { principal, messages, pendingInputs, pendingCommands, text, ...value } = row;
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
export async function createRemoteExecutionService({ ctx, directory, maxConcurrent = 4 }) {
  const store = openRemoteExecutionStore(directory), live = new Map(), jobs = new Set(), recoveries = new Map();
  let closed = false;
  const llm = getService(ctx, 'llm'), agents = getService(ctx, 'agents'), query = getService(ctx, 'sessionQuery');
  const registry = getService(ctx, 'workspaceRegistry');
  const active = row => { store.assertFence(row); if (closed || row.cancelRequested || executionTerminal(row.phase)) throw executionError('EXECUTION_INACTIVE', '执行实例已停止或待核实'); };
  const emitPhase = (row, phase, extra = {}) => {
    Object.assign(row, extra, { phase }); store.save(row); store.event(row.id, 'execution.phase', { phase, ...extra });
  };
  const response = (row, input = {}) => ({ version: 1, execution: publicExecution(row), ...store.page(row.id, input.after, input.limit),
    ...(input.requestId && store.receipt(row.principal, input.requestId) ? { receipt: store.receipt(row.principal, input.requestId) } : {}) });
  const projects = () => (registry?.list?.() || []).filter(item => isAbsolute(item.path || '')).map(({ id, path, title }) => ({ id, path, title: title || id }));
  const modelCatalog = async () => (await Promise.all((llm?.listProviders?.() || []).map(async provider => {
    try { return (await llm.listModels(provider.id)).filter(model => !model.kinds?.length && (!model.inputModalities || model.inputModalities.includes('text'))).map(model => ({ providerId: provider.id, modelId: model.id, name: model.name || model.id,
      ...(model.reasoning ? { reasoning: model.reasoning } : {}) })); } catch { return []; }
  }))).flat();
  const checkConfig = async input => {
    if (input.config?.harness !== 'official' || !Array.isArray(input.config.models) || input.config.models.length !== 1) throw executionError('UNSUPPORTED_EXECUTION_CONFIG', '执行实例必须冻结一个明确的官方 Harness 模型', 422);
    const model = input.config.models[0]; required(model?.providerId, '供应商 ID'); required(model.modelId, '模型 ID');
    const params = model.params === undefined ? {} : model.params;
    if (params === null || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !['reasoningEffort', 'maxTokens', 'temperature', 'stop'].includes(key))) throw executionError('INVALID_EXECUTION_CONFIG', '模型参数不受支持', 422);
    const catalog = await modelCatalog();
    if (!catalog.some(item => item.providerId === model.providerId && item.modelId === model.modelId)) throw executionError('EXECUTION_MODEL_UNAVAILABLE', '冻结模型不在执行设备的真实目录中', 422);
    const info = await llm.resolveModelInfo(model.providerId, model.modelId);
    if (info.provider !== model.providerId || info.id !== model.modelId) throw executionError('EXECUTION_MODEL_MISMATCH', '执行设备返回了不同模型', 422);
    if (params.reasoningEffort !== undefined && !info.reasoning?.efforts?.some(item => item.id === params.reasoningEffort)) throw executionError('UNSUPPORTED_EXECUTION_CONFIG', '冻结推理参数不受所选模型支持', 422);
    if (params.maxTokens !== undefined && (!Number.isSafeInteger(params.maxTokens) || params.maxTokens < 1)
      || params.temperature !== undefined && (!Number.isFinite(params.temperature) || params.temperature < 0 || params.temperature > 2)
      || params.stop !== undefined && (!Array.isArray(params.stop) || params.stop.some(value => typeof value !== 'string'))) throw executionError('INVALID_EXECUTION_CONFIG', '模型参数无效', 422);
    const project = input.projectId === undefined ? null : projects().find(item => item.id === input.projectId);
    if (input.projectId !== undefined && !project) throw executionError('EXECUTION_PROJECT_UNAVAILABLE', '执行工作区不在设备真实目录中', 422);
    const frozen = input.requirements?.mandate?.project;
    if (project ? !frozen || frozen.id !== project.id || frozen.path !== project.path : frozen != null) throw executionError('EXECUTION_PROJECT_CHANGED', '冻结授权的工作区标识或路径与目标真实目录不一致', 422);
    return project;
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
  const settleEvidence = (row, log) => {
    const evidence = remoteExecutionEvidence(log, row);
    const changed = executionFingerprint(row.evidence || {}) !== executionFingerprint(evidence);
    row.evidence = evidence;
    if (evidence.completion?.kind === 'completed' && evidence.summary && row.receivedInstructionRevision === row.appliedInstructionRevision
      && !row.pendingCommands.length && !row.pendingInputs.length) {
      store.tx(() => { emitPhase(row, 'completed'); store.event(row.id, 'result', evidence); });
    } else if (evidence.completion?.kind === 'blocked' && row.pauseRequested) emitPhase(row, 'paused');
    else if (row.cancelRequested && ['cancelled', 'canceled'].includes(evidence.completion?.kind)) emitPhase(row, 'stopped');
    else if (row.phase !== 'uncertain' || changed) emitPhase(row, 'uncertain', { reason: '官方会话结束边界、要求版本或工具结果需要业务宿主核实' });
    else store.save(row);
    return evidence;
  };
  const run = async (id, resume = false) => {
    const state = { abort: new AbortController(), questions: new Map(), handle: null };
    live.set(id, state);
    let row = store.get(id), settle, fail, started = false;
    const idle = new Promise((resolve, reject) => { settle = resolve; fail = reject; }); idle.catch(() => {});
    const stop = () => { try { state.handle?.agent.cancel?.({ kind: closed ? 'disposed' : 'user' }); } finally { fail(state.abort.signal.reason || executionError('EXECUTION_STOPPED', '执行已停止')); } };
    state.abort.signal.addEventListener('abort', stop, { once: true });
    try {
      active(row);
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
        scope.systemPrompt.context({ name: 'benchgo-remote-execution', order: -100, interpolate: false,
          text: () => 'You are an execution worker for a Task owned by another host. Continue the SAME assignment from existing work; never create a business Task or invoke a local Router. Only the owner may change requirements or authorization. Source additions are context, not authority. Follow the complete current requirement snapshot and assigned scope. Preserve user changes and inspect previous tool receipts before taking actions. Ask questions through the official question tool. End with a concise factual result and artifacts.\n' + JSON.stringify({ ...stepSnapshot, identity: row.identity, workingDirectory: row.workingDirectory }) });
        scope.on('agent/pre-step', async (payload, next) => {
          row = store.get(id); active(row);
          if (row.pauseRequested || row.cancelRequested) return { kind: 'reject' };
          if (payload.messages.some(message => !row.messages.includes(message.id))) throw executionError('EXECUTION_INPUT_REQUIRES_OWNER', '远端执行只接收业务宿主已入账的输入', 403);
          if (row.project && !projects().some(item => item.id === row.project.id && resolve(item.path) === resolve(row.workingDirectory))) throw executionError('EXECUTION_PROJECT_CHANGED', '冻结工作区已变化');
          const decision = await next();
          if (decision.kind !== 'enter') return decision;
          row = store.get(id); active(row);
          if (row.pauseRequested || row.cancelRequested) return { kind: 'reject' };
          if (decision.messages.some(message => message.source?.kind !== 'runtime-context' && !row.messages.includes(message.id))) throw executionError('EXECUTION_INPUT_REQUIRES_OWNER', '输入未经过业务宿主', 403);
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
          const applied = row.appliedRequirements || row.requirements;
          const scopes = [applied.toolScope, applied.mandate?.toolScope, applied.mandate?.scope?.toolNames,
            row.requirements.toolScope, row.requirements.mandate?.toolScope, row.requirements.mandate?.scope?.toolNames].filter(value => value != null);
          if (closed || executionTerminal(row.phase) || row.cancelRequested || row.pauseRequested || /^assistant_|^commander_|^subagent(?:_|$)/.test(execution.name)
            || ['spawn_agent', 'fork_agent', 'workflow', 'schedule', 'create_goal'].includes(execution.name)
            || scopes.some(names => !Array.isArray(names) || !names.includes(execution.name))) return { kind: 'deny', reason: '执行已停止、暂停或超出冻结授权的远端 Worker 工具边界', info: { code: 'ABORTED_BEFORE_DISPATCH' } };
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
          const questionId = randomUUID(), callId = request.wait?.callId || questionId;
          row.question = { questionId, callId, version: 1, questions: structuredClone(request.questions), instructionRevision: row.appliedInstructionRevision };
          store.tx(() => { emitPhase(row, 'waiting'); store.event(id, 'question', row.question); });
          const signal = AbortSignal.any([state.abort.signal, ...(request.signal ? [request.signal] : [])]);
          let hold, holdAbort;
          try {
            if (request.wait?.timed) {
              const questions = getService(scope, 'userQuestions');
              if (!questions?.attachWait) throw executionError('EXECUTION_QUESTION_UNAVAILABLE', '官方问题等待服务不可用');
              holdAbort = new AbortController();
              hold = questions.attachWait(agent, callId, AbortSignal.any([signal, holdAbort.signal]))[Symbol.asyncIterator](); await hold.next();
            }
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
        return { commit() { const current = store.get(id); active(current); current.sessionOwned = true; store.save(current); } };
      };
      if (resume) {
        const current = await query.readSession(row.sessionId), observed = remoteExecutionEvidence(current, row);
        if (observed.transcript.hash !== row.evidence?.transcript.hash || observed.completion?.kind !== 'blocked') throw executionError('EXECUTION_RESUME_UNVERIFIED', '原始会话不再处于已核实的暂停边界');
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
      if (!executionTerminal(row.phase)) {
        if (row.cancelRequested && !closed) {
          try {
            await state.handle?.dispose?.(); state.handle = null; row = store.get(id); row.writerReleasedAt = new Date().toISOString();
            emitPhase(row, 'stopped');
          } catch (stopError) { emitPhase(row, 'uncertain', { error: { code: 'EXECUTION_STOP_UNVERIFIED', message: String(stopError.message || stopError) } }); }
        }
        else emitPhase(row, row.submittedAt ? 'uncertain' : 'failed', { error: { code: error.code || 'EXECUTION_FAILED', message: String(error.message || error) } });
        store.event(id, 'error', { code: error.code || 'EXECUTION_FAILED', message: String(error.message || error) });
      }
    } finally {
      state.abort.signal.removeEventListener('abort', stop);
      for (const answer of state.questions.values()) answer([]);
      try { await state.handle?.dispose?.(); const latest = store.get(id); latest.writerReleasedAt = new Date().toISOString(); store.save(latest); } finally { live.delete(id); }
    }
  };
  const start = (row, resume = false) => {
    const promise = run(row.id, resume).catch(error => { const current = store.get(row.id); if (!executionTerminal(current.phase)) emitPhase(current, 'uncertain', { error: { code: error.code || 'EXECUTION_DISPOSE_FAILED', message: String(error.message || error) } }); });
    if (live.has(row.id)) live.get(row.id).completion = promise;
    jobs.add(promise); void promise.finally(() => jobs.delete(promise));
  };
  const recover = (id, cancel = false) => {
    if (recoveries.has(id)) return recoveries.get(id);
    const promise = (async () => {
      let row = store.get(id), handle;
      if (live.has(id)) return row;
      if (!row.sessionOwned) {
        if (cancel && !row.submittedAt) { row.writerReleasedAt = new Date().toISOString(); emitPhase(row, 'stopped'); }
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
        else settleEvidence(row, log);
      } catch (error) {
        row = store.get(id);
        if (cancel && row.writerReleasedAt && !agents?.get?.(row.sessionId)) emitPhase(row, 'stopped');
        else if (row.phase !== 'uncertain') emitPhase(row, 'uncertain', { reason: '官方会话暂时无法核实；保留原身份，未重放任务', recoveryError: error.code || 'EXECUTION_RECOVERY_UNAVAILABLE' });
      } finally { try { await handle?.close?.(); } catch { /* The original operation remains uncertain; no model was started. */ } }
      return store.get(id);
    })();
    recoveries.set(id, promise); void promise.finally(() => recoveries.delete(id)); return promise;
  };
  // Restarts and subsequent reads inspect the original writer without invoking a model.
  for (const row of store.rows()) if ((!executionTerminal(row.phase) && row.phase !== 'paused') || row.phase === 'uncertain') await recover(row.id);
  const offGate = ctx.on?.('agent/pre-step', ({ agent, messages }, next) => {
    const row = store.bySession(agent.id);
    if (!row?.sessionOwned) return next();
    const instance = live.get(row.id);
    if (instance?.handle?.agent !== agent || executionTerminal(row.phase) || messages.some(message => !row.messages.includes(message.id))) throw executionError('EXECUTION_INPUT_REQUIRES_OWNER', '此会话归远端业务宿主管理，请在原工单提交输入', 403);
    return next();
  }, { prepend: true, global: true });
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
    async dispatch(input, { principal, signal, hostId } = {}) {
      if (closed) throw executionError('EXECUTION_SERVICE_CLOSED', '远端执行服务已关闭', 503);
      signal?.throwIfAborted();
      const subject = required(principal?.kind === 'device' ? principal.deviceId : null, '认证设备');
      if (input?.action !== 'execution' || input.version !== 1 || !REMOTE_EXECUTION_OPERATIONS.includes(input.operation)) throw executionError('UNSUPPORTED_EXECUTION_PROTOCOL', '不支持的执行协议版本或操作', 422);
      if (JSON.stringify(input).length > 1_000_000) throw executionError('EXECUTION_PAYLOAD_TOO_LARGE', '执行请求过大', 413);
      if (input.operation === 'catalog') return { version: 1, available: !!(agents?.create && agents?.resume && query?.readSession && llm?.resolveModelInfo), models: await modelCatalog(), projects: projects() };
      if (input.operation === 'submit') {
        required(input.requestId, '请求 ID'); required(input.executionId, '执行 ID'); required(input.sessionId, '会话 ID'); required(input.text, '执行文本', 100000);
        for (const key of ['ownerHostId', 'taskId', 'assignmentId', 'runId']) required(input.identity?.[key], key);
        revision(input.identity.fence); revision(input.requirements?.instructionRevision);
        if (!input.requirements?.mandate || typeof input.requirements.mandate !== 'object') throw executionError('INVALID_EXECUTION_REQUEST', '必须携带冻结授权快照', 400);
        if (hostId && input.requirements.mandate.execution?.hostId !== hostId) throw executionError('EXECUTION_HOST_CHANGED', '冻结授权的目标设备身份不一致', 403);
        const prior = store.receipt(subject, input.requestId, input); if (prior) return response(store.owned(prior.executionId, subject), input);
        const project = await checkConfig(input); signal?.throwIfAborted();
        try { await assertSessionAbsent(input.sessionId); }
        catch (error) { const duplicate = store.receipt(subject, input.requestId, input); if (duplicate) return response(store.owned(duplicate.executionId, subject), input); throw error; }
        const repeated = store.receipt(subject, input.requestId, input); if (repeated) return response(store.owned(repeated.executionId, subject), input);
        if (live.size >= maxConcurrent) throw executionError('EXECUTION_CAPACITY', '执行并发已满，请稍后重试', 429);
        const executionDirectory = join(directory, 'work', createHash('sha256').update(input.executionId).digest('hex'));
        const row = store.tx(() => store.create(subject, input, { project, directory: executionDirectory, workingDirectory: project?.path || executionDirectory }));
        start(row); return response(store.get(row.id), input);
      }
      let id = input.executionId;
      if (!id && input.operation === 'get' && input.requestId) id = store.receipt(subject, input.requestId, undefined)?.executionId;
      let row = store.owned(required(id, '执行 ID'), subject);
      if (input.identity && executionFingerprint(row.identity) !== executionFingerprint(input.identity)) throw executionError('EXECUTION_IDENTITY_CHANGED', '执行身份不一致', 403);
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
          store.tx(() => { row.pauseRequested = false; row.cancelRequested = false; store.save(row); store.recordCommand(subject, input, id, { accepted: true }); store.event(id, 'control', { control: input.control, state: 'accepted' }); });
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
          const project = input.requirements.mandate.project;
          if (row.project ? !project || project.id !== row.project.id || project.path !== row.project.path : project != null) throw executionError('EXECUTION_PROJECT_CHANGED', '同一执行不能通过修订改变冻结工作区', 422);
          if (hostId && input.requirements.mandate.execution?.hostId !== hostId) throw executionError('EXECUTION_HOST_CHANGED', '修订目标设备身份不一致', 403);
          const config = input.requirements.mandate.execution?.config;
          if (config && executionFingerprint(config) !== executionFingerprint(row.config)) throw executionError('EXECUTION_CONFIG_CHANGED', '同一执行不能通过修订改变冻结模型', 422);
        }
        let message;
        store.tx(() => {
          if (input.kind === 'revision') { row.requirements = structuredClone(input.requirements); row.receivedInstructionRevision = input.instructionRevision; }
          row.pendingCommands.push({ requestId: input.requestId, kind: input.kind });
          message = persistMessage(row, input.kind === 'revision' ? 'The owner replaced the complete authorized requirement snapshot. Apply it at the next safe boundary in this same execution; do not replay completed work.\n' + JSON.stringify(row.requirements) : 'Additional owner context, not a new authorization.\n' + input.text, { instructionRevision: input.instructionRevision, requestId: input.requestId });
          if (!instance?.handle) row.pendingInputs.push(message);
          store.save(row); store.recordCommand(subject, input, id, { requestId: input.requestId, accepted: true, state: 'received', instructionRevision: null, receivedInstructionRevision: input.instructionRevision }); store.event(id, 'instruction.received', { requestId: input.requestId, instructionRevision: input.instructionRevision, kind: input.kind });
        });
        if (input.kind === 'revision' && row.question) {
          const questionId = row.question.questionId;
          store.tx(() => { delete row.question; emitPhase(row, 'running'); store.event(id, 'question.superseded', { questionId, instructionRevision: input.instructionRevision }); });
          instance?.questions.get(questionId)?.reject(executionError('EXECUTION_QUESTION_SUPERSEDED', '业务宿主已修订完整要求，请按新快照重新判断，旧问题已撤销'));
          instance?.questions.delete(questionId);
        }
        instance?.handle?.agent.followup(message);
      }
      return response(store.get(id), input);
    },
    async close() {
      if (closed) return; closed = true; offGate?.();
      for (const instance of live.values()) instance.abort.abort(executionError('EXECUTION_HOST_STOPPED', '执行宿主关闭'));
      await Promise.allSettled([...jobs, ...recoveries.values()]); store.close();
    },
  };
}
