import { createContextRedactor } from './context-privacy.mjs';
import { installProjectRules } from './project-rules.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';
import { canFallback } from './routing.mjs';
import { validateAssistantModels } from './store.mjs';
import { recordDesktopTrigger } from './desktop-trigger.mjs';
import { captureRouterTools, installRouterFailureConvergence, installRouterPermissionGate } from './router-permissions.mjs';
import { activeChatReply, installChatPublication, isLegacyExecutionInput } from './chat-publication.mjs';
import { modelFallbackType, modelFallbackSource, modelRouteType, readModelFallbacks, fallbackCallSignature, requestExecutionEvents, dispatchedCallSignatures, isRouterQuery } from './model-fallback.mjs';
import { routerRecoverySource } from './router-recovery.mjs';
import { executionEffects, isReadOnlyTool } from './execution-effects.mjs';
import { isChatUserMessage } from './question-reply.mjs';
import { installRouterQuestions } from './router-questions.mjs';
import { isHostReplyRequest } from '../../base/shared/public-chat-record.mjs';
import { createRouterContext } from './router-context.mjs';

export const routeKey = model => JSON.stringify([model.providerId, model.modelId]);
const copy = value => structuredClone(value);
const replyToolEnabled = (_kind, name) => name === 'assistant_reply';

/** Assembles one Router conversation on its official Agent: model routing and fallback, prompt sections, tools, gates and turn hooks. */
export function createRouterSessionSetup(runtime, { threadId, record, role, recoveredEvidence, presets }) {
  const { ctx, store, now, cooldownMs, builtinLayer, Compaction, appendRecord, appendChatRecord, setupTools, scheduleBridge, onSourceMessage, emit, mark,
    timings, thread, taskOwnerScope, mayReplyToTask, isStopped, cooldowns, errors, failures, models, activeRoutes,
    agentCompaction } = runtime;
  const routerContext = createRouterContext({ store, sessionId: record.sessionId });
  let contextText = '', selection, replyTurn, failedPlan, claimedMessages = [], currentTurn, resumeFallback;
  let replayCalls = new Set();
  const advanceModel = () => {
    if (!selection) return false;
    const nextIndex = selection.models.findIndex((model, index) => index > selection.index && (cooldowns.get(routeKey(model)) ?? 0) <= now());
    if (nextIndex < 0) return false;
    selection.index = nextIndex;
    return true;
  };
  const setup = async (scope, agent) => {
    installRouterFailureConvergence(scope, agent, failure => {
      const message = failure.message;
      errors.set(threadId, message);
      emit({ type: 'error', threadId, message });
      throw Object.assign(new Error(message), { code: failure.code });
    });
    const select = model => agent.model.select({ provider: model.providerId, model: model.modelId,
      ...(model.options?.reasoningEffort === undefined ? {} : { reasoningEffort: model.options.reasoningEffort }) });
    const routes = () => agent.session.snapshotEvents().filter(event => event.type === modelRouteType && event.ignorable === true);
    let expressionRestrictions = [], expressionKind;
    const expressionMode = source => {
      const kind = isHostReplyRequest({ source }) ? source.replyKind === 'watchdog' && source.taskId
        ? 'watchdog-execution' : source.replyKind || 'expression' : undefined;
      if (kind === expressionKind) return;
      for (const dispose of expressionRestrictions) dispose(); expressionRestrictions = []; expressionKind = kind;
      if (!kind) return;
      // Official restrictions mask globals; own scoped tools use their
      // registration-time activation condition instead of duplicate registration.
      expressionRestrictions.push(scope.tools.restrict({ allow: [] }));
    };
    const expressionToolEnabled = name => !expressionKind || replyToolEnabled(expressionKind, name);
    scope.on('tools/execute', async (execution, next) => {
      if (execution.agent === agent && !expressionToolEnabled(execution.name))
        throw Object.assign(new Error('内部表达回合只能回复或协调当前恢复，不能开启新的执行'), { code: 'ROUTER_EXPRESSION_ONLY' });
      return next();
    });
    scope.on('agent/inbox/claimed', ({ message, turn }) => {
      if (currentTurn !== turn) { currentTurn = turn; claimedMessages = []; replyTurn = undefined; }
      if (isLegacyExecutionInput(message)) return;
      claimedMessages.push(message);
      if (message.source?.kind === 'user' || message.source?.kind === 'retry') {
        errors.delete(threadId);
        failures.delete(threadId);
      }
      if (message.source?.kind === modelFallbackSource) {
        const plan = readModelFallbacks(agent.session.snapshotEvents()).get(message.source.fallbackId);
        if (plan && !plan.cancelled && plan.message.id === message.id) {
          selection = { turnKey: plan.requestId, models: copy(plan.models), index: plan.index, failures: copy(plan.failures) };
          activeRoutes.set(agent, selection);
          replyTurn = plan.requestId;
          const original = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data?.id === plan.requestId)?.data
            || plan.uncommitted?.find(message => message.id === plan.requestId);
          expressionMode(original?.source);
          replayCalls = new Set(plan.dispatchedCalls || []);
          select(selection.models[selection.index]);
        }
        return;
      }
      const latestUser = claimedMessages.findLast(isChatUserMessage);
      const request = latestUser || message;
      expressionMode(request.source);
      if (isChatUserMessage(request) || isHostReplyRequest(request)) replyTurn = request.id;
      else if (request.source.kind === routerRecoverySource && request.source.sessionId === agent.id) replyTurn = request.source.requestId;
      const route = routes().findLast(event => event.data.messageId === request.id
        || (request.source.rpcId && event.data.requestId === request.source.rpcId))?.data;
      if (route) {
        selection = { turnKey: replyTurn ?? turn, models: copy(route.models), index: 0, failures: [] };
        activeRoutes.set(agent, selection);
        replayCalls = new Set();
        select(selection.models[0]);
      }
    });
    const queueFallback = (failure, turn, signal) => {
      signal.throwIfAborted();
      if (!selection || (!canFallback(failure) && failure.code !== 'NO_ADAPTER')) return false;
      const model = selection.models[selection.index];
      cooldowns.set(routeKey(model), now() + cooldownMs);
      selection.failures.push({ model: copy(model), reason: failure.message });
      failures.set(threadId, copy(selection.failures));
      if (!advanceModel()) return false;
      const events = agent.session.snapshotEvents();
      const requestId = replyTurn || claimedMessages.findLast(message => isChatUserMessage(message) || isHostReplyRequest(message))?.id;
      if (!requestId) return false;
      const prior = requestExecutionEvents(events, requestId);
      if (!executionEffects({ events: prior }).effectsVerified) return false;
      const recorded = new Set(events.filter(event => event.type === 'user/message').map(event => event.data.id));
      const id = randomUUID();
      const message = createUserMessage({ content: [{ type: 'text', text: 'The previous model request failed. Continue the same original request using the next configured model. Inspect saved Tasks and tool results and never repeat accepted work. The host can bind a first delegation to the original human message. If the host reports that the request already has a Task or needs user input, explain the remaining work and wait for the user.' }], source: { kind: modelFallbackSource, fallbackId: id } });
      failedPlan = { id, requestId, failedTurn: turn, models: copy(selection.models), index: selection.index,
        failures: copy(selection.failures), message, uncommitted: claimedMessages.filter(item => !recorded.has(item.id)),
        dispatchedCalls: dispatchedCallSignatures(prior) };
      appendRecord(agent.session, modelFallbackType, failedPlan);
      emit({ type: 'fallback', threadId, failure, model: selection.models[selection.index] });
      return true;
    };
    const continueFallback = () => {
      if (!failedPlan || isStopped()) return false;
      const plan = failedPlan;
      failedPlan = undefined;
      const reason = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data?.reason;
      const unsent = new Set((plan.uncommitted || []).map(message => message.id));
      const pendingMessages = [...agent.inbox.nextTurn, ...agent.inbox.nextStep];
      if (reason?.kind !== 'error' || pendingMessages.some(message => isChatUserMessage(message) && !unsent.has(message.id))) {
        appendRecord(agent.session, modelFallbackType, { kind: 'cancel', id: plan.id });
        if (reason?.kind === 'error') { errors.set(threadId, reason.error.message); emit({ type: 'error', threadId, message: reason.error.message }); }
        return false;
      }
      // The old turn has settled. A new official step rebuilds tools and
      // prompt from the replacement selection; never mutate its snapshot.
      select(plan.models[plan.index]);
      const recordedIds = new Set(agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data.id));
      for (const message of plan.uncommitted || []) {
        if (recordedIds.has(message.id)) continue;
        // The original input and continuation must share one claimed batch.
        if (agent.inbox.nextTurn.some(item => item.id === message.id)) agent.inbox.remove(message.id);
        if (!agent.inbox.nextStep.some(item => item.id === message.id)) agent.inject(message);
      }
      // A crash may leave the exact notice in the official durable runtime.inbox.
      // Move that same unadmitted identity before waking; never append twice.
      if (pendingMessages.some(message => message.id === plan.message.id)) agent.inbox.remove(plan.message.id);
      errors.delete(threadId);
      agent.followup(plan.message);
      return true;
    };
    resumeFallback = () => {
      const events = agent.session.snapshotEvents();
      const plan = [...readModelFallbacks(events).values()].at(-1);
      if (!plan || plan.cancelled || plan.turn !== undefined || !executionEffects({ events: requestExecutionEvents(events, plan.requestId) }).effectsVerified) return false;
      failedPlan = plan;
      return continueFallback();
    };
    scope.on('tools/pre-execute', (execution, next) => {
      execution.signal.throwIfAborted();
      if (execution.agent === agent && !isReadOnlyTool(execution.name)
        && !isRouterQuery(execution.name, execution.arguments)
        && replayCalls.has(fallbackCallSignature(execution.name, execution.arguments))) {
        return { kind: 'deny', reason: '模型切换不得重复已经派发的动作；请读取已有任务或结果',
          info: { name: 'RouterModelFallback', code: 'ABORTED_BEFORE_DISPATCH', reason: 'ACTION_REPLAY_BLOCKED' } };
      }
      return next();
    });
    if (recoveredEvidence) {
      const events = agent.session.snapshotEvents();
      const prefix = recoveredEvidence.lastSeq === null ? [] : events.filter(event => event.seq <= recoveredEvidence.lastSeq);
      const suffix = events.filter(event => event.seq > (recoveredEvidence.lastSeq ?? -1));
      const hash = createHash('sha256').update(JSON.stringify(prefix)).digest('hex');
      if (hash !== recoveredEvidence.hash || suffix.some(event => event.type !== 'session/end-seed'
        && !(recoveredEvidence.needsContinuation && (event.type === 'step/end'
          || (event.type === 'turn/end' && event.data?.reason?.kind === 'interrupted')
          || (event.type === 'tool/result' && ['TOOL_OUTCOME_UNKNOWN', 'TOOL_NOT_STARTED'].includes(event.data?.error?.code)))))) throw new Error('Router 记录在恢复核实后发生变化');
    }
    await role.mount(scope, agent);
    // Validate role before selecting a model for a session that has none. Every admitted
    // message still freezes its route at the official inbox boundary.
    if (!agent.model?.current?.()) {
      const configured = await store.getConfig();
      validateAssistantModels(configured.models);
      const initial = configured.models[0];
      if (initial) agent.model?.select?.({ provider: initial.providerId, model: initial.modelId, ...(initial.options?.reasoningEffort === undefined ? {} : { reasoningEffort: initial.options.reasoningEffort }) });
    }
    installProjectRules(scope, agent);
    scope.systemPrompt.section({ name: 'deployment:persona-prefix', order: -1000, interpolate: false, text: '' });
    scope.systemPrompt.section({ name: 'benchgo-builtin-layer', order: -500, interpolate: false, text: builtinLayer });
    scope.systemPrompt.section({ name: 'deployment:persona-suffix', order: 1000, interpolate: false, text: '' });
    let compaction = presets.serviceFor(agent, 'compaction');
    if (!compaction) {
      const compactScope = scope.isolate('compaction');
      await compactScope.plugin(Compaction, { auto: true, thresholdRatio: 0.5, retainTokens: 8000, headroomTokens: 4096, maxTokens: 2048 });
      compaction = { compactNow: (...args) => compactScope.get('compaction').compactNow(...args) };
    }
    agentCompaction.set(threadId, compaction);
    const redactContext = createContextRedactor(agent, 'benchgo-assistant-memory', store.memory);
    scope.systemPrompt.context({ name: 'benchgo-assistant-memory', order: 100, interpolate: false, text: () => contextText });
    scope.systemPrompt.section({ name: 'benchgo-assistant-name', order: -90, interpolate: false, text: 'IDENTITY.md defines your name; config.name is only a fallback. To rename on user request, discover the name path with assistant_settings catalog/read and prepare/commit that path.' });
    scope.systemPrompt.section({ name: 'benchgo-assistant-pet', order: -89.5, interpolate: false, text: 'You are one SuperAgent assistant and its pet identity. Appearance, personality and memory are related but distinct. Use assistant_pet only if registered; inspect catalog IDs and preview appearance changes for the user before applying. Delegate image generation to a Worker; report only supported capabilities. Expressions convey mood, not task completion.' });
    scope.systemPrompt.section({ name: 'benchgo-session-archive', order: -89.4, interpolate: false, text: 'Use assistant_session_archive for local Workbench chat archival and assistant_task_cleanup for Task history. For an explicit chat archive request with a clear scope, preview and apply directly in this turn using the owner tool.' });
    const inheritedTools = captureRouterTools(scope.tools, agent);
    await setupTools?.(scope, { agent, threadId, record, toolEnabled: expressionToolEnabled });
    const routerQuestions = installRouterQuestions(scope, agent, { database: store.orchestration, threadId, getOwnerScope: () => taskOwnerScope(threadId), appendRecord });
    installChatPublication(scope, agent, { appendRecord: appendChatRecord,
      canPublish: request => isHostReplyRequest(request) ? mayReplyToTask(threadId, request.id) : false,
      onPublish: () => emit({ type: 'publication', threadId }) });
    // A denied tool call remains a correctable official tool result, rather
    // than failing the conversation or borrowing Worker execution privileges.
    installRouterPermissionGate(scope, { agent, inherited: inheritedTools, controlled: captureRouterTools(scope.tools, agent), executor: new NativeToolExecutor(scope) });
    scope.systemPrompt.section({ name: 'benchgo-product-status', order: -88.5, interpolate: false, text: 'Answer BenchGo state questions with its registered read-only tools. For devices accessing BenchGo Link, use assistant_device_status: authorized devices and recorded access are not live online counts. Distinguish unavailable facts from empty results; broaden an investigation when the user requests it, not because an older conversation did.' });
    scope.systemPrompt.section({ name: 'benchgo-media-delivery', order: -88.3, interpolate: false, text: 'For requested image, video or audio generation, call assistant_delegate once for the batch. Preserve the requested media model, provider, references, format and item count in the Task. The Worker calls the media tools and returns the files or actual errors. A dispatch receipt only means the Worker accepted the Task. Report the result when it arrives, including per-item failures and any unconfirmed submissions.' });
    scope.systemPrompt.section({ name: 'benchgo-configuration-boundary', order: -88.4, interpolate: false, text: 'BenchGo application configuration, including providers, models, defaults, credentials and plugin settings, belongs to Router management through assistant_settings catalog/read/prepare/commit and the official services. Delegate only connection discovery, read-only inspection and actual request verification to Workers; state explicitly that they must not edit application configuration through shell, scripts, file tools or aliases. Preserve unrelated values and use the exact current namespace, revision and returned application status. If the namespace or operation is unavailable, report the exact limitation; never bypass the service with a direct file edit. Describe the Worker portion and the Router-owned remainder in the delegation target, preserving any result conditions the user stated; include known exact paths, prior verified results and exact provider/model IDs. Treat those IDs as opaque: never guess aliases or silently substitute models. After a successful commit, verify the saved and reloaded selection and an actual request to that exact provider/model. If the current configuration already parses and the requested outcome has been verified, finish; do not add BOM removal, formatting cleanup, unrelated searches or additional configuration writes. PROFILE_CONFIG_DIRECT_WRITE or PROFILE_CONFIG_RESTORED means a configuration guard intervened: stop direct edits, report the receipt and use the official management path.' });
    scope.systemPrompt.section({ name: 'benchgo-chat-publication', order: -86, interpolate: false, text: 'Ordinary text streams visibly to the user. A brief acknowledgement can precede tools in the same turn; assistant_reply publishes and ends the turn, so use ordinary text when continuing work. Normal final text is published on successful turn completion. Avoid repeating acknowledgements or narrating each tool step; the UI shows activity. Report saved Worker results naturally when notified. Publishing a reply is not action approval; keep secrets and private reasoning out of visible text.' });
    scope.systemPrompt.section({ name: 'benchgo-router-tools', order: -88, interpolate: false, text: 'Use only the registered Router coordination and product-management tools. Delegate environment investigation and execution to the resource-owning device from the first exploratory action, including filesystem, shell, web, skill loading, plugins and MCP tool calls. Use assistant_delegate for project and Task work; the current host owns the only business Task. For a user request to maintain an SSH server, call assistant_server_ssh without arguments to find its registered deviceId, then call it with the deviceId and command. For a remote resource, resolve its exact deviceId/projectId through assistant_devices/assistant_projects and read assistant_devices(deviceId). Use the configured Worker on the target device when workerPreference.config is present, otherwise choose an exact Harness, provider and model from the target catalog when workerPreference is absent. Report workerPreference.error or an empty model list directly. The peer only executes and does not need SuperAgent. Use assistant_tasks for saved facts. Use assistant_task_control supplement to send actionable text to the original Task for follow-up instructions, questions, ordinary changes to the local official Worker goal, or continuation. Resolve references from the current conversation. Attach resume=true only when the user asks to continue paused work now. Reply naturally based on the actual receipt. Use assistant_task_change for structured changes, linked adjustments and remote or external Worker revisions. Never execute remote paths locally or fall back locally when the target is unavailable. Use registered status tools for product facts, schedule_* for reminders and scheduled work, assistant_settings for configuration, and ask_user_question when a user decision is needed. For MCP setup, first discover the active manager and its servers schema through assistant_settings catalog/read; preserve other entries and follow prepare/commit and the returned application status. Delegate other environment investigation, verification and plugin-provided MCP operations to a Worker; plugin_manager is a Worker capability. These are live capabilities: do not assume missing tools, require manual configuration edits or claim a host restart is necessary without checking actual settings and tool results. Report unavailable capabilities and approval-policy blocks exactly; do not bypass them with file or shell edits. Known task IDs can be used directly; resolve ambiguous references with assistant_tasks. For remote Codex and Claude Code Workers, pause, resume, supplement and revision require a target that supports native continuation. A running native Worker applies new input in the original session after an observed turn boundary. Report control receipts accurately. A saved request confirms delivery to the Task inbox. Use assistant_execution_manage to inspect or recover work on another device. Existing Attention replies keep their original question ID and options. After dispatch, let the Worker run and return to the conversation; completion notifications support follow-up without polling. For cleanup, use assistant_task_cleanup preview then commit the selected set through its single confirmation; the commit receipt already contains per-target results. Consult history when results need clarification, not as a compulsory extra step. Request IDs come from the host; multiple tasks from one message are supported. Tool schemas carry operation-specific details.' });
    scope.on('agent/pre-step', async (payload, next) => {
      timings.get(agent.id)?.steps.push({ step: payload.step, marks: {} });
      mark(agent.id, 'contextStarted');
      const messages = (payload.messages || []).filter(message => !isLegacyExecutionInput(message));
      if (payload.messages?.length && !messages.length) return { kind: 'reject' };
      // Retain the original private event, replacing only the model surface
      // after its expression turn. The current fallback keeps its materials.
      const visible = new Set(agent.session.surface.nodes);
      for (const event of agent.session.snapshotEvents()) {
        if (!visible.has(event.seq) || event.type !== 'user/message'
          || !isHostReplyRequest(event.data) || event.data.id === replyTurn) continue;
        agent.session.append('user/message', createUserMessage({
          source: { kind: 'benchgo-task-reply-reference', eventKey: event.data.source.eventKey },
          content: [{ type: 'text', text: '该内部通知已处理；原成果保存在任务记录中。' }],
        }), { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] });
      }
      const currentThread = await thread(threadId);
      const active = activeChatReply(agent.session.snapshotEvents(), { includeInternal: true });
      // Claimed steering is not in the transcript yet. A fresh human
      // message supersedes the prior internal expression's reply gates.
      const incomingUser = messages.some(isChatUserMessage);
      const deferredNotices = new Set();
      if (incomingUser) {
        for (const message of messages) {
          if (!isHostReplyRequest(message)) continue;
          deferredNotices.add(message.id);
          const current = await mayReplyToTask(threadId, message.id);
          // Keep valid notices at their original official inbox identity;
          // stale notices cannot reject or become the reply to new input.
          if (current) agent.inbox.append('next-turn', message);
        }
        claimedMessages = claimedMessages.filter(message => !deferredNotices.has(message.id));
      }
      const currentRequest = !incomingUser && agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data?.id === active?.requestId)?.data;
      const internal = !incomingUser && messages.find(isHostReplyRequest) || (isHostReplyRequest(currentRequest) ? currentRequest : null);
      if (internal && !await mayReplyToTask(threadId, internal.id)) return { kind: 'reject' };
      if (currentThread.sourceKey && !internal) {
        for (const message of messages) {
          if (message.source?.kind !== 'user') continue;
          if (!onSourceMessage) throw new Error('Source conversation input routing is unavailable');
          await onSourceMessage({ thread: copy(currentThread), sessionId: agent.id, message });
        }
        return { kind: 'enter', messages: [] };
      }
      await scheduleBridge?.ingestMessages({ sessionId: record.sessionId, threadId, messages });
      if (scheduleBridge && messages.length && messages.every(message => message.source?.kind === 'schedule')) return { kind: 'enter', messages: [] };
      for (const message of messages) {
        if (!isChatUserMessage(message) || !message.id) continue;
        if (message.source.kind === 'user-question-reply') {
          const reply = routerQuestions.read(message);
          if (!reply) continue;
          await runtime.inbox.admit({ threadId, sessionId: agent.id, message, questionReply: reply });
          await routerQuestions.accept(message);
        }
        if (store.orchestration) recordDesktopTrigger(store.orchestration, { sessionId: record.sessionId, threadId, message });
        const source = { sessionId: record.sessionId, threadId, messageId: message.id, role: 'user' };
        store.learning?.recordPrompt({ scope: record.sessionId, eventId: message.id, turnId: message.id, source });
        const text = (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
        if (/^\/learn(?:\s|$)/u.test(text.trim())) store.learning?.request({ scope: record.sessionId, eventId: message.id, turnId: message.id, source, entry: 'command' });
      }
      const incoming = messages.filter(isChatUserMessage)
        .flatMap(message => message.source.kind === 'user-question-reply'
          ? [routerQuestions.read(message)?.text || '']
          : message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n');
      contextText = await routerContext({ incoming, messages });
      redactContext();
      mark(agent.id, 'contextReady', { contextCharacters: contextText.length });
      const decision = await next();
      return decision.kind === 'enter'
        ? { ...decision, messages: decision.messages.filter(message => !isLegacyExecutionInput(message)
          && !deferredNotices.has(message.id) && (!scheduleBridge || message.source?.kind !== 'schedule')) }
        : decision;
    });
    scope.on('tools/execute', async (execution, next) => {
      const active = activeChatReply(agent.session.snapshotEvents(), { includeInternal: true });
      const request = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data?.id === active?.requestId)?.data;
      if (execution.agent === agent && isHostReplyRequest(request)) {
        const kind = request.source.replyKind === 'watchdog' && request.source.taskId ? 'watchdog-execution' : request.source.replyKind;
        if (!replyToolEnabled(kind, execution.name))
          throw Object.assign(new Error('内部通知用于说明结果或等待原因，不能触发执行。'), { code: 'ROUTER_STATE_REPORT_ONLY' });

      }
      const toolStarted = now();
      let result;
      try { result = await next(); } finally { timings.get(agent.id)?.tools.push({ name: execution.name, started: toolStarted, durationMs: now() - toolStarted }); }
      return result;
    });
    scope.on('agent/request', async ({ turn, signal }, next) => {
      mark(agent.id, 'requestPreparing');
      await next();
      // Freeze routing for one original user message. Editing configuration
      // during a tool loop cannot reset its fallback allowance.
      const turnKey = replyTurn ?? turn;
      if (!selection || selection.turnKey !== turnKey) {
        // Direct host followups can bypass both owned submission paths.
        const config = await store.getConfig();
        const candidates = copy(config.models);
        validateAssistantModels(candidates);
        selection = { turnKey, models: candidates, index: 0, failures: [] };
        activeRoutes.set(agent, selection);
      }
      while (selection.index < selection.models.length) {
        signal.throwIfAborted();
        const model = selection.models[selection.index];
        try {
          const requestConfig = { provider: model.providerId, model: model.modelId, ...(model.options?.reasoningEffort === undefined ? {} : { reasoningEffort: model.options.reasoningEffort }), ...(model.options?.maxTokens === undefined ? {} : { maxTokens: model.options.maxTokens }) };
          await ctx.llm.prepareCall(requestConfig, signal);
          mark(agent.id, 'routeReady');
          models.set(threadId, copy(model));
          failures.set(threadId, copy(selection.failures));
          emit({ type: 'model', threadId, model, failures: selection.failures });
          return requestConfig;
        } catch (error) {
          queueFallback(error.failure ?? error, turn, signal);
          throw error;
        }
      }
      throw Object.assign(new Error(selection.models.length ? '当前消息配置的模型均不可用' : '请先配置总助手文本模型'), { code: 'ASSISTANT_MODELS_UNAVAILABLE', failures: selection.failures });
    });
    scope.on('agent/request-error', async ({ failure, signal, turn }, next) => {
      signal.throwIfAborted();
      if (!queueFallback(failure, turn, signal)) return next();
      return undefined;
    });
    scope.on('agent/status', ({ status }) => {
      if (status === 'idle' && continueFallback()) return;
      if (status === 'idle') expressionMode(false);
      emit({ type: 'status', threadId, status });
      if (status === 'idle') void (async () => {
        // The official stop shortcut cancels the same host Agent directly.
        // Converge it with the assistant Stop button before draining runtime.inbox.
        const reason = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data?.reason;
        if (reason?.kind === 'aborted' && reason.reason?.kind === 'user') await runtime.inbox.cancel(threadId, { preserveQueuedResults: true });
        await runtime.inbox.settle(threadId);
      })().catch(error => {
        errors.set(threadId, error.message); emit({ type: 'error', threadId, message: error.message });
      });
    });
    scope.on('agent/error', ({ error }) => { if (failedPlan) return; errors.set(threadId, error.message || String(error)); emit({ type: 'error', threadId, message: error.message || String(error) }); });
  };
  return { setup, resumeFallback: () => resumeFallback?.() };
}
