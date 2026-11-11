import { createHash } from 'node:crypto';
import { readAssessmentPolicy } from './assessment-policy.mjs';
import { assertSpecificTicketDescription, normalizeTicketTitle } from './ticket-title.mjs';
import { configuredWorkModel, rejectModelOverride } from './work-role-policy.mjs';
import { readQuestionReply } from './question-reply.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
  readPolicy = () => readAssessmentPolicy(store, ctx.workspaceRegistry) }) {
  const pending = new Map();
  async function admit(input, exec, { ownerAgent, threadId = 'main', budgetGoalId, goalLeaf } = {}, form) {
    rejectModelOverride(input);
    input = structuredClone(input);
    if (!ownerAgent || exec.agent !== ownerAgent) throw new Error('只有总助手当前会话可委派桌面工单');
    if (goalLeaf !== undefined) required(goalLeaf, '目标子项路径', 512);
    const sessionId = required(ownerAgent.id, '会话标识');
    const requestId = required(input.requestId, '请求标识', 200);
    const projectId = input.projectId == null ? undefined : required(input.projectId, '项目标识');
    const duplicateOfTicketId = input.duplicateOfTicketId === undefined ? undefined : required(input.duplicateOfTicketId, '重复工单标识', 512);
    const target = required(input.text, '任务内容');
    const title = normalizeTicketTitle(input.title, target);
    assertSpecificTicketDescription({ title: input.title ?? title, target });
    const acceptance = input.acceptance ?? '';
    if (typeof acceptance !== 'string' || acceptance.length > 100000) throw new Error('无效验收条件');
    const requestKey = JSON.stringify([sessionId, requestId]);
    const fingerprint = digest([projectId, target, acceptance, ...(input.title !== undefined ? [title] : []), ...(budgetGoalId ? [budgetGoalId] : []), ...(duplicateOfTicketId ? [duplicateOfTicketId] : [])]);
    const instruction = structuredClone(form || currentHumanInstruction(ctx, ownerAgent));
    const message = instruction?.message;
    const instructionFingerprint = digest(instruction);
    if (!message?.id) throw new Error('桌面委派缺少当前原始用户消息');
    const source = { channel: 'desktop', sessionId, messageId: goalLeaf === undefined || goalLeaf === 'root' ? message.id : `${message.id}#goal:${goalLeaf}`, threadId };
    const prior = () => {
      const existing = database.desktopRequest(requestKey);
      if (existing && existing.fingerprint !== fingerprint) throw new Error('请求标识已用于不同任务');
      if (existing && (existing.source?.sessionId !== sessionId || existing.source?.messageId !== source.messageId
        || (existing.source?.threadId || 'main') !== threadId)) throw Object.assign(new Error('请求标识已用于其他用户消息或会话'), { code: 'IDEMPOTENCY_CONFLICT' });
      return existing?.ticket;
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
      // The original requirements remain an authoritative part of the task
      // contract even when a model supplies only an abbreviated criterion.
      // Missing criteria preserve the literal owner request, never invent a
      // generic file/checkpoint requirement during later review.
      const taskAcceptance = acceptance.trim() || original.trim();
      const policy = structuredClone(await readPolicy());
      const project = projectId === undefined ? undefined : policy.projects.find(item => item.id === projectId);
      if (projectId !== undefined && !project) throw new Error('项目不存在');
      // Router owns the delegation decision; the host binds its real source.
      const { trigger } = database.ingest({ dedupeKey: `desktop-message:${digest([sessionId, source.messageId])}`, thread: { id: `desktop:${sessionId}`, source: { type: 'desktop', id: sessionId } }, source, actor: { kind: 'human', id: 'desktop-owner' }, content: original, mode: 'direct' });
      const selectedModel = configuredWorkModel(policy);
      const { providerId, modelId } = selectedModel;
      const info = await ctx.llm.resolveModelInfo(providerId, modelId, exec.signal);
      if (info?.id !== modelId || info?.provider !== providerId) throw new Error('模型解析改变了显式标识，无法委派');
      exec.signal?.throwIfAborted();
      const current = await readPolicy();
      exec.signal?.throwIfAborted();
      const latest = form || currentHumanInstruction(ctx, ownerAgent);
      if (!latest || digest(latest) !== instructionFingerprint) throw new Error('派工期间当前用户指令已变化，请重试');
      if (current.desktopVersion !== policy.desktopVersion || (project && !current.projects.some(item => item.id === projectId && item.path === project.path))) throw new Error('派工期间项目或授权规则已变化，请重试');
      if (digest(configuredWorkModel(current)) !== digest(selectedModel)) throw new Error('派工期间工作角色模型已变化，请重试');
      return database.acceptDesktop({ triggerId: trigger.id, requestKey, fingerprint, title, target, acceptance: taskAcceptance, budgetGoalId, duplicateOfTicketId, model: selectedModel, mandate: {
        actorId: 'desktop-owner', source, instruction: original, policyVersion: policy.desktopVersion,
        target, acceptance: taskAcceptance,
        admission: 'desktop-approved-delegation', controlledActions: 'require-current-policy-and-harness-approval', ...(project ? { project: { id: project.id, path: project.path } } : {}),
      } });
    })();
    pending.set(requestKey, { fingerprint, instructionFingerprint, promise: run });
    try { return await run; } finally { pending.delete(requestKey); }
  }
  return {
    delegate: (input, exec, options) => admit(input, exec, options),
    // Called only by the authenticated resource dispatcher, never exposed as a model tool.
    submitForm(input, { ownerAgent, threadId, requestId, original, budgetGoalId, goalLeaf }) {
      if (ctx.agents?.get(ownerAgent?.id) !== ownerAgent) throw new Error('表单缺少真实主助手会话');
      required(requestId, '表单请求标识', 200);
      required(original, '表单原文');
      return admit(input, { agent: ownerAgent }, { ownerAgent, threadId, budgetGoalId, goalLeaf }, {
        message: { id: `goal-form:${requestId}`, content: [{ type: 'text', text: original }] },
      });
    },
  };
}
