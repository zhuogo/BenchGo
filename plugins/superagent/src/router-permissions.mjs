// Exact upstream contracts, never guessed prefixes, annotations or tool arguments.
// Interaction (ask_user_question) and Schedule tools are the Router's own coordination
// operations: it decides when to use them, so a host re-registration never revokes them.
const coordination = new Set(['ask_user_question', 'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']);
const denied = name => Object.assign(new Error(`Router 不直接执行 ${name}；调查、文件和执行操作请自动使用 assistant_delegate 交给 Worker，不需要额外询问是否创建工单。提问选项（ask_user_question）与定时任务可直接使用。`), { code: 'ROUTER_TICKET_REQUIRED' });

/** Capture definitions, so a later same-name registration cannot inherit trust. */
export function captureRouterTools(tools, agent) {
  return new Map(tools.schemas(agent).map(({ name }) => [name, tools.get(name, agent)]));
}

/** Host-owned setupTools registrations enforce their own configuration/admission contracts. */
export function installRouterPermissionGate(scope, { agent, inherited, controlled }) {
  const approved = new Set();
  for (const [name, definition] of controlled) {
    if (inherited.get(name) !== definition) approved.add(definition);
  }
  // Hide inherited execution tools, while retaining the dispatch identity guard
  // for preset-local definitions and later same-name replacements.
  scope.tools.restrict?.({ allow: [...inherited.keys()].filter(name => coordination.has(name)) });
  return scope.on('tools/execute', async (execution, next) => {
    execution.signal.throwIfAborted();
    if (coordination.has(execution.name)) return next();
    const definition = scope.tools.get(execution.name, execution.agent);
    if (execution.agent !== agent || !definition || !approved.has(definition)) throw denied(execution.name);
    return next();
  });
}
