import { isReadOnlyWorkerTool } from './execution-effects.mjs';
const fail = (code, message) => Object.assign(new Error(message), { code });
export const SUPERAGENT_ROLE_PROFILE = Object.freeze({ agentPreset: 'standard', permissionPreset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' });
const service = (scope, name) => scope.get?.(name) ?? scope[name];
const liveRoles = new WeakMap();
export const liveSessionRole = agent => liveRoles.get(agent);

/** Compose capabilities, host permission and the existing model route independently. */
export async function createSessionRoleAssembly({ ctx, database, identity, parent }) {
  if (!database?.bindSessionRole) throw fail('SESSION_ROLE_STORE_UNAVAILABLE', 'SuperAgent 持久角色账不可用');
  const expected = parent ? { ...parent.expected, sandbox: parent.actual?.sandbox, approval: 'never', permissionPreset: 'custom', delegationApproval: 'parent-required' } : { ...SUPERAGENT_ROLE_PROFILE };
  const record = database.bindSessionRole({ ...identity, expected });
  const presets = service(ctx, 'agentPresets');
  let agent, scope;
  let childApprovalBlocker = parent && record.reason?.code === 'CHILD_APPROVAL_PARENT_REQUIRED' ? record.reason : null;
  const snapshot = () => {
    if (!agent) return null;
    const sandbox = service(scope, 'sandboxPolicy')?.resolve({ session: agent.session });
    const approval = service(scope, 'approval');
    return { agentPreset: presets?.composedPreset(scope) ?? null,
      plugins: presets?.inspectCompositions(scope)?.flatMap(row => row.modules) ?? [],
      recordedAgentPreset: presets?.presetForSession(agent.session) ?? null,
      permissionPreset: service(scope, 'permissionPresets')?.current(agent.session) ?? null,
      sandbox: sandbox?.mode ?? null, workspaceRoot: sandbox?.workspaceRoot ?? null,
      additionalWritableRoots: sandbox?.additionalWritableRoots ?? [],
      approval: approval ? approval.overrideOf(agent.session) ?? approval.config.policy ?? 'ask' : null,
      tools: scope.tools.schemas(agent).map(row => row.name).sort(), model: agent.model.current() ?? null,
      ...(parent ? { delegationApproval: 'parent-required' } : {}) };
  };
  const blocked = error => {
    database.recordSessionRole(identity.sessionId, { status: 'blocked', actual: snapshot(), reason: { code: error.code || 'ROLE_ASSEMBLY_FAILED', message: error.message } });
    return error;
  };
  const requireServices = () => {
    if (!presets?.select || !presets?.mount || !presets?.presetForSession || !service(scope || ctx, 'permissionPresets')?.set
      || !service(scope || ctx, 'sandboxPolicy')?.resolve || !service(scope || ctx, 'approval')?.overrideOf)
      throw fail('ROLE_SERVICES_UNAVAILABLE', '官方角色预设、沙箱或审批服务不可用，不能确认实际权限');
  };
  try {
    // Resolve only the explicit role configuration: never inherit the user's selector/default.
    if (!presets?.resolve) throw fail('ROLE_SERVICES_UNAVAILABLE', '官方 Agent preset 服务不可用');
    const resolved = await presets.resolve(expected.agentPreset);
    if (resolved.broken) throw fail('ROLE_PRESET_UNAVAILABLE', resolved.broken);
  } catch (error) { throw blocked(error); }
  const observe = (request, { committed = false } = {}) => {
    const actual = snapshot();
    const previous = database.getSessionRole(identity.sessionId)?.actual;
    if (previous?.requestModel) actual.requestModel = previous.requestModel;
    if (previous?.requestTools) actual.requestTools = previous.requestTools;
    if (previous?.proposedModel) actual.proposedModel = previous.proposedModel;
    if (request) {
      actual[committed ? 'requestModel' : 'proposedModel'] = { provider: request.provider, model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }) };
      if (committed && Array.isArray(request.tools)) actual.requestTools = request.tools.map(tool => tool.name).filter(Boolean).sort();
    }
    return database.recordSessionRole(identity.sessionId, { status: childApprovalBlocker ? 'blocked' : 'ready', actual, reason: childApprovalBlocker });
  };
  const verify = () => {
    requireServices();
    const actual = snapshot();
    if (actual.agentPreset !== expected.agentPreset || actual.recordedAgentPreset !== expected.agentPreset)
      throw fail('ROLE_CONFIGURATION_CHANGED', '会话实际 Agent preset 与持久角色不一致');
    if (actual.sandbox !== expected.sandbox || actual.approval !== expected.approval)
      throw fail('ROLE_CONFIGURATION_CHANGED', '会话实际沙箱或审批策略与持久角色不一致');
    return actual;
  };
  const reconcile = async () => {
    try {
      requireServices();
      const boundary = ctx.agents.turnBoundaryOf(agent.session);
      const started = boundary.lastTurn > 0 || boundary.openTurnStartSeq !== null;
      if (presets.presetForSession(agent.session) !== expected.agentPreset || presets.composedPreset(scope) !== expected.agentPreset) {
        if (started) throw fail('ROLE_MIGRATION_UNAVAILABLE', '已运行会话的 Agent preset 与角色不一致；当前官方 API 不支持保留原会话的运行后迁移，原历史与待办已保留，未重放动作');
        await presets.select(agent, expected.agentPreset);
      }
      if (!parent) {
        const permissions = service(scope, 'permissionPresets'), bundle = permissions.resolve(expected.permissionPreset);
        if (bundle.sandbox !== expected.sandbox || bundle.approval !== expected.approval)
          throw fail('ROLE_PERMISSION_BUNDLE_INVALID', '角色 permission preset 的实际 bundle 不是 workspace-write + ask');
        // Official set writes only knobs. It does not answer, cancel or replace pending approvals.
        permissions.set(agent.session, expected.permissionPreset);
      }
      verify(); return observe();
    } catch (error) { throw blocked(error); }
  };
  return {
    expected, record,
    async mount(agentScope, value) {
      scope = agentScope; agent = value;
      try {
        requireServices();
        const boundary = ctx.agents.turnBoundaryOf(agent.session);
        const recorded = presets.presetForSession(agent.session);
        if ((boundary.lastTurn > 0 || boundary.openTurnStartSeq !== null) && recorded !== expected.agentPreset)
          throw fail('ROLE_MIGRATION_UNAVAILABLE', '已运行旧会话无法通过官方 API 原地更换 Agent preset；已保留原会话、工单与待办，未重放');
        if (!parent) await presets.mount(scope, expected.agentPreset);
        await reconcile();
        liveRoles.set(agent, Object.freeze({ sessionId: agent.id, role: identity.role, reconcile }));
        scope.effect?.(() => () => liveRoles.delete(agent));
        scope.on('agent/pre-step', async (_payload, next) => { await reconcile(); return next(); }, { prepend: true });
        scope.on('tools/pre-execute', (execution, next) => {
          if (execution.agent !== agent) return next();
          try { verify(); } catch (error) { throw blocked(error); }
          if (childApprovalBlocker && execution.name !== 'send_message' && !isReadOnlyWorkerTool(execution.name))
            throw fail(childApprovalBlocker.code, childApprovalBlocker.message);
          return next();
        }, { prepend: true });
        scope.on('agent/request', async (_payload, next) => {
          const request = await next();
          try { verify(); observe(request); } catch (error) { throw blocked(error); }
          return request;
        });
        scope.on('session/event', (session, event) => {
          if (session !== agent.session) return;
          if (event.type === 'request/header') observe({ ...event.data.header.config, tools: event.data.header.tools || [] }, { committed: true });
          if (parent && event.type === 'approval/decided' && event.data.outcome === 'rejected') {
            // The original official audit retains the exact reason. Keep its identity,
            // not another copy of possibly sensitive command arguments, in this projection.
            childApprovalBlocker = { code: 'CHILD_APPROVAL_PARENT_REQUIRED', requestId: event.data.id,
              message: '子 Worker 的官方审批策略已拒绝动作；停止变体重试，向父 Worker 回报原审批记录并经父级通道处理' };
            observe();
          }
        });
      } catch (error) { throw blocked(error); }
    },
    reconcile,
    observe,
  };
}
