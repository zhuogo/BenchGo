import { createHash } from 'node:crypto';
import { currentHumanInstruction } from './desktop-delegation-service.mjs';
import { requestAssistantApproval } from './approval.mjs';
import { readAssessmentPolicy, validateTicketMandate } from './assessment-policy.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value, label, max = 100000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`无效${label}`);
  return value;
};

/** Host authorization for revisions. Model input cannot supply source, actor or Mandate. */
export function createTicketRevisionService({ ctx, store, database = store.orchestration, readPolicy = () => readAssessmentPolicy(store, ctx.workspaceRegistry) }) {
  async function change(input, exec, options = {}, form) {
    input = structuredClone(input);
    const ticket = database.getTicket(input.id);
    if (!ticket) throw new Error('工单不存在');
    if (!form && (!options.ownerAgent || exec.agent !== options.ownerAgent
      || ticket.mandate.source?.channel !== 'desktop' || ticket.mandate.source.sessionId !== options.ownerAgent.id)) throw new Error('工单不属于当前主人会话');
    if (form && (ctx.agents?.get(options.ownerAgent?.id) !== options.ownerAgent || !options.ownerAgent?.id)) throw new Error('表单缺少真实主助手会话');
    const instruction = form || currentHumanInstruction(ctx, options.ownerAgent);
    const instructionHash = digest(instruction);
    const original = (instruction?.message?.content || []).filter(row => row.type === 'text').map(row => row.text || '').join('\n');
    text(original, '当前主人原始指令');
    text(input.requestId, '请求标识', 200);
    text(input.reason, '变更原因', 10000);
    const target = input.target === undefined ? ticket.target : text(input.target, '任务要求');
    const acceptance = input.acceptance ?? ticket.acceptance;
    if (typeof acceptance !== 'string' || acceptance.length > 100000) throw new Error('无效验收条件');
    const policy = structuredClone(await readPolicy());
    const projectId = input.projectId ?? ticket.mandate.project?.id;
    const project = projectId ? policy.projects.find(row => row.id === projectId) : undefined;
    if (projectId && !project) throw new Error('工单项目不存在，请重新选择');
    if ((input.provider === undefined) !== (input.model === undefined)) throw new Error('供应商与模型标识必须同时提供或同时省略');
    const priorModel = database.assignments(ticket.id).at(-1)?.model || policy.workerModels?.[0] || policy.model;
    const providerId = input.provider ?? priorModel?.providerId, modelId = input.model ?? priorModel?.modelId;
    text(providerId, '供应商标识'); text(modelId, '模型标识');
    const info = await ctx.llm.resolveModelInfo(providerId, modelId, exec?.signal);
    if (info?.id !== modelId || info?.provider !== providerId) throw new Error('模型解析改变了显式标识');
    if (!form && !await requestAssistantApproval(ctx, exec, 'assistant_ticket_change', `${input.operation}: ${target}\n${input.reason}`)) throw new Error('工单变更未获批准');
    exec?.signal?.throwIfAborted();
    const current = await readPolicy();
    if (current.desktopVersion !== policy.desktopVersion || digest(form || currentHumanInstruction(ctx, options.ownerAgent)) !== instructionHash) throw new Error('审批期间主人指令或授权规则已变化');
    const sessionId = options.ownerAgent.id;
    const source = { channel: 'desktop', sessionId, messageId: instruction.message.id, threadId: options.threadId || 'main' };
    // A local resource change is a new desktop authorization, including when the original
    // Ticket came from a channel. The original channel authority remains in revision history.
    const mandate = { actorId: 'desktop-owner', source, instruction: original, policyVersion: current.desktopVersion,
      admission: 'desktop-approved-delegation', controlledActions: 'require-current-policy-and-harness-approval',
      ...(project ? { project: { id: project.id, path: project.path } } : {}) };
    const { trigger } = database.ingest({ dedupeKey: `ticket-change:${digest([sessionId, instruction.message.id])}`,
      thread: { id: `desktop:${sessionId}`, source: { type: 'desktop', id: sessionId } }, source,
      actor: { kind: 'human', id: 'desktop-owner' }, content: original, mode: 'direct' });
    return database.changeTicket(ticket.id, { operation: input.operation, expectedInstructionRevision: input.expectedInstructionRevision,
      target, acceptance, reason: input.reason, requestKey: JSON.stringify(['ticket-change', sessionId, input.requestId]), mandate, triggerId: trigger.id,
      model: { providerId, modelId }, validateMandate: value => validateTicketMandate(value, { policy: current }) });
  }
  return {
    change: (input, exec, options) => change(input, exec, options),
    submitForm(input, options) {
      text(input.requestId, '表单请求标识', 200);
      text(options.original, '表单主人原文');
      return change(input, {}, options, { message: { id: `ticket-change-form:${input.requestId}`, content: [{ type: 'text', text: options.original }] } });
    },
  };
}
