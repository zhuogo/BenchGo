export function remoteExecutionFixture() {
  const global = new Map(), sessions = new Map(), instances = [], modelCalls = [], logs = new Map();
  const archivedSessions = new Set();
  let stopBarrier;
  const register = (map, event, listener) => { const rows = map.get(event) || []; rows.push(listener); map.set(event, rows); return () => map.set(event, rows.filter(row => row !== listener)); };
  const emit = async (map, event, payload, terminal = async () => undefined) => {
    const list = map.get(event) || [];
    const invoke = index => index === list.length ? terminal() : list[index](payload, () => invoke(index + 1));
    return invoke(0);
  };
  const services = {
    commander: { pickerCatalog: { list: async () => ({ routes: [{ tool: 'deepseek', providerId: 'exact-provider', nativeModelId: 'opaque-model/1', name: 'Exact' }] }) } },
    llm: { listProviders: () => [{ id: 'exact-provider' }], listModels: async () => [{ id: 'opaque-model/1', name: 'Exact' }],
      resolveModelInfo: async (provider, id) => ({ provider, id, name: 'Exact' }) },
    workspaceRegistry: {
      list: () => [],
      get archivedSessionIds() { return [...archivedSessions]; },
      async archiveSession(sessionId, { stopActivity } = {}) {
        if (archivedSessions.has(sessionId)) return;
        if (!stopActivity && sessions.has(sessionId)) throw Object.assign(new Error('Active session'), { name: 'WorkspaceActiveSessionError' });
        for (const listener of global.get('domain/changed') || []) listener({ domain: 'workspace', table: '', operation: 'put',
          value: { archivedSessionIds: [...archivedSessions, sessionId] } });
        archivedSessions.add(sessionId);
      },
      async unarchiveSession(sessionId) {
        if (!archivedSessions.has(sessionId)) return;
        for (const listener of global.get('domain/changed') || []) listener({ domain: 'workspace', table: '', operation: 'put',
          value: { archivedSessionIds: [...archivedSessions].filter(id => id !== sessionId) } });
        archivedSessions.delete(sessionId);
      },
    },
    agentPresets: { resolve: async () => ({}), mount: async () => {}, composedPreset: () => 'standard' },
    permissionPresets: { resolve: () => ({ sandbox: 'danger-full-access', approval: 'never' }), set() {} },
    sessionQuery: { readSession: async id => { if (!logs.has(id)) throw Object.assign(new Error('Session absent'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' }); return { events: structuredClone(logs.get(id)) }; } },
    sessionPersistence: { async open(id) { if (!logs.has(id)) throw new Error('Session absent'); return { read: async () => ({ events: structuredClone(logs.get(id)) }), close: async () => {} }; } },
  };
  const create = async ({ sessionId, resumeSessionId, setup }) => {
    const id = sessionId || resumeSessionId, listeners = new Map(), contexts = new Map(), pending = [], steering = [];
    const events = logs.get(id) || []; logs.set(id, events);
    const append = (type, data) => {
      const event = { seq: events.length + 1, time: new Date().toISOString(), type, data };
      events.push(event);
      for (const listener of global.get('session/event') || []) listener(agent.session, event);
    };
    const scope = { get: name => services[name], tools: { setExecutor() {} }, systemPrompt: { context({ name, text }) { contexts.set(name, text); }, section({ name, text }) { contexts.set(name, text); } }, on: (event, listener) => register(listeners, event, listener) };
    const agent = { id, session: { id, header: { id, origin: 'user' }, snapshotEvents: () => structuredClone(events) },
      model: { select: value => modelCalls.push(value) },
      followup(message) { pending.push(message); void emit(listeners, 'agent/status', { status: 'running' }); },
      steer(message) { steering.push(message.id); this.followup(message); },
      cancel() { append('turn/end', { reason: { kind: 'cancelled' } }); void emit(listeners, 'agent/status', { status: 'idle' }); },
      whenIdle: async () => {},
    };
    const publication = await setup(scope, agent); publication?.commit?.();
    const instance = { agent, listeners, contexts, pending, steering, append, events,
      async step(boundary) {
        const payload = { agent, messages: [...pending], signal: new AbortController().signal };
        const claimed = [...pending];
        const decision = await emit(global, 'agent/pre-step', payload, () => emit(listeners, 'agent/pre-step', payload, async () => { await boundary?.(); return { kind: 'enter', messages: claimed }; }));
        if (decision.kind === 'enter') { const ids = new Set(decision.messages.map(message => message.id)); for (let index = pending.length - 1; index >= 0; index--) if (ids.has(pending[index].id)) append('user/message', pending.splice(index, 1)[0]); }
        else { append('turn/end', { reason: { kind: 'blocked' } }); await emit(listeners, 'agent/status', { status: 'idle' }); }
        return decision;
      },
      async finish(kind = 'completed') { append('assistant/message', { message: { content: [{ type: 'text', text: 'Actual execution result' }] } }); append('turn/end', { reason: { kind } }); await emit(listeners, 'agent/status', { status: 'idle' }); },
      async question(questions = [{ id: 'q-one', question: 'Which file?' }]) { return emit(listeners, 'user-questions/request', { agent, questions, wait: { callId: 'official-call' } }); },
      async tool(name) { return emit(listeners, 'tools/pre-execute', { agent, name }, async () => ({ kind: 'allow' })); },
      async requestModel() { return emit(listeners, 'agent/request', {}, async () => ({ provider: 'wrong', model: 'wrong', temperature: 2, maxTokens: 999, tools: [] })); },
      async dispose() { if (stopBarrier) await stopBarrier; instance.disposed = true; sessions.delete(id); },
    };
    instances.push(instance); sessions.set(id, agent);
    return { agent, dispose: () => instance.dispose() };
  };
  services.agents = { create, resume: create, get: id => sessions.get(id) };
  return { ctx: { get: name => services[name], on: (event, listener) => register(global, event, listener) }, services, instances, modelCalls, logs,
    publish(event, ...args) { for (const listener of global.get(event) || []) listener(...args); },
    setStopBarrier(value) { stopBarrier = value; },
    async rawStep(agent, messages) { return emit(global, 'agent/pre-step', { agent, messages }, async () => ({ kind: 'enter', messages })); },
  };
}
