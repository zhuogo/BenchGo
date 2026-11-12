import { actionHash, HIGH_RISK_ACTION_CATEGORIES, SITE_ACTION_CATEGORIES, canonicalAction } from './external-action-store.mjs';
import { validateTicketMandate } from './assessment-policy.mjs';
import { workerAppliedTicket } from './worker-permissions.mjs';
import { requestExternalActionApproval } from './approval.mjs';
import { channelExternalSendInputSchema } from './channel-policy.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const publicAction = ({ submission: _submission, binding, ...action }) => ({ ...action, ticketId: binding.ticketId });
const publicReceipt = receipt => {
  const fields = ['messageId', 'receiptId', 'transactionId'];
  if (receipt?.status !== 'accepted' || !fields.some(key => typeof receipt[key] === 'string' && receipt[key])) throw fail('ACTION_RECEIPT_UNKNOWN', '受控能力未返回确定回执，须先核实实际效果');
  return { status: 'accepted', ...Object.fromEntries(fields.filter(key => typeof receipt[key] === 'string' && receipt[key]).map(key => [key, receipt[key].slice(0, 2000)])) };
};

/** Code-owned capability declarations; model input never chooses a category or mapping. */
export function createExternalActionRegistry() {
  const entries = new Map();
  return {
    register(adapter) {
      if (!adapter || typeof adapter.id !== 'string' || !adapter.id || entries.has(adapter.id)
        || ![...HIGH_RISK_ACTION_CATEGORIES, ...SITE_ACTION_CATEGORIES].includes(adapter.category)
        || adapter.inputSchema?.type !== 'object' || typeof adapter.prepare !== 'function' || typeof adapter.submit !== 'function') throw new Error('Invalid external action adapter: inputSchema and structured prepare/submit are required');
      const entry = Object.freeze({ ...adapter, inputSchema: freeze(canonicalAction(adapter.inputSchema)) }); entries.set(entry.id, entry);
      return () => { if (entries.get(entry.id) === entry) entries.delete(entry.id); };
    },
    get: id => entries.get(id),
    catalog: () => [...entries.values()].map(({ id, category, label, inputSchema }) => ({ id, category, label: label || id, inputSchema: structuredClone(inputSchema) })),
  };
}

/** Each context read must validate the real run, lease/fence, current Mandate and policy. */
export function createExternalActionService({ store, registry, getContext, requestApproval }) {
  if (typeof getContext !== 'function' || typeof requestApproval !== 'function') throw new Error('External actions require host context and approval');
  const pending = new Map();
  const identity = context => ({ profileId: context.profileId, id: context.actorId, label: context.actorLabel || context.actorId });
  const current = async exec => { exec.signal?.throwIfAborted(); const context = await getContext(exec); exec.signal?.throwIfAborted(); return context; };
  const registered = id => registry.get(id);
  return {
    catalog: () => ({ adapters: registry.catalog(), handoffCategories: HIGH_RISK_ACTION_CATEGORIES.filter(category => !registry.catalog().some(adapter => adapter.category === category)) }),
    async prepare({ adapterId, input = {}, requestId }, exec) {
      const context = await current(exec), adapter = registered(adapterId);
      if (!adapter) return { state: 'handoff', reason: '此能力尚未接通受控提交，请用户接管最后一步', adapterId };
      const prepared = canonicalAction(await adapter.prepare(canonicalAction(input), context));
      const latest = await current(exec);
      if (actionHash(identity(context)) !== actionHash(identity(latest))) throw fail('ACTION_ACTOR_MISMATCH', '动作准备期间授权人已变化');
      const action = store.prepare({ requestId, adapterId, category: adapter.category, origin: prepared.origin ?? null,
        target: prepared.target, content: prepared.content, submission: prepared.submission }, latest);
      return publicAction(action);
    },
    async submit({ actionId }, exec) {
      const caller = await current(exec), owned = store.get(actionId);
      for (const key of ['profileId', 'actorId', 'ticketId', 'assignmentId', 'runId', 'authorizationVersion', 'policyVersion']) {
        if (String(caller[key]) !== owned.binding[key]) throw fail('ACTION_BINDING_CHANGED', '动作不属于当前工单、运行或授权版本');
      }
      if (pending.has(actionId)) return pending.get(actionId);
      const work = (async () => {
        let context = await current(exec), action = store.get(actionId);
        const adapter = registered(action.adapterId);
        if (!adapter || adapter.category !== action.category) return { state: 'handoff', actionId, reason: '受控能力已不可用，请用户接管最后一步' };
        const frozen = freeze(structuredClone(action));
        // Reject other Ticket/actor/run access even when the action was already decided.
        for (const key of ['profileId', 'actorId', 'ticketId', 'assignmentId', 'runId', 'authorizationVersion', 'policyVersion']) {
          if (String(context[key]) !== action.binding[key]) throw fail('ACTION_BINDING_CHANGED', '动作不属于当前工单、运行或授权版本');
        }
        if (['completed', 'denied'].includes(action.state)) return publicAction(action);
        if (['submitted', 'uncertain'].includes(action.state)) return { ...publicAction(action), requiresReconciliation: true };
        if (action.state === 'pending') {
          const outcome = await requestApproval({ exec, action: publicAction(frozen),
            reason: '批准本次具体外部动作（仅本次有效）：\n' + JSON.stringify({ actionId: action.id, category: action.category, origin: action.origin, target: action.target, content: action.content }) });
          context = await current(exec);
          action = store.decide(action.id, outcome === 'allowed-once', context, identity(context));
          if (action.state === 'denied') return publicAction(action);
        }
        // Adapter checks current connection, endpoint and frozen recipient/content.
        await adapter.validate?.(frozen, context);
        context = await current(exec);
        exec.signal?.throwIfAborted();
        action = store.consume(action.id, context);
        // No await from final host authority/consumption to the trusted submit call.
        let submission;
        try { submission = adapter.submit(frozen, { signal: exec.signal, idempotencyKey: `benchgo-action:${action.id}`, context }); }
        catch { store.settle(action.id, { uncertain: true }); return { ...publicAction(store.get(action.id)), requiresReconciliation: true }; }
        try {
          const receipt = publicReceipt(await submission);
          // Adapters return a minimal public receipt, never response bodies or secrets.
          const result = store.settle(action.id, { receipt }); return publicAction(result);
        } catch { store.settle(action.id, { uncertain: true }); return { ...publicAction(store.get(action.id)), requiresReconciliation: true }; }
      })();
      pending.set(actionId, work);
      try { return await work; } finally { if (pending.get(actionId) === work) pending.delete(actionId); }
    },
  };
}

/** Only registered channels can submit; normal source replies remain in the owned delivery pipeline. */
export function registerChannelExternalActions(registry, { getAdapter, channelIds, getCapabilities = id => getAdapter(id)?.capabilities }) {
  const disposers = [];
  for (const channel of channelIds) {
    if (!getCapabilities(channel)?.externalActions?.includes('external-send') || typeof getAdapter(channel)?.prepareExternalSend !== 'function') continue;
    disposers.push(registry.register({ id: `channel:${channel}:send`, label: `${channel} 另行发送`, category: 'external-send', inputSchema: channelExternalSendInputSchema,
      prepare: (input, context) => getAdapter(channel).prepareExternalSend(input, { principal: context.principal }),
      async validate(action, context) {
        const adapter = getAdapter(channel);
        if (typeof adapter?.prepareExternalSend !== 'function') throw fail('ACTION_ADAPTER_UNAVAILABLE', '渠道受控发送不可用');
        const latest = await adapter.prepareExternalSend(action.submission.input, { principal: context.principal });
        if (actionHash(latest) !== actionHash({ origin: action.origin, target: action.target, content: action.content, submission: action.submission })) throw fail('ACTION_CONTENT_CHANGED', '渠道目标、内容或配置已变化，请重新批准');
      },
      submit: (action, { signal, idempotencyKey }) => getAdapter(channel).send({ source: action.submission.source, text: action.submission.text, signal, idempotencyKey }),
    }));
  }
  return () => disposers.forEach(dispose => dispose());
}

export function installExternalActionTools(scope, agent, { service }) {
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  return scope.tools.register({ name: 'assistant_external_action',
    description: 'Prepare or submit a registered structured external action. Call catalog first and follow the selected adapter inputSchema exactly for prepare.input; use the returned action id for submit.actionId. requestId is a stable idempotency key for the same exact target/content. Never guess field names or search application/source files to discover an adapter contract. If trusted target information is missing, ask rather than invent it. External actions reuse the existing task approval for the exact final content; an already approved action is never approved again. Absent adapters return human handoff. Open terminal/browser tools may only prepare these actions, never submit or bypass this channel. Normal authenticated source replies use the existing source delivery pipeline.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      operation: { type: 'string', enum: ['catalog', 'prepare', 'submit'] }, adapterId: { type: 'string', description: 'catalog 返回的确切通道 ID；prepare 必填。' }, input: { type: 'object', additionalProperties: true, description: 'prepare 专用：严格遵守所选通道 catalog.inputSchema，不接受猜测的字段别名。' }, requestId: { type: 'string', description: 'prepare 必填：同一目标与正文的稳定幂等键。' }, actionId: { type: 'string', description: 'submit 必填：prepare 返回的动作 id；submit 将等待真实用户逐次审批。' },
    }, required: ['operation'] }, output,
    async execute(input, exec) {
      if (exec.agent !== agent) throw fail('ACTION_AGENT_MISMATCH', '外部动作只供当前拥有工单的 Worker 使用');
      if (input.operation === 'catalog') return service.catalog();
      if (input.operation === 'prepare') return service.prepare(input, exec);
      if (input.operation === 'submit') return service.submit(input, exec);
      throw fail('ACTION_OPERATION_INVALID', '无效动作操作');
    },
  });
}

/** The root service owns one registry/store, each owning Worker gets a scoped facade. */
export function createExternalActionHost({ ctx, store, registry, onApprovalPending }) {
  return {
    registry,
    installWorker(scope, agent, { database, assignment, run, readPolicy, authorizeAction, leaseMs = 60000 }) {
      const getContext = async exec => {
        exec.signal.throwIfAborted();
        if (exec.agent !== agent || String(agent.id) !== run.sessionId || String(agent.session?.id) !== run.sessionId) throw fail('ACTION_WORKER_MISMATCH', '动作只能由当前拥有工单的 Worker 发起');
        const ticket = workerAppliedTicket(database, assignment, { name: 'assistant_external_action' });
        const current = database.getAssignment(assignment.id), active = database.runs(assignment.id).find(item => item.id === run.id);
        if (!current || current.state !== 'claimed' || current.owner !== assignment.owner || current.fence !== assignment.fence || !active || active.owner !== assignment.owner || active.fence !== assignment.fence
          || active.sessionId !== run.sessionId || !['submitted', 'running'].includes(active.state)) throw fail('ACTION_WORKER_STALE', '动作的工单、运行或租约已失效');
        const policy = await readPolicy();
        if (!validateTicketMandate(ticket.mandate, { policy }) || (await authorizeAction({ policy, mandate: ticket.mandate, ticket, execution: exec }))?.allowed !== true) throw fail('ACTION_MANDATE_REVOKED', '当前工单授权不允许此动作');
        const finalPolicy = await readPolicy(), latest = workerAppliedTicket(database, assignment, { name: 'assistant_external_action' });
        const versionKey = ticket.mandate.source?.channel === 'desktop' ? 'desktopVersion' : 'version';
        const renewed = database.renewAssignment(assignment.id, { owner: assignment.owner, fence: assignment.fence, leaseMs,
          validateMandate: mandate => finalPolicy[versionKey] === policy[versionKey] && validateTicketMandate(mandate, { policy: finalPolicy }) });
        if (!renewed.allowed || latest.authorizationVersion !== ticket.authorizationVersion) throw fail('ACTION_MANDATE_REVOKED', '动作提交前授权已变化');
        exec.signal.throwIfAborted();
        return { profileId: store.profileId, actorId: ticket.mandate.actorId, ticketId: ticket.id, assignmentId: assignment.id, runId: run.id,
          authorizationVersion: String(ticket.authorizationVersion ?? ticket.mandate.authorizationVersion ?? 1), policyVersion: policy[versionKey],
          principal: ticket.mandate.source?.channel === 'desktop' && ticket.mandate.actorId === 'desktop-owner' ? { kind: 'owner' } : { kind: 'channel-user', id: ticket.mandate.actorId } };
      };
      const service = createExternalActionService({ store, registry, getContext, requestApproval: request => {
        // The official service appends approval/asked synchronously before its
        // answerer waterfall waits. Reminder failures never alter that promise.
        const outcome = requestExternalActionApproval(scope, request);
        if (onApprovalPending) void Promise.resolve().then(() => onApprovalPending({ assignmentId: assignment.id,
          runId: run.id, sessionId: run.sessionId, callId: request.exec.callId, actionId: request.action.id }))
          .catch(error => ctx.logger?.warn?.(`SuperAgent 审批提醒未入信：${error.code || error.name}`));
        return outcome;
      } });
      return installExternalActionTools(scope, agent, { service });
    },
  };
}
