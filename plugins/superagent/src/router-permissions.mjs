import { hostRootContext } from '../../base/shared/host-root-context.mjs';
import { fallbackCallSignature } from './model-fallback.mjs';
import { isChatUserMessage } from './question-reply.mjs';

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
export function installRouterPermissionGate(scope, { agent, inherited, controlled, executor, toolsClosed = () => false }) {
  const approved = new Set();
  for (const [name, definition] of controlled) {
    if (inherited.get(name) !== definition) approved.add(definition);
  }
  const contextTools = () => scope.get?.('benchgoEfficiency')?.contextTools?.() ?? [];
  const permits = (name, definition) => Boolean(!toolsClosed() && definition && (coordination.has(name)
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
  let restriction, allowedNames, disposed = false;
  // Cordis clears uid before unloading effects; state 5 also covers restart
  // teardown. Sibling cleanup can emit tools/change before our listener leaves.
  const active = () => !disposed && scope.fiber?.uid !== null && scope.fiber?.state !== 5;
  const restrict = () => {
    // Mask changes emit tools/change too. Other Routers update on the original
    // event rather than recursively refreshing each other's restrictions.
    if (!active() || refreshingRestrictions.has(restrictionOwner)) return;
    refreshingRestrictions.add(restrictionOwner);
    try {
      // Read global definitions without lifting our own mask. Context tools may
      // have just appeared and are still hidden by the previous allow list.
      const allow = [...new Set([...inherited.keys()].filter(name => coordination.has(name)
        && (scope.tools.get(name) || scope.tools.get(name, agent)))
        .concat(contextTools().filter(row => scope.tools.get(row.name) === row.definition).map(row => row.name)))];
      if (allowedNames && allow.length === allowedNames.size && allow.every(name => allowedNames.has(name))) return;
      const previous = restriction;
      // Keep the old mask until its replacement is installed. Registry observers
      // must never see a temporarily unrestricted Router during a real change.
      restriction = scope.tools.restrict?.({ allow });
      allowedNames = new Set(allow);
      previous?.();
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

/** Give the model one final response after closing tool execution for this instruction. */
export function installRouterFailureConvergence(scope, agent) {
  const immediate = new Set(['PROFILE_CONFIG_DIRECT_WRITE', 'PROFILE_CONFIG_RESTORED', 'MANDATE_REVOKED']);
  const structural = new Set(['ENOSPC', 'EDQUOT', 'EROFS',
    'ROLE_SERVICES_UNAVAILABLE', 'ROLE_PRESET_UNAVAILABLE', 'SESSION_ROLE_STORE_UNAVAILABLE',
    'MANAGEMENT_OWNER_REQUIRED', 'MANAGEMENT_APPROVAL_UNAVAILABLE', 'MANAGEMENT_APPROVAL_DENIED', 'APPROVAL_POLICY_NEVER', 'SETTINGS_UNAVAILABLE', 'CLEANUP_UNAVAILABLE']);
  const archiveWrites = new Set(['assistant_session_archive_apply', 'assistant_session_archive_official']);
  const archiveTools = new Set([...archiveWrites, 'assistant_session_archive_preview']);
  const archiveQueries = new Set([...archiveTools, 'assistant_projects', 'assistant_sessions']);
  const archiveInputErrors = new Set(['MANAGEMENT_INPUT', 'SESSION_ARCHIVE_SCOPE']);
  let prior, stopped, archive, archiveReply, replyStarted;
  const rejectedInputs = new Map();
  const admittedUsers = new Set(), failures = new Map();
  const reset = () => {
    prior = stopped = archive = archiveReply = replyStarted = undefined;
    rejectedInputs.clear();
  };
  const admit = message => {
    if (!isChatUserMessage(message) || admittedUsers.has(message.id)) return;
    admittedUsers.add(message.id);
    reset();
  };
  scope.on('agent/inbox/claimed', ({ message }) => admit(message));
  scope.on('tools/execute', async (execution, next) => {
    if (execution.agent !== agent) return next();
    const { name, callId } = execution;
    const isArchive = archiveTools.has(name);
    const signature = isArchive || name === 'assistant_projects' ? fallbackCallSignature(name, execution.arguments) : undefined;
    const previous = rejectedInputs.get(signature);
    if (previous) {
      execution.signal.throwIfAborted();
      const message = `${previous.message}。本轮未再次执行，请修改参数后再调用`;
      return { isError: true, error: { ...previous, message }, content: [{ type: 'text', text: `Error: ${message}` }] };
    }
    try { return await next(); }
    catch (error) { if (error?.code) failures.set(callId, error.code); throw error; }
  });
  scope.on('tools/result', (execution, result) => {
    if (execution.agent !== agent) return;
    const failure = failures.get(execution.callId);
    failures.delete(execution.callId);
    const message = result.error?.message || (result.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    const structuredCode = result.error?.info?.code ?? result.error?.code ?? failure;
    const code = structuredCode ?? /^([A-Z_]+): /.exec(message)?.[1];
    const name = execution.name;
    const errorInfo = result.error?.info;
    if (result.isError && (archiveTools.has(name) && archiveInputErrors.has(errorInfo?.code)
      || name === 'assistant_projects' && errorInfo?.code === 'PROJECTS_SCOPE_CONFLICT')) {
      const signature = fallbackCallSignature(name, execution.arguments);
      if (!rejectedInputs.has(signature)) {
        if (rejectedInputs.size >= 32) rejectedInputs.delete(rejectedInputs.keys().next().value);
        rejectedInputs.set(signature, { info: errorInfo, message });
      }
    }
    if (archiveTools.has(name)) archive ??= { calls: 0, seen: new Map() };
    if (archive && archiveQueries.has(name) && !replyStarted) {
      if (result.isError) archive.lastError = { tool: name, code: code ?? null, message: message.slice(0, 1000) };
      if (archiveWrites.has(name) && !result.isError) {
        try { archive.receipt = JSON.parse(message); } catch { /* Ignore non-receipt output. */ }
      }
      if (!archiveReply) {
        const signature = fallbackCallSignature(name, execution.arguments);
        const repeats = (archive.seen.get(signature) ?? 0) + 1;
        archive.seen.set(signature, repeats);
        const calls = ++archive.calls;
        const invalidOutput = archiveTools.has(name) && code === 'INVALID_TOOL_OUTPUT';
        if (invalidOutput || calls >= 8 || repeats >= 3) {
          archiveReply = { reason: invalidOutput ? code : repeats >= 3 ? 'REPEATED_CALL' : 'CALL_LIMIT', calls, repeatedCalls: repeats };
        }
      }
    }
    if (!result.isError || (!structural.has(code) && !immediate.has(code))) { prior = undefined; return; }
    if (immediate.has(code)) stopped = { code, message, toolName: execution.name, callId: execution.callId };
    else if (prior?.code === code && prior.message === message) stopped = prior;
    else prior = { code, message, toolName: execution.name, callId: execution.callId };
  });
  scope.on('agent/pre-step', (payload, next) => {
    if (payload.agent !== agent) return next();
    for (const message of payload.messages || []) admit(message);
    if (stopped || archiveReply) {
      if (replyStarted) return { kind: 'reject' };
      replyStarted = true;
    }
    return next();
  });
  scope.on('agent/status', ({ agent: current, status }) => {
    if (current === agent && status === 'idle') reset();
  });
  return () => stopped
    ? { reason: stopped.code, error: stopped, receipt: archive?.receipt ?? null }
    : archiveReply && { ...archiveReply, error: archive.lastError ?? null, receipt: archive.receipt ?? null };
}
