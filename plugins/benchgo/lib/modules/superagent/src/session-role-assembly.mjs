const fail = (code, message) => Object.assign(new Error(message), { code });
export const SUPERAGENT_ROLE_PROFILE = Object.freeze({ agentPreset: 'standard', permissionPreset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' });
const service = (scope, name) => scope.get ? scope.get(name) : scope[name];
const liveRoles = new WeakMap();
export const liveSessionRole = agent => liveRoles.get(agent);

/** Compose capabilities, host permission and the existing model route independently. */
export async function createSessionRoleAssembly({ ctx, database, identity }) {
  if (!database?.bindSessionRole) throw fail('SESSION_ROLE_STORE_UNAVAILABLE', 'SuperAgent 持久角色账不可用');
  const expected = { ...SUPERAGENT_ROLE_PROFILE };
  const record = database.bindSessionRole({ ...identity, expected });
  const presets = service(ctx, 'agentPresets');
  let agent, scope;
  let observed = record.actual;
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
      tools: service(scope, 'tools')?.schemas(agent).map(row => row.name).sort() ?? [], model: agent.model.current() ?? null };
  };
  const blocked = error => {
    database.recordSessionRole(identity.sessionId, { status: 'blocked', actual: snapshot(), reason: { code: error.code || 'ROLE_ASSEMBLY_FAILED', message: error.message } });
    return error;
  };
  const requireServices = () => {
    if (!presets?.resolve || !presets?.select || !presets?.mount || !presets?.presetForSession || !service(scope || ctx, 'permissionPresets')?.set
      || !service(scope || ctx, 'sandboxPolicy')?.resolve || !service(scope || ctx, 'approval')?.overrideOf)
      throw fail('ROLE_SERVICES_UNAVAILABLE', '官方角色预设、沙箱或审批服务不可用，不能确认实际权限');
  };
  const observe = (request, { committed = false } = {}) => {
    const actual = request && observed ? { ...observed } : snapshot();
    const previous = observed;
    if (previous?.requestModel) actual.requestModel = previous.requestModel;
    if (previous?.requestTools) actual.requestTools = previous.requestTools;
    if (previous?.proposedModel) actual.proposedModel = previous.proposedModel;
    if (request) {
      actual[committed ? 'requestModel' : 'proposedModel'] = { provider: request.provider, model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }) };
      if (committed && Array.isArray(request.tools)) actual.requestTools = request.tools.map(tool => tool.name).filter(Boolean).sort();
    }
    observed = actual;
    return database.recordSessionRole(identity.sessionId, { status: 'ready', actual });
  };
  const reconcile = async () => {
    try {
      requireServices();
      const boundary = ctx.agents.turnBoundaryOf(agent.session);
      const started = boundary.lastTurn > 0 || boundary.openTurnStartSeq !== null;
      const recorded = presets.presetForSession(agent.session);
      // Official presets cannot be switched after a turn. Resume the saved preset
      // in place instead of blocking history or recreating/replaying the session.
      const selected = started ? recorded || expected.agentPreset : expected.agentPreset;
      const resolved = await presets.resolve(selected);
      if (resolved.broken) throw fail('ROLE_PRESET_UNAVAILABLE', resolved.broken);
      if (presets.composedPreset(scope) !== selected) await presets.mount(scope, selected);
      if (!started && recorded !== selected) await presets.select(agent, selected);
      {
        const permissions = service(scope, 'permissionPresets'), bundle = permissions.resolve(expected.permissionPreset);
        if (bundle.sandbox !== expected.sandbox || bundle.approval !== expected.approval)
          throw fail('ROLE_PERMISSION_BUNDLE_INVALID', '角色 permission preset 的实际 bundle 不是 workspace-write + ask');
        // Official set writes only knobs. It does not answer, cancel or replace pending approvals.
        permissions.set(agent.session, expected.permissionPreset);
      }
      return observe();
    } catch (error) { throw blocked(error); }
  };
  return {
    expected, record,
    async mount(agentScope, value) {
      scope = agentScope; agent = value;
      try {
        requireServices();
        await reconcile();
        liveRoles.set(agent, Object.freeze({ sessionId: agent.id, role: identity.role, reconcile }));
        scope.effect?.(() => () => liveRoles.delete(agent));
        scope.on('session/event', (session, event) => {
          if (session !== agent.session) return;
          if (event.type === 'request/header') observe({ ...event.data.header.config, tools: event.data.header.tools || [] }, { committed: true });
        });
      } catch (error) { throw blocked(error); }
    },
    reconcile,
    observe,
  };
}
