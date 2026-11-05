import { createHash } from 'node:crypto';
import { readAssessmentPolicy } from './assessment-policy.mjs';
import { normalizeTicketTitle } from './ticket-title.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const followUpPattern = /(?:任务|工单|ticket|这个|那个|上述|上面|刚才|之前|已有|现有).{0,16}(?:卡住|卡着|挂住|转圈|状态|进展|进度|完成了吗|还没)|(?:卡住|卡着|挂住|转圈|状态|进展|进度|完成了吗|还没).{0,16}(?:任务|工单|ticket|这个|那个|上述|上面|刚才|之前|已有|现有)/iu;

export function isTicketFollowUp(text) {
  return typeof text === 'string' && followUpPattern.test(text);
}

export function currentHumanInstruction(ctx, agent) {
  if (ctx.agents?.get(agent.id) !== agent || agent.status !== 'running'
    || ctx.agents.currentInitiator() !== agent || agent.session.header.origin === 'subagent') return null;
  const events = agent.session.snapshotEvents();
  const start = ctx.agents.turnBoundaryOf?.(agent.session)?.openTurnStartSeq;
  if (!Number.isSafeInteger(start) || start < 0) return null;
  const current = events.slice(start + 1);
  if (current.some(event => event.type === 'turn/end')) return null;
  const message = current.findLast(event => event.type === 'user/message' && event.data?.source?.kind === 'user')?.data;
  return message ? { turn: start, message } : null;
}
const required = (value, name, max = 100000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`无效${name}`);
  return value;
};

/** Local owner entry point. Authority comes from the mounted root Agent, never tool arguments. */
export function createDesktopDelegationService({ ctx, store, database = store.orchestration, readPolicy = () => readAssessmentPolicy(store, ctx.workspaceRegistry) }) {
  const pending = new Map();
  async function admit(input, exec, { ownerAgent, threadId = 'main', budgetGoalId } = {}, form) {
    if (!ownerAgent || exec.agent !== ownerAgent) throw new Error('只有总助手当前会话可委派桌面工单');
    const sessionId = required(ownerAgent.id, '会话标识');
    const requestId = required(input.requestId, '请求标识', 200);
    const projectId = input.projectId == null ? undefined : required(input.projectId, '项目标识');
    const providerId = required(input.provider, '供应商标识');
    const modelId = required(input.model, '模型标识');
    const target = required(input.text, '任务内容');
    const title = normalizeTicketTitle(input.title, target);
    const acceptance = input.acceptance ?? '';
    if (typeof acceptance !== 'string' || acceptance.length > 100000) throw new Error('无效验收条件');
    const requestKey = JSON.stringify([sessionId, requestId]);
    const fingerprint = digest([projectId, providerId, modelId, target, acceptance, ...(input.title !== undefined ? [title] : []), ...(budgetGoalId ? [budgetGoalId] : [])]);
    const prior = () => {
      const existing = database.desktopRequest(requestKey);
      if (existing && existing.fingerprint !== fingerprint) throw new Error('请求标识已用于不同任务');
      return existing?.ticket;
    };
    const existing = prior();
    if (existing) return existing;
    if (pending.has(requestKey)) { await pending.get(requestKey); return prior(); }
    const run = (async () => {
      exec.signal?.throwIfAborted();
      const instruction = form || currentHumanInstruction(ctx, ownerAgent);
      const message = instruction?.message;
      const instructionFingerprint = digest(instruction);
      if (!message?.id) throw new Error('桌面委派缺少当前原始用户消息');
      const original = (message.content || []).filter(block => block.type === 'text').map(block => block.text || '').join('\n');
      if (!original.trim()) throw new Error('桌面委派缺少原始用户文字指令');
      // The original requirements remain an authoritative part of the task
      // contract even when a model supplies only an abbreviated criterion.
      // Missing criteria preserve the literal owner request, never invent a
      // generic file/checkpoint requirement during later review.
      const taskAcceptance = acceptance.trim() || original.trim();
      if (isTicketFollowUp(original)) {
        throw Object.assign(new Error('当前消息是对已有任务的跟进或状态查询，请先使用 assistant_tickets，避免重复创建工单'), { code: 'ROUTER_TICKET_FOLLOWUP_REQUIRED' });
      }
      const policy = await readPolicy();
      const project = projectId === undefined ? undefined : policy.projects.find(item => item.id === projectId);
      if (projectId !== undefined && !project) throw new Error('项目不存在');
      const info = await ctx.llm.resolveModelInfo(providerId, modelId, exec.signal);
      if (info?.id !== modelId || info?.provider !== providerId) throw new Error('模型解析改变了显式标识，无法委派');
      exec.signal?.throwIfAborted();
      const current = await readPolicy();
      const latest = form || currentHumanInstruction(ctx, ownerAgent);
      if (!latest || digest(latest) !== instructionFingerprint) throw new Error('派工期间当前用户指令已变化，请重试');
      if (current.desktopVersion !== policy.desktopVersion || (project && !current.projects.some(item => item.id === projectId && item.path === project.path))) throw new Error('派工期间项目或授权规则已变化，请重试');
      const source = { channel: 'desktop', sessionId, messageId: message.id, threadId };
      const { trigger } = database.ingest({ dedupeKey: `desktop-message:${digest([sessionId, message.id])}`, thread: { id: `desktop:${sessionId}`, source: { type: 'desktop', id: sessionId } }, source, actor: { kind: 'human', id: 'desktop-owner' }, content: original, mode: 'direct' });
      return database.acceptDesktop({ triggerId: trigger.id, requestKey, fingerprint, title, target, acceptance: taskAcceptance, budgetGoalId, model: { providerId, modelId }, mandate: {
        actorId: 'desktop-owner', source, instruction: original, policyVersion: policy.desktopVersion,
        target, acceptance: taskAcceptance,
        admission: 'desktop-approved-delegation', controlledActions: 'require-current-policy-and-harness-approval', ...(project ? { project: { id: project.id, path: project.path } } : {}),
      } });
    })();
    pending.set(requestKey, run);
    try { return await run; } finally { pending.delete(requestKey); }
  }
  return {
    delegate: (input, exec, options) => admit(input, exec, options),
    // Called only by the authenticated resource dispatcher, never exposed as a model tool.
    submitForm(input, { ownerAgent, threadId, requestId, original, budgetGoalId }) {
      if (ctx.agents?.get(ownerAgent?.id) !== ownerAgent) throw new Error('表单缺少真实主助手会话');
      required(requestId, '表单请求标识', 200);
      required(original, '表单原文');
      return admit(input, { agent: ownerAgent }, { ownerAgent, threadId, budgetGoalId }, {
        message: { id: `goal-form:${requestId}`, content: [{ type: 'text', text: original }] },
      });
    },
  };
}
