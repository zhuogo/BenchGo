import { createHash } from 'node:crypto';
import { currentHumanInstruction } from './desktop-delegation-service.mjs';
import { readAssessmentPolicy, validateTaskMandate } from './assessment-policy.mjs';
import { configuredWorkModel, rejectModelOverride } from './work-role-policy.mjs';
import { assertSpecificTaskDescription, normalizeTaskTitle } from './task-title.mjs';
import { taskStopped } from './task-lifecycle.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const required = (value, label, max = 100000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`无效${label}`);
  return value;
};
const fail = (code, message) => Object.assign(new Error(message), { code, status: 403 });

/** Authenticated device requests are distinct from local owner authority. */
export function collaborationPrincipal(peer) {
  const principal = peer?.principal;
  if (principal?.kind !== 'device' || typeof principal.deviceId !== 'string' || !principal.deviceId
    || !Array.isArray(principal.capabilities) || !principal.capabilities.includes('collaboration'))
    throw fail('COLLABORATION_DENIED', '设备未获协作授权');
  return principal;
}

/** One target Task, using the target's configured model, workspace and execution chain. */
export function createDeviceCollaboration({ ctx, store, runtimeStore, signal: lifecycle, onUpdate,
  readPolicy = () => readAssessmentPolicy(store, ctx.workspaceRegistry), now = Date.now }) {
  const database = store.orchestration;
  const pending = new Map();
  let observing;
  const references = () => runtimeStore?.meta('remote-executions') || [];
  const saveReference = row => {
    const rows = references(), index = rows.findIndex(item => item.requestId === row.requestId);
    if (index >= 0) rows[index] = row; else {
      if (rows.length >= 128) {
        const completed = rows.findIndex(item => ['completed', 'rejected', 'unverified'].includes(item.state));
        if (completed < 0) throw new Error('远端活动任务引用已达上限，请先完成或核实已有任务');
        rows.splice(completed, 1);
      }
      rows.push(row);
    }
    runtimeStore?.setMeta('remote-executions', rows);
  };
  const link = () => {
    const service = ctx.get?.('benchgoLink');
    if (!service) throw Object.assign(new Error('Link 服务不可用'), { code: 'LINK_UNAVAILABLE' });
    return service;
  };
  function origin(input, principal) {
    const value = input.origin || {};
    return { channel: 'link', deviceId: principal.deviceId,
      sessionId: required(value.sessionId, '来源会话', 512), threadId: required(value.threadId, '来源对话', 512),
      messageId: required(value.messageId, '来源消息', 512) };
  }
  function owned(taskId, source) {
    const task = database.getTask(required(taskId, '任务标识', 512));
    const actual = task?.mandate.source;
    if (!task || actual?.channel !== 'link' || ['deviceId', 'sessionId', 'threadId'].some(key => actual[key] !== source[key]))
      throw fail('TASK_SOURCE_DENIED', '任务不属于此设备与原对话');
    return task;
  }
  const projection = task => ({ task: { id: task.id, title: task.title, status: task.status,
    target: task.target, acceptance: task.acceptance, instructionRevision: task.instructionRevision,
    executionControl: task.executionControl, continuationWait: task.continuationWait,
    liveSummary: task.liveSummary, resultVersion: task.resultVersion, project: task.mandate.project,
    createdAt: task.createdAt, updatedAt: task.updatedAt },
    executionId: database.assignments(task.id).at(-1)?.id ?? null,
    results: database.results(task.id), attentions: database.attentions(task.id),
    inputs: database.taskInputs(task.id).slice(-20) });
  async function receive(input, peer, { signal } = {}) {
    const principal = collaborationPrincipal(peer);
    signal = AbortSignal.any([signal, lifecycle].filter(Boolean));
    input = structuredClone(input);
    signal.throwIfAborted();
    const source = origin(input, principal);
    if (input.operation === 'get') return projection(owned(input.taskId, source));
    if (input.operation === 'lookup') {
      const prior = database.desktopRequest(`link:${digest([principal.deviceId, required(input.requestId, '稳定请求标识', 200)])}`);
      return prior ? projection(owned(prior.task.id, source)) : { available: false, code: 'ACCEPTANCE_UNKNOWN', reason: '未查询到原请求，不能据此推断执行失败' };
    }
    const instruction = required(input.origin?.instruction, '原始用户指令');
    const requestId = required(input.requestId, '稳定请求标识', 200);
    const actor = { kind: 'human', id: `device:${principal.deviceId}` };
    const record = () => database.ingest({ dedupeKey: `link-input:${digest([principal.deviceId, source.sessionId, source.messageId])}`,
      thread: { id: `link:${digest([principal.deviceId, source.sessionId, source.threadId])}`, source: { type: 'link', id: source.deviceId } },
      source, actor, content: instruction, mode: 'direct' }).trigger;
    if (input.operation === 'delegate') {
      rejectModelOverride(input);
      const target = required(input.text, '任务内容');
      const acceptance = input.acceptance === undefined || input.acceptance === '' ? instruction : required(input.acceptance, '验收条件');
      const title = normalizeTaskTitle(input.title, target);
      assertSpecificTaskDescription({ title, target });
      const requestKey = `link:${digest([principal.deviceId, requestId])}`;
      const fingerprint = digest([source, instruction, input.projectId, target, acceptance, title]);
      const prior = database.desktopRequest(requestKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw fail('IDEMPOTENCY_CONFLICT', '请求标识已用于不同任务');
        return projection(owned(prior.task.id, source));
      }
      if (pending.has(requestKey)) {
        const saved = pending.get(requestKey);
        if (saved.fingerprint !== fingerprint) throw fail('IDEMPOTENCY_CONFLICT', '请求标识已用于不同任务');
        return saved.promise;
      }
      const promise = (async () => {
        const policy = await readPolicy();
        const project = input.projectId === undefined ? undefined : policy.projects.find(row => row.id === input.projectId);
        if (input.projectId !== undefined && !project) throw new Error('目标设备项目不存在');
        const model = configuredWorkModel(policy);
        const info = await ctx.llm.resolveModelInfo(model.providerId, model.modelId, signal);
        if (info?.id !== model.modelId || info?.provider !== model.providerId) throw new Error('目标工作模型解析改变了显式标识');
        signal?.throwIfAborted();
        const latest = await readPolicy();
        signal?.throwIfAborted();
        if (latest.desktopVersion !== policy.desktopVersion || digest(configuredWorkModel(latest)) !== digest(model))
          throw new Error('接收期间目标工作配置已变化，请使用原请求重试');
        const trigger = record();
        const task = database.acceptDesktop({ triggerId: trigger.id, requestKey, fingerprint, title, target, acceptance, model,
          mandate: { actorId: actor.id, source, instruction, policyVersion: policy.desktopVersion,
            admission: 'link-device-delegation', controlledActions: 'require-current-policy-and-harness-approval',
            ...(project ? { project: { id: project.id, path: project.path } } : {}) } });
        return projection(task);
      })();
      pending.set(requestKey, { fingerprint, promise });
      try { return await promise; } finally { pending.delete(requestKey); }
    }
    const task = owned(input.taskId, source);
    if (input.operation === 'change') {
      rejectModelOverride(input);
      if (input.projectId !== undefined && input.projectId !== task.mandate.project?.id)
        throw Object.assign(new Error('远端跟进不能静默切换项目；请明确委派目标项目的新任务'), { code: 'PROJECT_CHANGE_UNSUPPORTED' });
      const requestKey = `link-change:${digest([principal.deviceId, requestId])}`;
      const requestPayload = { source, instruction, taskId: task.id, operation: input.changeOperation || 'revise',
        instructionRevision: input.instructionRevision, text: input.text, acceptance: input.acceptance, reason: input.reason };
      const previous = database.taskRevisionRequest(requestKey);
      if (previous) {
        if (digest(previous.requestPayload) !== digest(requestPayload)) throw fail('IDEMPOTENCY_CONFLICT', '请求标识已用于不同任务变更');
        return projection(owned(previous.task.id, source));
      }
      const policy = await readPolicy(), model = configuredWorkModel(policy);
      signal.throwIfAborted();
      const trigger = record();
      const mandate = { ...database.currentTaskMandate(task.id, task.mandate), source, instruction,
        actorId: actor.id, policyVersion: policy.desktopVersion };
      return projection(database.changeTask(task.id, { operation: input.changeOperation || 'revise',
        expectedInstructionRevision: input.instructionRevision, target: required(input.text, '完整任务要求'),
        acceptance: required(input.acceptance, '完整验收条件'), reason: required(input.reason, '修改原因', 10000),
        requestKey, requestPayload, triggerId: trigger.id, mandate, model,
        validateMandate: value => validateTaskMandate(value, { policy }) }));
    }
    if (input.operation !== 'control' || !['pause', 'resume', 'cancel', 'supplement', 'answer'].includes(input.control)) throw new Error('不支持的设备任务操作');
    if (input.control === 'answer') {
      const question = database.attentions(task.id).find(row => row.id === input.attentionId);
      if (!question) throw new Error('任务问题不存在');
      database.answerDesktopAttention({ taskId: task.id, attentionId: question.id, instructionRevision: input.instructionRevision,
        requestId, answer: { selected: [], custom: instruction }, deviceSource: source });
    } else {
      if (input.control === 'supplement' && (task.status === 'completed' || taskStopped(task))) throw new Error('已结束任务请使用关联调整');
      const trigger = record(), inputKey = `trigger:${trigger.id}:task:${task.id}`;
      if (input.control === 'pause') database.pauseTask(task.id, { triggerId: trigger.id, inputKey });
      else if (input.control === 'resume') database.resumeTask(task.id);
      else if (input.control === 'cancel') {
        database.recordTaskInput({ taskId: task.id, triggerId: trigger.id, kind: 'stop', idempotencyKey: inputKey });
        database.cancelTask(task.id); database.applyTaskStopInput(task.id, trigger.id);
      } else database.recordTaskInput({ taskId: task.id, triggerId: trigger.id, kind: 'context', idempotencyKey: inputKey });
    }
    return projection(database.getTask(task.id));
  }
  function bind(exec, { ownerAgent, threadId }) {
    if (exec.agent !== ownerAgent) throw fail('COLLABORATION_DENIED', '只有当前总助手可发起设备协作');
    const message = currentHumanInstruction(ctx, ownerAgent)?.message;
    if (!message?.id) throw new Error('跨设备操作缺少当前真实用户指令');
    const instruction = (message.content || []).filter(row => row.type === 'text').map(row => row.text || '').join('\n');
    required(instruction, '原始用户指令');
    return { sessionId: ownerAgent.id, messageId: message.id, threadId, instruction };
  }
  return {
    receive,
    devices: options => link().devices(options),
    resources: input => link().resources(input),
    tick() {
      if (observing || lifecycle?.aborted || !runtimeStore) return observing;
      const due = references().filter(row => ['pending', 'accepted'].includes(row.state) && (row.nextCheckAt || 0) <= now()).slice(0, 4);
      observing = Promise.allSettled(due.map(async row => {
        try {
          const result = await link().callDevice({ deviceId: row.deviceId, input: { action: 'collaboration', operation: row.executionRef ? 'get' : 'lookup',
            requestId: row.requestId, taskId: row.executionRef?.taskId, origin: row.origin }, signal: AbortSignal.any([lifecycle, AbortSignal.timeout(3000)].filter(Boolean)) });
          if (!result.task) throw Object.assign(new Error('原接收状态待核实'), { code: 'ACCEPTANCE_UNKNOWN' });
          if (row.executionRef && result.task.id !== row.executionRef.taskId) throw Object.assign(new Error('目标执行标识不一致'), { code: 'EXECUTION_IDENTITY_CHANGED' });
          const executionRef = row.executionRef || { deviceId: row.deviceId, kind: 'task', resourceId: result.task.id, taskId: result.task.id, executionId: result.executionId };
          const question = result.task.status !== 'completed' && !result.task.executionControl?.stopped && result.attentions?.find(item => item.state === 'waiting' && !item.answerTriggerId
            && item.instructionRevision === result.task?.instructionRevision);
          const version = result.task?.resultVersion || 0;
          const eventKey = question ? `attention:${question.id}` : version ? `result:${version}:${result.task.instructionRevision}` : null;
          if (eventKey && eventKey !== row.lastEventKey) {
            saveReference({ ...row, executionRef, observedEventKey: eventKey });
            await onUpdate?.({ origin: row.origin, executionRef, eventKey, task: result.task,
              ...(question ? { question } : { results: (result.results || []).filter(item => item.version === version).slice(-1) }) });
          }
          const latest = references().find(item => item.requestId === row.requestId);
          if (!latest) return;
          if (result.task?.status === 'completed' || result.task?.executionControl?.stopped)
            saveReference({ ...latest, executionRef, state: 'completed', lastEventKey: eventKey || latest.lastEventKey });
          else saveReference({ ...latest, state: 'accepted', executionRef, lastEventKey: eventKey || latest.lastEventKey, nextCheckAt: now() + 5000 });
        } catch (error) {
          const latest = references().find(item => item.requestId === row.requestId);
          if (latest) saveReference({ ...latest, ...(latest.state === 'pending' ? { lookupFailures: (latest.lookupFailures || 0) + 1,
            ...((latest.lookupFailures || 0) >= 5 ? { state: 'unverified' } : {}) } : {}),
            ...([401, 403, 404, 422].includes(error.statusCode || error.status) ? { state: 'unverified' } : {}), nextCheckAt: now() + 30000, observation: { available: false,
            code: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'REMOTE_STATUS_UNKNOWN' } });
        }
      })).finally(() => { observing = undefined; });
      return observing;
    },
    async action(input, exec, options) {
      const source = bind(exec, options), requestId = digest([source, input]);
      if (['settings-read', 'settings-prepare', 'operation', 'status'].includes(input.operation)) {
        if (!input.deviceId || input.deviceId === 'local') throw new Error('本机配置请使用 assistant_settings；远端配置需要明确目标设备');
        return link().callDevice({ deviceId: input.deviceId, input: { ...input, action: 'management', requestId,
          ...(['settings-read', 'settings-prepare'].includes(input.operation) ? { namespace: 'benchgo-link-relay' } : {}) }, signal: exec.signal });
      }
      return link().deviceAction({ ...input, requestId, source, signal: exec.signal });
    },
    async call(input, exec, options) {
      const source = bind(exec, options), deviceId = required(input.deviceId, '目标设备', 512);
      if (input.operation === 'reconcile') {
        const choices = references().filter(row => row.deviceId === deviceId && row.origin.threadId === options.threadId
          && options.ownerScope?.sessionIds?.includes(row.origin.sessionId) && (!input.requestId || row.requestId === input.requestId));
        if (choices.length !== 1) return { status: 'selection-required', requests: choices.map(row => ({ requestId: row.requestId, state: row.state, executionRef: row.executionRef })) };
        const row = choices[0];
        const value = await link().callDevice({ deviceId, input: { action: 'collaboration', operation: 'lookup', requestId: row.requestId, origin: row.origin }, signal: exec.signal });
        if (value.task) saveReference({ ...row, state: 'accepted', lookupFailures: 0, nextCheckAt: 0,
          executionRef: { deviceId, kind: 'task', resourceId: value.task.id, taskId: value.task.id, executionId: value.executionId } });
        return value;
      }
      if (input.taskId && input.operation !== 'delegate') {
        const reference = references().find(row => row.deviceId === deviceId && row.executionRef?.taskId === input.taskId
          && row.origin.threadId === options.threadId && options.ownerScope?.sessionIds?.includes(row.origin.sessionId));
        if (reference) source.sessionId = reference.origin.sessionId;
      }
      const requestId = digest([source, input]);
      const saved = references().find(row => row.requestId === requestId);
      // Persist intent before transport: uncertain submission is reconciled with the same request identity.
      if (input.operation === 'delegate' && !saved) saveReference({ deviceId, requestId, origin: source, state: 'pending' });
      let result;
      try { result = await link().callDevice({ deviceId, input: { ...input, action: 'collaboration', origin: source, requestId }, signal: exec.signal }); }
      catch (error) {
        if (input.operation !== 'delegate') throw error;
        if ([401, 403, 404, 409, 422].includes(error.statusCode || error.status)) {
          saveReference({ deviceId, requestId, origin: source, state: 'rejected', code: error.code || 'REMOTE_REJECTED' });
          throw error;
        }
        return { status: 'uncertain', requestId, reason: '原请求接收状态待核实；宿主将查询同一请求，不自动重派。可用 reconcile 按此 requestId 手动核实。' };
      }
      const task = result.task;
      const value = { ...result, executionRef: task ? { deviceId, kind: 'task', resourceId: task.id, taskId: task.id,
        executionId: result.executionId } : null };
      if (input.operation === 'delegate' || input.operation === 'change') saveReference({ deviceId, requestId, origin: source,
        state: 'accepted', executionRef: value.executionRef });
      return value;
    },
  };
}
