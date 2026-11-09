const LOADING = Object.freeze({ phase: 'loading', role: null, error: '' });
const ORDINARY = Object.freeze({ phase: 'ready', role: null, error: '' });
const ordinarySource = { getSnapshot: () => ORDINARY, subscribe: () => () => {}, refresh: () => {} };

function roleResponse(value, sessionId) {
  if (!value || !Object.hasOwn(value, 'role')) throw new Error('角色查询未返回会话归属');
  const role = value.role;
  if (role !== null && (role?.sessionId !== sessionId
    || !['router', 'worker', 'child-worker'].includes(role.role)
    || !['pending', 'ready', 'blocked'].includes(role.status))) throw new Error('角色查询返回了不匹配的会话归属');
  return role;
}

/** A read-only view of server ownership. No inferred roles or selector writes. */
export function createSessionRoleDirectory(read, { timeoutMs = 15000 } = {}) {
  const sources = new Map();
  let disposed = false;
  function sourceFor(sessionId) {
    if (!sessionId) return ordinarySource; // Unbound official new-session staging stays official.
    if (sources.has(sessionId)) return sources.get(sessionId);
    let state = LOADING, pending, controller, timer, generation = 0, queued = false;
    const listeners = new Set();
    const publish = value => { state = value; for (const listener of listeners) listener(); };
    const cancel = () => { generation++; controller?.abort(); clearTimeout(timer); pending = undefined; queued = false; };
    const refresh = ({ reset = false, defer = false } = {}) => {
      if (disposed || !listeners.size) return;
      if (reset) { cancel(); publish(LOADING); }
      if (defer) return;
      if (pending) { queued = true; return pending; }
      controller = new AbortController();
      const signal = controller.signal, token = ++generation;
      if (state.phase === 'error') publish(LOADING);
      timer = setTimeout(() => {
        if (disposed || generation !== token) return;
        cancel(); publish({ phase: 'error', role: state.role, error: '角色查询超时，请重试' });
      }, timeoutMs);
      pending = Promise.resolve().then(() => read(sessionId, signal)).then(value => {
        if (!disposed && !signal.aborted && generation === token) publish({ phase: 'ready', role: roleResponse(value, sessionId), error: '' });
      }).catch(error => {
        if (!disposed && !signal.aborted && generation === token) publish({ phase: 'error', role: state.role, error: error?.message || '无法读取会话角色' });
      }).finally(() => {
        if (generation !== token) return;
        clearTimeout(timer);
        pending = undefined;
        if (queued) { queued = false; void refresh(); }
      });
      return pending;
    };
    const source = {
      sessionId, getSnapshot: () => state, refresh,
      subscribe(listener) {
        listeners.add(listener);
        if (listeners.size === 1) void refresh();
        return () => {
          listeners.delete(listener);
          // React can resubscribe in the same commit; do not restart that request.
          queueMicrotask(() => { if (!listeners.size) { cancel(); state = LOADING; } });
        };
      },
      active: () => listeners.size > 0,
      dispose() { cancel(); listeners.clear(); },
    };
    sources.set(sessionId, source);
    return source;
  }
  return {
    sourceFor,
    active: () => [...sources.values()].filter(source => source.active()),
    refresh: options => { for (const source of sources.values()) if (source.active()) void source.refresh(options); },
    dispose() { disposed = true; for (const source of sources.values()) source.dispose(); sources.clear(); },
  };
}

/** Gate a private official child slot so even the incumbent's inject stays dormant until ordinary. */
export function shadowSessionControl(slots, name, id, wrap) {
  return slots.inject(name, () => {
    let original, remove;
    const own = new WeakSet();
    const reconcile = () => {
      const next = slots.entries(name).find(entry => !own.has(entry.component) && (id === undefined || entry.options.id === id));
      if (next === original) return;
      remove?.(); remove = undefined; original = next;
      if (!next) return;
      // These public control slots are leaves. Do not steal child-slot ownership if upstream changes.
      if (next.children && Object.keys(next.children).length) throw new Error(`角色控件接缝已变更：${name}`);
      const child = `benchgo.superagent.role-control.${id ?? name}`;
      const component = wrap(child);
      own.add(component);
      const removeParent = slots.register({ name, ...next.options, priority: (next.options.priority ?? 0) - 1,
        children: { [child]: { kind: 'single', scope: name === 'conversation.hero.agentPreset' ? 'session-maybe' : 'session' } } }, component);
      try {
        const removeChild = slots.register({ name: child, inject: next.inject, locale: next.locale, store: next.store }, next.component);
        remove = () => { removeChild(); removeParent(); };
      } catch (error) { removeParent(); throw error; }
    };
    const unsubscribe = slots.subscribe(name, reconcile);
    reconcile();
    return () => { unsubscribe(); remove?.(); };
  });
}
