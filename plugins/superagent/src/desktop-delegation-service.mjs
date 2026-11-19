import { createHash } from 'node:crypto';
import { readAssessmentPolicy } from './assessment-policy.mjs';
import { assertSpecificTaskDescription, normalizeTaskTitle } from './task-title.mjs';
import { configuredWorkModel, rejectModelOverride } from './work-role-policy.mjs';
import { readQuestionReply } from './question-reply.mjs';
import { readRemoteExecutionCatalog, selectRemoteExecution } from './execution-catalog.mjs';
import { assertExternalWorkerModel, assertExternalWorkerTask } from './external-worker.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex');
export function currentHumanInstruction(ctx, agent) {
  if (ctx.agents?.get(agent.id) !== agent || agent.status !== 'running'
    || ctx.agents.currentInitiator() !== agent || agent.session.header.origin === 'subagent') return null;
  const events = agent.session.snapshotEvents();
  const start = ctx.agents.turnBoundaryOf?.(agent.session)?.openTurnStartSeq;
  if (!Number.isSafeInteger(start) || start < 0) return null;
  const current = events.slice(start + 1);
  if (current.some(event => event.type === 'turn/end')) return null;
  const message = current.findLast(event => {
    if (event.type !== 'user/message') return false;
    if (event.data?.source?.kind === 'user') return true;
    // Reuse the official call/reply binding; a skipped or fabricated card is
    // not a new human instruction. Keep the original message untouched.
    const reply = readQuestionReply(event.data, events);
    return reply?.answers.some(answer => answer.selected.length || answer.custom?.trim());
  })?.data;
  return message ? { turn: start, message } : null;
}
const required = (value, name, max = 100000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`无效${name}`);
  return value;
};

/** Local owner entry point. Authority comes from the mounted root Agent, never tool arguments. */
export function createDesktopDelegationService({ ctx, store, database = store.orchestration,
  readPolicy = () => readAssessmentPolicy(store, ctx.workspaceRegistry), wake }) {
  const pending = new Map();
  async function admit(input, exec, { ownerAgent, threadId = 'main' } = {}) {
    rejectModelOverride(input);
    input = structuredClone(input);
    if (!ownerAgent || exec.agent !== ownerAgent) throw new Error('只有总助手当前会话可委派桌面任务');
    const sessionId = required(ownerAgent.id, '会话标识');
    const deviceId = input.deviceId == null || input.deviceId === 'local' ? 'local' : required(input.deviceId, '目标设备', 512);
    if (deviceId === 'local' && input.executionConfig !== undefined) throw Object.assign(new Error('本机任务使用已保存的工作角色，不接受单任务执行模型覆盖'), { code: 'MODEL_OVERRIDE_UNSUPPORTED' });
    const projectId = input.projectId == null ? undefined : required(input.projectId, '项目标识');
    const duplicateOfTaskId = input.duplicateOfTaskId === undefined ? undefined : required(input.duplicateOfTaskId, '重复任务标识', 512);
    const target = required(input.text, '任务内容');
    const title = normalizeTaskTitle(input.title, target);
    assertSpecificTaskDescription({ title: input.title ?? title, target });
    const acceptance = input.acceptance ?? '';
    if (typeof acceptance !== 'string' || acceptance.length > 100000) throw new Error('无效验收条件');
    const fingerprint = digest([deviceId, input.executionConfig ?? null, projectId, target, acceptance, ...(input.title !== undefined ? [title] : []), ...(duplicateOfTaskId ? [duplicateOfTaskId] : [])]);
    const instruction = structuredClone(currentHumanInstruction(ctx, ownerAgent));
    const message = instruction?.message;
    const instructionFingerprint = digest(instruction);
    if (!message?.id) throw new Error('桌面委派缺少当前原始用户消息');
    const source = { channel: 'desktop', sessionId, messageId: message.id, threadId };
    // Host-derived identity survives retries without requiring model-generated IDs.
    const requestId = input.requestId === undefined ? digest([source, fingerprint, null]) : required(input.requestId, '请求标识', 200);
    const requestKey = JSON.stringify([sessionId, requestId]);
    const prior = () => {
      const existing = database.desktopRequest(requestKey);
      if (existing && existing.fingerprint !== fingerprint) throw new Error('请求标识已用于不同任务');
      if (existing && (existing.source?.sessionId !== sessionId || existing.source?.messageId !== source.messageId
        || (existing.source?.threadId || 'main') !== threadId)) throw Object.assign(new Error('请求标识已用于其他用户消息或会话'), { code: 'IDEMPOTENCY_CONFLICT' });
      return existing?.task;
    };
    const existing = prior();
    if (existing) return existing;
    const inflight = pending.get(requestKey);
    if (inflight) {
      if (inflight.fingerprint !== fingerprint || inflight.instructionFingerprint !== instructionFingerprint) throw Object.assign(new Error('请求标识已用于不同用户指令或拟派任务'), { code: 'IDEMPOTENCY_CONFLICT' });
      return inflight.promise;
    }
    const run = (async () => {
      exec.signal?.throwIfAborted();
      const original = (message.content || []).filter(block => block.type === 'text').map(block => block.text || '').join('\n');
      if (!original.trim()) throw new Error('桌面委派缺少原始用户文字指令');
      const taskAcceptance = acceptance.trim();
      const policy = structuredClone(await readPolicy());
      const remote = deviceId !== 'local' ? selectRemoteExecution(await readRemoteExecutionCatalog(ctx, deviceId, exec.signal), input) : undefined;
      const project = remote ? remote.project : projectId === undefined ? undefined : policy.projects.find(item => item.id === projectId);
      if (!remote && projectId !== undefined && !project) throw new Error('项目不存在');
      // Router owns the delegation decision; the host binds its real source.
      const { trigger } = database.ingest({ dedupeKey: `desktop-message:${digest([sessionId, source.messageId])}`, thread: { id: `desktop:${sessionId}`, source: { type: 'desktop', id: sessionId } }, source, actor: { kind: 'human', id: 'desktop-owner' }, content: original, mode: 'direct' });
      const selectedModel = remote ? remote.model : configuredWorkModel(policy);
      if (!remote && selectedModel.harness && selectedModel.harness !== 'official') {
        assertExternalWorkerTask({ target, acceptance: taskAcceptance });
        await assertExternalWorkerModel(ctx, selectedModel, exec.signal);
      } else if (!remote) {
        const { providerId, modelId } = selectedModel;
        const info = await ctx.llm.resolveModelInfo(providerId, modelId, exec.signal);
        if (info?.id !== modelId || info?.provider !== providerId) throw new Error('模型解析改变了显式标识，无法委派');
      }
      exec.signal?.throwIfAborted();
      if (remote) {
        const directory = await ctx.get('benchgoLink').devices({ signal: exec.signal });
        const currentDevice = directory.devices?.find(row => row.id === deviceId);
        if (currentDevice?.hostId !== remote.execution.hostId || currentDevice?.authorizationId !== remote.execution.authorizationId) throw new Error('安排任务期间目标设备或连接授权已变化，请重试');
      }
      const current = await readPolicy();
      exec.signal?.throwIfAborted();
      const latest = currentHumanInstruction(ctx, ownerAgent);
      if (!latest || digest(latest) !== instructionFingerprint) throw new Error('安排任务期间当前用户指令已变化，请重试');
      if (current.desktopVersion !== policy.desktopVersion || (!remote && project && !current.projects.some(item => item.id === projectId && item.path === project.path))) throw new Error('安排任务期间项目或授权规则已变化，请重试');
      if (!remote && digest(configuredWorkModel(current)) !== digest(selectedModel)) throw new Error('安排任务期间工作角色模型已变化，请重试');
      const task = database.acceptDesktop({ triggerId: trigger.id, requestKey, fingerprint, title, target, acceptance: taskAcceptance, duplicateOfTaskId, model: selectedModel, mandate: {
        actorId: 'desktop-owner', source, triggerId: trigger.id, instruction: original, policyVersion: policy.desktopVersion,
        target, acceptance: taskAcceptance,
        admission: 'desktop-approved-delegation', controlledActions: 'require-current-policy-and-harness-approval',
        ...(project ? { project: remote ? project : { id: project.id, path: project.path } } : {}),
        ...(remote ? { execution: remote.execution } : {}),
      } });
      // Acceptance is durable before waking the existing scheduler. Do not
      // wait for execution, or turn a wake failure into a failed admission.
      if (wake) void Promise.resolve().then(wake).catch(() => {
        ctx.logger?.warn?.('SuperAgent 任务已受理，调度唤醒待定时重试');
      });
      return task;
    })();
    pending.set(requestKey, { fingerprint, instructionFingerprint, promise: run });
    try { return await run; } finally { pending.delete(requestKey); }
  }
  return {
    delegate: (input, exec, options) => admit(input, exec, options),
  };
}
