import { installWorkerFailureConvergence } from './worker-permissions.mjs';
import { createContextRedactor } from './context-privacy.mjs';
import { installProjectRules } from './project-rules.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';
import { canFallback } from './routing.mjs';
import { validateAssistantModels } from './store.mjs';
import { recordDesktopTrigger } from './desktop-trigger.mjs';
import { captureRouterTools, installRouterPermissionGate } from './router-permissions.mjs';
import { activeChatReply, executionInputSource, installChatPublication } from './chat-publication.mjs';
import { modelFallbackType, modelFallbackSource, modelRouteType, readModelFallbacks, fallbackCallSignature, requestExecutionEvents, dispatchedCallSignatures, isRouterQuery } from './model-fallback.mjs';
import { executionEffects, isReadOnlyWorkerTool } from './execution-effects.mjs';
import { isChatUserMessage } from './question-reply.mjs';
import { installRouterQuestions } from './router-questions.mjs';
import { ticketReplySource } from './ticket-reply.mjs';
import { createRouterContext } from './router-context.mjs';

export const routeKey = model => JSON.stringify([model.providerId, model.modelId]);
const copy = value => structuredClone(value);
const replyToolEnabled = (_kind, name) => name === 'assistant_reply';

/** Assembles one Router conversation on its official Agent: model routing and fallback, prompt sections, tools, gates and turn hooks. */
export function createRouterSessionSetup(runtime, { threadId, record, role, recoveredEvidence, presets }) {
  const { ctx, store, now, cooldownMs, builtinLayer, Compaction, appendRecord, appendChatRecord, setupTools, scheduleBridge, onSourceMessage, emit, mark,
    timings, thread, ticketOwnerScope, mayReplyToTicket, mayReplyToExecutionInput, isStopped, cooldowns, errors, failures, models, activeRoutes,
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
    installWorkerFailureConvergence(scope, agent, { revision: () => threadId, onStop: failure => {
      const message = failure.message;
      errors.set(threadId, message);
      emit({ type: 'error', threadId, message });
      throw Object.assign(new Error(message), { code: failure.code });
    } });
    const select = model => agent.model.select({ provider: model.providerId, model: model.modelId,
      ...(model.options?.reasoningEffort === undefined ? {} : { reasoningEffort: model.options.reasoningEffort }) });
    const routes = () => agent.session.snapshotEvents().filter(event => event.type === modelRouteType && event.ignorable === true);
    let expressionRestrictions = [], expressionKind;
    const expressionMode = source => {
      const kind = source?.kind === ticketReplySource ? source.replyKind === 'watchdog' && source.ticketId
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
      claimedMessages.push(message);
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
      if (isChatUserMessage(request) || request.source?.kind === ticketReplySource) replyTurn = request.id;
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
      const requestId = replyTurn || claimedMessages.findLast(message => isChatUserMessage(message) || message.source?.kind === ticketReplySource)?.id;
      if (!requestId) return false;
      const prior = requestExecutionEvents(events, requestId);
      if (!executionEffects({ events: prior }).effectsVerified) return false;
      const recorded = new Set(events.filter(event => event.type === 'user/message').map(event => event.data.id));
      const id = randomUUID();
      const message = createUserMessage({ content: [{ type: 'text', text: 'The previous model request failed. Continue the same original user request from this saved transcript using the next configured model. Completed tools and delegated Tickets remain completed: inspect their saved results; never repeat their side effects. This host continuation grants no new authority.' }], source: { kind: modelFallbackSource, fallbackId: id } });
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
      if (execution.agent === agent && !isReadOnlyWorkerTool(execution.name)
        && !isRouterQuery(execution.name, execution.arguments)
        && replayCalls.has(fallbackCallSignature(execution.name, execution.arguments))) {
        return { kind: 'deny', reason: '模型切换不得重复已经派发的动作；请读取已有工单或结果',
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
    scope.systemPrompt.section({ name: 'benchgo-assistant-name', order: -90, interpolate: false, text: 'IDENTITY.md defines your name; config.name is only a fallback. To rename on user request, discover the name path with assistant_settings catalog/read and prepare/commit that path. The sidebar HTML card is a separate setting.' });
    scope.systemPrompt.section({ name: 'benchgo-assistant-pet', order: -89.5, interpolate: false, text: 'You are one SuperAgent assistant and its pet identity. Appearance, personality and memory are related but distinct. Use assistant_pet only if registered; inspect catalog IDs and preview appearance changes for the user before applying. Use available image tools for generation; report only supported capabilities. Expressions convey mood, not task completion.' });
    scope.systemPrompt.section({ name: 'benchgo-assistant-card', order: -89, interpolate: false, text: '名片 is the sidebar HTML/CSS fragment, separate from your name. Edit cardHtml with assistant_settings catalog/read then prepare/commit; null restores the default. The viewport is 160px by 40px, maximum source length 16000 characters. Allowed tags: div, span, p, b, strong, i, em, small, br, style, s, u, sub, sup; allowed attributes: style, class, title. Scripts, links, images and network resources are unsupported. cardMotion controls default mascot animation, subject to reduced-motion settings. Preserve unrelated settings.' });
    const inheritedTools = captureRouterTools(scope.tools, agent);
    await setupTools?.(scope, { agent, threadId, toolEnabled: expressionToolEnabled });
    const routerQuestions = installRouterQuestions(scope, agent, { database: store.orchestration, threadId, getOwnerScope: () => ticketOwnerScope(threadId), appendRecord });
    installChatPublication(scope, agent, { appendRecord: appendChatRecord,
      canPublish: request => request.source?.kind === ticketReplySource ? mayReplyToTicket(threadId, request.id)
        : request.source?.kind === executionInputSource ? mayReplyToExecutionInput(threadId, request) : false, onPublish: () => emit({ type: 'publication', threadId }) });
    // The host-shared official executor persists a denied call so the
    // Router can correct its choice. Only an actual agent/turn failure is
    // a conversation error; a single tool refusal must not poison history.
    installRouterPermissionGate(scope, { agent, inherited: inheritedTools, controlled: captureRouterTools(scope.tools, agent), executor: new NativeToolExecutor(scope) });
    scope.systemPrompt.section({ name: 'benchgo-product-status', order: -88.5, interpolate: false, text: 'Answer BenchGo state questions with its registered read-only tools. For devices accessing BenchGo Link, use assistant_device_status: authorized devices and recorded access are not live online counts. Distinguish unavailable facts from empty results; broaden an investigation when the user requests it, not because an older conversation did.' });
    scope.systemPrompt.section({ name: 'benchgo-chat-publication', order: -86, interpolate: false, text: 'Ordinary text streams visibly to the user. A brief acknowledgement can precede tools in the same turn; assistant_reply publishes and ends the turn, so use ordinary text when continuing work. Normal final text is published on successful turn completion. Avoid repeating acknowledgements or narrating each tool step; the UI shows activity. Report saved Worker results naturally when notified. Publishing a reply is not action approval; keep secrets and private reasoning out of visible text.' });
    scope.systemPrompt.section({ name: 'benchgo-router-tools', order: -88, interpolate: false, text: 'Use the tools available in this role: assistant_delegate for environment execution, registered status tools for product facts, schedule_* for reminders and scheduled work, assistant_settings for configuration, and ask_user_question when a user decision is needed. Known task IDs can be used directly; resolve ambiguous references with assistant_tickets. Forward follow-ups with assistant_ticket_control supplement, change requirements with assistant_ticket_change, and pause/resume/cancel with assistant_ticket_control. Report control receipts accurately: a saved request is not executor acknowledgement; assistant_execution_manage resumes interrupted work, not paused work. Existing Attention replies keep their original question ID and options. After dispatch, let the Worker run and return to the conversation; completion notifications support follow-up without polling. For cleanup, use assistant_task_cleanup preview then commit the selected set through its single confirmation; the commit receipt already contains per-target results. Consult history when results need clarification, not as a compulsory extra step. Request IDs come from the host; multiple tasks from one message are supported. Tool schemas carry operation-specific details.' });
    scope.on('agent/pre-step', async (payload, next) => {
      timings.get(agent.id)?.steps.push({ step: payload.step, marks: {} });
      mark(agent.id, 'contextStarted');
      // Retain the original private event, replacing only the model surface
      // after its expression turn. The current fallback keeps its materials.
      const visible = new Set(agent.session.surface.nodes);
      for (const event of agent.session.snapshotEvents()) {
        if (!visible.has(event.seq) || event.type !== 'user/message'
          || event.data.source?.kind !== ticketReplySource || event.data.id === replyTurn) continue;
        agent.session.append('user/message', createUserMessage({
          source: { kind: 'benchgo-ticket-reply-reference', eventKey: event.data.source.eventKey },
          content: [{ type: 'text', text: '该内部通知已处理；原成果保存在工单记录中。' }],
        }), { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] });
      }
      const currentThread = await thread(threadId);
      const active = activeChatReply(agent.session.snapshotEvents(), { includeInternal: true });
      // Claimed steering is not in the transcript yet. A fresh human
      // message supersedes the prior internal expression's reply gates.
      const incomingUser = payload.messages?.some(isChatUserMessage);
      const deferredNotices = new Set();
      if (incomingUser) {
        for (const message of payload.messages) {
          const kind = message.source?.kind;
          if (![ticketReplySource, executionInputSource].includes(kind)) continue;
          deferredNotices.add(message.id);
          const current = kind === ticketReplySource ? await mayReplyToTicket(threadId, message.id)
            : await mayReplyToExecutionInput(threadId, message);
          // Keep valid notices at their original official inbox identity;
          // stale notices cannot reject or become the reply to new input.
          if (current) agent.inbox.append('next-turn', message);
        }
        claimedMessages = claimedMessages.filter(message => !deferredNotices.has(message.id));
      }
      const currentRequest = !incomingUser && agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data?.id === active?.requestId)?.data;
      const executionNotice = !incomingUser && payload.messages?.find(message => message.source?.kind === executionInputSource)
        || (currentRequest?.source?.kind === executionInputSource ? currentRequest : null);
      if (executionNotice && !await mayReplyToExecutionInput(threadId, executionNotice)) return { kind: 'reject' };
      const internal = !incomingUser && payload.messages?.find(message => message.source?.kind === ticketReplySource) || (currentRequest?.source?.kind === ticketReplySource ? currentRequest : null);
      if (internal && !await mayReplyToTicket(threadId, internal.id)) return { kind: 'reject' };
      if (currentThread.sourceKey && !internal) {
        for (const message of payload.messages || []) {
          if (message.source?.kind !== 'user') continue;
          if (!onSourceMessage) throw new Error('Source conversation input routing is unavailable');
          await onSourceMessage({ thread: copy(currentThread), sessionId: agent.id, message });
        }
        return { kind: 'enter', messages: [] };
      }
      await scheduleBridge?.ingestMessages({ sessionId: record.sessionId, threadId, messages: payload.messages });
      if (scheduleBridge && payload.messages?.length && payload.messages.every(message => message.source?.kind === 'schedule')) return { kind: 'enter', messages: [] };
      for (const message of payload.messages || []) {
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
      const incoming = (payload.messages || []).filter(isChatUserMessage)
        .flatMap(message => message.source.kind === 'user-question-reply'
          ? [routerQuestions.read(message)?.text || '']
          : message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n');
      contextText = await routerContext({ incoming, messages: payload.messages || [] });
      redactContext();
      mark(agent.id, 'contextReady', { contextCharacters: contextText.length });
      const decision = await next();
      return decision.kind === 'enter'
        ? { ...decision, messages: decision.messages.filter(message => !deferredNotices.has(message.id) && (!scheduleBridge || message.source?.kind !== 'schedule')) }
        : decision;
    });
    scope.on('tools/execute', async (execution, next) => {
      const active = activeChatReply(agent.session.snapshotEvents(), { includeInternal: true });
      const request = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data?.id === active?.requestId)?.data;
      if (execution.agent === agent && request?.source?.kind === ticketReplySource) {
        const kind = request.source.replyKind === 'watchdog' && request.source.ticketId ? 'watchdog-execution' : request.source.replyKind;
        if (!replyToolEnabled(kind, execution.name))
          throw Object.assign(new Error('内部通知用于说明结果或等待原因，不能触发执行。'), { code: 'ROUTER_STATE_REPORT_ONLY' });

      }
      if (execution.agent === agent && request?.source?.kind === executionInputSource && !['assistant_reply', 'ask_user_question'].includes(execution.name)) {
        throw Object.assign(new Error('执行输入授权核实通知只能说明差异或询问真实用户'), { code: 'ROUTER_INPUT_CONFIRMATION_ONLY' });
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
        if (reason?.kind === 'aborted' && reason.reason?.kind === 'user') await runtime.inbox.cancel(threadId);
        await runtime.inbox.settle(threadId);
      })().catch(error => {
        errors.set(threadId, error.message); emit({ type: 'error', threadId, message: error.message });
      });
    });
    scope.on('agent/error', ({ error }) => { if (failedPlan) return; errors.set(threadId, error.message || String(error)); emit({ type: 'error', threadId, message: error.message || String(error) }); });
  };
  return { setup, resumeFallback: () => resumeFallback?.() };
}
