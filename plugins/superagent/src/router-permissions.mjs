import { hostRootContext } from '../../base/shared/host-root-context.mjs';

// Exact upstream contracts, never guessed prefixes, annotations or tool arguments.
// Interaction and Schedule tools remain the Router's own coordination operations.
const coordination = new Set(['ask_user_question', 'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']);
const refreshingRestrictions = new WeakSet();
const contextDescriptions = {
  context_status: 'Read estimated current context usage and window capacity when needed to decide whether to compact. The estimate adjusts the latest provider usage for tracked history changes, or uses history alone before the first usage sample. Routine checks after every step are unnecessary.',
  compact_now: 'Compact older conversation history when remaining capacity may not comfortably fit upcoming work, preferably at a safe task boundary. Compaction may call a model, take time, and lose details; avoid unnecessary or speculative calls. It may do nothing if there is not enough compactable history.',
};
const denied = name => Object.assign(new Error(`Router 不直接执行 ${name}；调查、文件和执行操作统一使用 assistant_delegate；远端资源通过 deviceId 选择执行设备，业务工单始终由本机持有，不需要额外询问是否创建任务。提问选项（ask_user_question）与定时任务可直接使用。`), { code: 'ROUTER_TASK_REQUIRED' });

/** Capture definitions so a later same-name registration cannot inherit trust. */
export function captureRouterTools(tools, agent) {
  return new Map(tools.schemas(agent).map(({ name }) => [name, tools.get(name, agent)]));
}

/** Keep Router coordination separate from Worker environment execution. */
export function installRouterPermissionGate(scope, { agent, inherited, controlled, executor }) {
  const approved = new Set();
  for (const [name, definition] of controlled) {
    if (inherited.get(name) !== definition) approved.add(definition);
  }
  const contextTools = () => scope.get?.('benchgoEfficiency')?.contextTools?.() ?? [];
  const permits = (name, definition) => Boolean(definition && (coordination.has(name)
    || approved.has(definition)
    || contextTools().some(row => row.name === name && row.definition === definition)));
  const permittedDefinitions = definitions => definitions.filter(definition => permits(definition.name, definition));
  // Agent-local preset tools bypass official inherited restrictions, so apply
  // the same boundary to model schemas and dispatch, including nested calls.
  if (executor) scope.tools.setExecutor({
    ...(executor.sections ? { sections: executor.sections } : {}),
    describe: definitions => {
      const description = executor.describe(permittedDefinitions(definitions));
      const owned = new Set(contextTools().filter(row => definitions.includes(row.definition)).map(row => row.name));
      return { ...description, schemas: description.schemas.map(schema => owned.has(schema.name) && contextDescriptions[schema.name]
        ? { ...schema, description: contextDescriptions[schema.name] } : schema) };
    },
    execute: input => executor.execute(input),
  });
  scope.on('system-prompt/assemble', async (_assembly, context, next) => {
    const presentation = await next();
    if (context.scope !== agent) return presentation;
    const names = new Set(permittedDefinitions(scope.tools.definitions(agent, context.toolSet)).map(tool => tool.name));
    const hasOps = [...names].some(name => name.startsWith('ops_'));
    const hasExecution = hasOps || names.has('pwsh') || names.has('bash');
    const relevant = section => {
      if (section.name.startsWith('dsh-ops:repository-tooling') || section.name.startsWith('dsh-ops:discovery-tools')) return hasOps;
      const tools = { 'tool:pwsh': ['pwsh'], 'tool:bash': ['bash'],
        'tool:jobs': ['job_output', 'job_kill'], 'tool:goal': ['create_goal', 'update_goal'],
        'tool:workflow': ['workflow'] }[section.name];
      return !tools || tools.some(name => names.has(name));
    };
    return { ...presentation,
      sections: presentation.sections.filter(relevant).map(section => {
        if (section.name === 'harness:source' && !hasExecution) return { ...section, text: 'The runtime context names the implementation checkout, which may differ from the working directory. Pass the relevant target to the Worker when delegating implementation work.' };
        if (section.name === 'app:web-surface' && !hasExecution) return { ...section, text: 'The runtime context names the current Web GUI URL. When the user says "this page", "this GUI", or "this app" without another target, they mean this GUI. No DOM, route or screenshot is implicitly provided. Delegate development work to a Worker; starting another server does not update this GUI.' };
        if (section.name === 'ui:deliverable-file-references' && !names.has('present')) return { ...section, text: 'Show primary results in the final response with a brief explanation. Link existing files using [filename](<full/path>): use absolute paths or full paths relative to the working directory, enclose destinations in angle brackets, and append #L24 for known lines. Keep labels concise. Share Worker deliverable links so the user can open the results. Deliver files as explicit Markdown links, not bare filenames or paths; the client displays linked deliverables separately from the prose bubble. When images are the requested result, show useful previews directly using ![Description](<image-url>) in separate image-only paragraphs; filenames, folders or a summary page alone are not image delivery. Preserve image URLs supplied by the Worker: use HTTP(S) direct image URLs or existing browser-accessible artifact URLs, never local filesystem paths, source webpages or guessed API URLs. Keep source links and available attribution alongside the images; do not invent URLs, downloads or licenses. If no displayable image URL is available, share the available file/source links and explain the preview limitation. A request to find photos does not authorize image generation.' };
        return section;
      }),
    };
  });
  const restrictionOwner = hostRootContext(scope);
  let restriction, disposed = false;
  // Cordis clears uid before unloading effects; state 5 also covers restart
  // teardown. Sibling cleanup can emit tools/change before our listener leaves.
  const active = () => !disposed && scope.fiber?.uid !== null && scope.fiber?.state !== 5;
  const restrict = () => {
    // Mask changes emit tools/change too. Other Routers update on the original
    // event rather than recursively refreshing each other's restrictions.
    if (!active() || refreshingRestrictions.has(restrictionOwner)) return;
    refreshingRestrictions.add(restrictionOwner);
    try {
      const previous = restriction; restriction = undefined;
      previous?.();
      if (!active()) return;
      const allow = [...new Set([...inherited.keys()].filter(name => coordination.has(name) && scope.tools.get(name, agent))
        .concat(contextTools().filter(row => scope.tools.get(row.name, agent) === row.definition).map(row => row.name)))];
      restriction = scope.tools.restrict?.({ allow });
    } finally { refreshingRestrictions.delete(restrictionOwner); }
  };
  restrict();
  if (typeof scope.get === 'function') {
    const stopWatching = scope.on('tools/change', restrict);
    scope.effect?.(() => () => {
      disposed = true;
      stopWatching?.();
      const previous = restriction; restriction = undefined;
      previous?.();
    });
  }
  return scope.on('tools/execute', async (execution, next) => {
    execution.signal.throwIfAborted();
    // Shared dispatch can deliver another agent's call here. Its own scope
    // decides its permissions; this Router must not limit a Worker or sibling.
    if (execution.agent !== agent) return next();
    const definition = scope.tools.get(execution.name, execution.agent, execution.toolSet);
    if (!permits(execution.name, definition)) throw denied(execution.name);
    return next();
  });
}

/** Stop a repeated shared prerequisite failure at the official step boundary.
 * Argument errors remain correctable; successful work or new instructions resets the streak.
 */
export function installRouterFailureConvergence(scope, agent, onStop) {
  const immediate = new Set(['PROFILE_CONFIG_DIRECT_WRITE', 'PROFILE_CONFIG_RESTORED', 'MANDATE_REVOKED']);
  const structural = new Set(['ENOSPC', 'EDQUOT', 'EROFS',
    'ROLE_SERVICES_UNAVAILABLE', 'ROLE_PRESET_UNAVAILABLE', 'SESSION_ROLE_STORE_UNAVAILABLE',
    'MANAGEMENT_OWNER_REQUIRED', 'MANAGEMENT_APPROVAL_UNAVAILABLE', 'MANAGEMENT_APPROVAL_DENIED', 'APPROVAL_POLICY_NEVER', 'SETTINGS_UNAVAILABLE', 'CLEANUP_UNAVAILABLE']);
  let prior, stopped;
  const admittedUsers = new Set(), failures = new Map();
  scope.on('tools/execute', async (execution, next) => {
    try { return await next(); }
    catch (error) { if (execution.agent === agent && error?.code) failures.set(execution.callId, error.code); throw error; }
  });
  scope.on('tools/result', (execution, result) => {
    if (execution.agent !== agent) return;
    const failure = failures.get(execution.callId);
    failures.delete(execution.callId);
    const message = result.error?.message || (result.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    const code = result.error?.info?.code ?? result.error?.code ?? failure ?? /^([A-Z_]+): /.exec(message)?.[1];
    if (!result.isError || (!structural.has(code) && !immediate.has(code))) { prior = undefined; return; }
    if (immediate.has(code)) stopped = { code, message, toolName: execution.name, callId: execution.callId };
    else if (prior?.code === code && prior.message === message) stopped = prior;
    else prior = { code, message, toolName: execution.name, callId: execution.callId };
  });
  scope.on('agent/pre-step', (payload, next) => {
    if (payload.agent !== agent) return next();
    for (const message of payload.messages || []) if (message.source?.kind === 'user' && !admittedUsers.has(message.id)) {
      admittedUsers.add(message.id); stopped = undefined; prior = undefined;
    }
    if (stopped) { onStop(stopped); return { kind: 'reject' }; }
    return next();
  });
}
