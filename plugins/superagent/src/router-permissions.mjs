// Exact upstream contracts, never guessed prefixes, annotations or tool arguments.
// Official Schedule tools are session-scoped coordination operations.
const coordination = new Set(['ask_user_question', 'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']);
const denied = () => Object.assign(new Error('Router 只负责协调与直接回答；调查、文件和执行操作请自动使用 assistant_delegate 交给 Worker，不需要额外询问是否创建工单。'), { code: 'ROUTER_TICKET_REQUIRED' });

/** Capture definitions, so a later same-name registration cannot inherit trust. */
export function captureRouterTools(tools, agent) {
  return new Map(tools.schemas(agent).map(({ name }) => [name, tools.get(name, agent)]));
}

/** Host-owned setupTools registrations enforce their own configuration/admission contracts. */
export function installRouterPermissionGate(scope, { agent, inherited, controlled }) {
  const approved = new Set();
  for (const [name, definition] of inherited) {
    if (coordination.has(name)) approved.add(definition);
  }
  for (const [name, definition] of controlled) {
    if (inherited.get(name) !== definition) approved.add(definition);
  }
  // Hide inherited execution tools, while retaining the dispatch identity guard
  // for preset-local definitions and later same-name replacements.
  scope.tools.restrict?.({ allow: [...inherited.keys()].filter(name => coordination.has(name)) });
  return scope.on('tools/execute', async (execution, next) => {
    execution.signal.throwIfAborted();
    const definition = scope.tools.get(execution.name, execution.agent);
    if (execution.agent !== agent || !definition || !approved.has(definition)) throw denied();
    return next();
  });
}
