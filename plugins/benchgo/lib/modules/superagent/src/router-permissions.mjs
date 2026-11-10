// Exact upstream contracts, never guessed prefixes, annotations or tool arguments.
// Interaction (ask_user_question) and Schedule tools are the Router's own coordination
// operations: it decides when to use them, so a host re-registration never revokes them.
const coordination = new Set(['ask_user_question', 'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']);
const refreshingRestrictions = new WeakSet();
const denied = name => Object.assign(new Error(`Router 不直接执行 ${name}；调查、文件和执行操作请自动使用 assistant_delegate 交给 Worker，不需要额外询问是否创建工单。提问选项（ask_user_question）与定时任务可直接使用。`), { code: 'ROUTER_TICKET_REQUIRED' });

/** Capture definitions, so a later same-name registration cannot inherit trust. */
export function captureRouterTools(tools, agent) {
  return new Map(tools.schemas(agent).map(({ name }) => [name, tools.get(name, agent)]));
}

/**
 * Install the Router permission gate.
 *
 * A call routed to another agent passes through untouched: it is decided by that
 * agent's own gate, not this one. Denied tools name the delegation path rather
 * than their own identity, because inherited tools are hidden from the model.
 */
export function installRouterPermissionGate(scope, { agent, inherited, controlled, executor }) {
  const approved = new Set();
  for (const [name, definition] of controlled) {
    if (inherited.get(name) !== definition) approved.add(definition);
  }
  // Hide inherited execution tools, while retaining the dispatch identity guard
  // for preset-local definitions and later same-name replacements.
  const contextTools = () => scope.get?.('benchgoEfficiency')?.contextTools?.() ?? [];
  const permits = (name, definition) => Boolean(definition && (coordination.has(name)
    || approved.has(definition)
    || contextTools().some(row => row.name === name && row.definition === definition)));
  // Official restrictions exempt tools registered in this agent's own scope.
  // OPS publishes there after setup, so filter the selected executor's model
  // description as well as enforcing the same identity boundary at dispatch.
  if (executor) scope.tools.setExecutor({
    ...(executor.sections ? { sections: executor.sections } : {}),
    describe: definitions => executor.describe(definitions.filter(definition => permits(definition.name, definition))),
    execute: input => executor.execute(input),
  });
  const restrictionOwner = scope.root ?? scope;
  let restriction;
  const restrict = () => {
    // Restriction changes also emit tools/change. Other Routers in this root
    // update on the original event, not recursively on each other's masks.
    if (refreshingRestrictions.has(restrictionOwner)) return;
    refreshingRestrictions.add(restrictionOwner);
    try {
      // Read after lifting our own mask: an absent/re-registered coordination
      // tool must not become permanently hidden by that previous mask.
      restriction?.(); restriction = undefined;
      const allow = [...new Set([...inherited.keys()].filter(name => coordination.has(name) && scope.tools.get(name, agent))
        .concat(contextTools().filter(row => scope.tools.get(row.name, agent) === row.definition).map(row => row.name)))];
      restriction = scope.tools.restrict?.({ allow });
    }
    finally { refreshingRestrictions.delete(restrictionOwner); }
  };
  restrict();
  if (typeof scope.get === 'function') { scope.on('tools/change', restrict); scope.effect?.(() => () => restriction?.()); }
  return scope.on('tools/execute', async (execution, next) => {
    execution.signal.throwIfAborted();
    // Dispatch scoping can deliver this listener another agent's call when the
    // executor and the host loaded different official copies. That call belongs
    // to another router scope; leaving it alone lets its own gate decide instead
    // of rejecting it here. Ownership checks inside each tool still apply.
    if (execution.agent !== agent) return next();
    const definition = scope.tools.get(execution.name, execution.agent, execution.toolSet);
    if (!permits(execution.name, definition)) throw denied(execution.name);
    return next();
  });
}
