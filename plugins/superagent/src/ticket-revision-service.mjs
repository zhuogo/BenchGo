import { createHash } from 'node:crypto';
import { currentHumanInstruction } from './desktop-delegation-service.mjs';
import { readAssessmentPolicy, validateTicketMandate } from './assessment-policy.mjs';
import { ownsDesktopTicket } from './desktop-ticket-owner.mjs';
import { ticketMandateDifference, isTicketMandateNarrowing } from './ticket-revisions.mjs';
import { configuredWorkModel, rejectModelOverride } from './work-role-policy.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value, label, max = 100000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`无效${label}`);
  return value;
};

/** Host authorization for revisions. Model input cannot supply source, actor or Mandate. */
export function createTicketRevisionService({ ctx, store, database = store.orchestration, readPolicy = () => readAssessmentPolicy(store, ctx.workspaceRegistry), requestExpansion }) {
  async function change(input, exec, options = {}, form) {
    rejectModelOverride(input);
    input = structuredClone(input);
    const ticket = database.getTicket(input.id);
    if (!ticket) throw new Error('工单不存在');
    if (!form && (!options.ownerAgent || exec.agent !== options.ownerAgent
      || !ownsDesktopTicket(ticket, options.ownerScope ?? { threadId: options.threadId || 'main', sessionIds: [options.ownerAgent.id] }))) throw new Error('工单不属于当前主人会话');
    if (form && (ctx.agents?.get(options.ownerAgent?.id) !== options.ownerAgent || !options.ownerAgent?.id)) throw new Error('表单缺少真实主助手会话');
    const instruction = form || currentHumanInstruction(ctx, options.ownerAgent);
    const instructionHash = digest(instruction);
    const original = (instruction?.message?.content || []).filter(row => row.type === 'text').map(row => row.text || '').join('\n');
    text(original, '当前主人原始指令');
    text(input.requestId, '请求标识', 200);
    text(input.reason, '变更原因', 10000);
    const requestKey = JSON.stringify(['ticket-change', options.ownerAgent.id, input.requestId]);
    const requestPayload = { input, instructionHash };
    const previous = database.ticketRevisionRequest(requestKey);
    if (previous?.requestPayload) {
      if (digest(previous.requestPayload) !== digest(requestPayload)) throw Object.assign(new Error('请求标识已用于不同的工单变更'), { code: 'IDEMPOTENCY_CONFLICT' });
      return previous.ticket;
    }
    const target = input.target === undefined ? ticket.target : text(input.target, '任务要求');
    const acceptance = input.acceptance ?? ticket.acceptance;
    if (typeof acceptance !== 'string' || acceptance.length > 100000) throw new Error('无效验收条件');
    const policy = structuredClone(await readPolicy());
    if (input.projectId !== undefined) text(input.projectId, '项目标识', 512);
    const projectId = input.projectId ?? ticket.mandate.project?.id;
    const project = projectId ? policy.projects.find(row => row.id === projectId) : undefined;
    if (projectId && !project) throw new Error('工单项目不存在，请重新选择');
    const terminal = (ticket.status === 'completed' || ticket.executionControl?.stopped === true);
    // Existing Assignment.model is historical audit data, never a new override.
    const model = terminal ? configuredWorkModel(policy) : database.assignments(ticket.id).at(-1)?.model || configuredWorkModel(policy);
    // Ordinary changes are bound to the live human instruction. Only actual
    // structured authority expansion enters the trusted host approval flow.
    exec?.signal?.throwIfAborted();
    const current = structuredClone(await readPolicy());
    if (current.desktopVersion !== policy.desktopVersion || digest(form || currentHumanInstruction(ctx, options.ownerAgent)) !== instructionHash) throw new Error('变更期间主人指令或授权规则已变化');
    const sessionId = options.ownerAgent.id;
    const source = { channel: 'desktop', sessionId, messageId: instruction.message.id, threadId: options.threadId || 'main' };
    // A local resource change is a new desktop authorization, including when the original
    // Ticket came from a channel. The original channel authority remains in revision history.
    const mandate = { ...database.currentTicketMandate(ticket.id, ticket.mandate), actorId: 'desktop-owner', source, instruction: original, policyVersion: current.desktopVersion,
      admission: 'desktop-approved-delegation', controlledActions: 'require-current-policy-and-harness-approval',
      ...(project ? { project: { id: project.id, path: project.path } } : {}) };
    const { trigger } = database.ingest({ dedupeKey: `ticket-change:${digest([sessionId, instruction.message.id])}`,
      thread: { id: `desktop:${sessionId}`, source: { type: 'desktop', id: sessionId } }, source,
      actor: { kind: 'human', id: 'desktop-owner' }, content: original, mode: 'direct' });
    const difference = ticketMandateDifference(ticket.mandate, mandate);
    let approval;
    if (difference && !isTicketMandateNarrowing(ticket.mandate, mandate)) {
      if (!(ticket.status === 'completed' || ticket.executionControl?.stopped === true)
        && digest(mandate.project ?? null) !== digest(ticket.mandate.project ?? null)
        && database.assignments(ticket.id).some(row => database.runs(row.id).length)) throw Object.assign(new Error('已有真实执行会话不能原地切换工作区；请停止原工单后创建关联调整'), { code: 'PROJECT_REQUIRES_ADJUSTMENT' });
      if (typeof requestExpansion !== 'function') throw Object.assign(new Error('结构化授权范围扩大需要真实用户确认'), { code: 'MANDATE_EXPANSION_REQUIRED' });
      approval = await requestExpansion({ ticket: structuredClone(ticket), trigger: structuredClone(trigger), mandate: structuredClone(mandate),
        difference: structuredClone(difference), exec, ownerAgent: options.ownerAgent });
      exec?.signal?.throwIfAborted();
      if (!approval || approval.approved !== true || approval.actorId !== trigger.actor.id || approval.triggerId !== trigger.id || typeof approval.id !== 'string' || !approval.id) throw Object.assign(new Error('用户未批准此授权范围扩大'), { code: 'MANDATE_EXPANSION_DENIED' });
      approval = structuredClone(approval);
    }
    const finalPolicy = structuredClone(await readPolicy()), finalTicket = database.getTicket(ticket.id);
    exec?.signal?.throwIfAborted();
    if (finalPolicy.desktopVersion !== current.desktopVersion || digest(form || currentHumanInstruction(ctx, options.ownerAgent)) !== instructionHash
      || finalTicket.instructionRevision !== ticket.instructionRevision || finalTicket.status !== ticket.status
      || digest(finalTicket.executionControl) !== digest(ticket.executionControl)
      || digest(finalTicket.mandate) !== digest(ticket.mandate)) throw Object.assign(new Error('确认期间原指令、工单或授权规则已变化'), { code: 'TICKET_CHANGE_STALE' });
    const approvedBinding = digest([ticket.id, ticket.instructionRevision, mandate, difference]);
    return database.changeTicket(ticket.id, { operation: input.operation, expectedInstructionRevision: input.expectedInstructionRevision,
      target, acceptance, reason: input.reason, requestKey, requestPayload, mandate, triggerId: trigger.id,
      model, validateMandate: value => validateTicketMandate(value, { policy: finalPolicy }),
      authorizeExpansion: request => approval && approvedBinding === digest([request.ticket.id, request.ticket.instructionRevision, request.mandate, request.difference]) ? approval : null });
  }
  return {
    change: (input, exec, options) => change(input, exec, options),
    async changeExecutionInput({ triggerId, assignmentId, runId, sessionId, owner, fence, decision, policy }) {
      const assignment = database.getAssignment(assignmentId), run = assignment && database.runs(assignmentId).find(row => row.id === runId);
      const trigger = database.getTrigger(triggerId), ticket = assignment && database.getTicket(assignment.ticketId);
      if (!assignment || assignment.state !== 'claimed' || assignment.owner !== owner || assignment.fence !== fence || assignment.leaseUntil <= Date.now()
        || !run || run.owner !== owner || run.fence !== fence || run.sessionId !== sessionId
        || trigger?.actor.kind !== 'human' || trigger.actor.id !== 'desktop-owner' || trigger.source?.channel !== 'desktop'
        || trigger.source.executionSessionId !== sessionId || trigger.source.sessionId !== sessionId || !trigger.source.executionMessageId
        || trigger.source.messageId !== trigger.source.executionMessageId) throw Object.assign(new Error('执行输入不属于当前真实执行'), { code: 'FENCING_CONFLICT' });
      if (decision.outcome !== 'revise' || decision.withinMandate !== true || decision.ticketId !== ticket.id
        || decision.projectId !== undefined && decision.projectId !== ticket.mandate.project?.id) throw Object.assign(new Error('执行输入需要 Router 核实授权范围'), { code: 'MANDATE_EXPANSION_REQUIRED' });
      const current = await readPolicy();
      if (current.desktopVersion !== policy.desktopVersion || current.version !== policy.version
        || !validateTicketMandate(database.currentTicketMandate(ticket.id, ticket.mandate), { policy: current })) throw Object.assign(new Error('执行输入分诊期间授权规则已变化'), { code: 'MANDATE_REVOKED' });
      // No await between this final fence check and the synchronous transaction.
      const live = database.getAssignment(assignmentId);
      if (live.state !== 'claimed' || live.owner !== owner || live.fence !== fence || live.leaseUntil <= Date.now()) throw Object.assign(new Error('执行输入已失去当前执行归属'), { code: 'FENCING_CONFLICT' });
      const mandate = { ...database.currentTicketMandate(ticket.id, ticket.mandate), actorId: trigger.actor.id, source: trigger.source,
        instruction: trigger.content, policyVersion: current.desktopVersion, admission: 'desktop-approved-delegation' };
      return database.changeTicket(ticket.id, { operation: 'revise', expectedInstructionRevision: decision.expectedInstructionRevision,
        target: decision.target ?? ticket.target, acceptance: decision.acceptance ?? ticket.acceptance, reason: decision.reason,
        requestKey: `execution-input:${triggerId}`, triggerId, mandate, model: assignment.model,
        validateMandate: value => validateTicketMandate(value, { policy: current }) });
    },
    submitForm(input, options) {
      text(input.requestId, '表单请求标识', 200);
      text(options.original, '表单主人原文');
      return change(input, {}, options, { message: { id: `ticket-change-form:${input.requestId}`, content: [{ type: 'text', text: options.original }] } });
    },
  };
}
