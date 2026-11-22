import { createTaskManagement } from './task-management.mjs';
import { createExecutionSessionTitles } from './execution-session-title.mjs';
import { createAssistantPet } from './pet.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createAssistantStore } from './store.mjs';
import { cleanupAssistant } from './service-cleanup.mjs';
import { createTaskCleanupContinuation } from './task-cleanup-continuation.mjs';
import { createAssistantSystemFiles } from './system-files.mjs';
import { createAssistantEngine } from './engine.mjs';
import { registerNativePromptIngress } from './native-prompt-ingress.mjs';
import { createScheduleBridge } from './schedule-bridge.mjs';
import { createScheduleLifecycle } from './schedule-lifecycle.mjs';
import { createRouterWatchdog } from './router-recovery.mjs';
import { createAssistantVoice } from './voice.mjs';
import { createAssistantRuntimeStore } from './runtime-store.mjs';
import { installExecutionFactsRemote } from './execution-facts-remote.mjs';
import { createExecutionSummaries } from './execution-summary.mjs';
import { installWatchdogObservationRoute } from './watchdog-observation-route.mjs';
import { readWatchdogToken } from './watchdog-config.mjs';
import { createAuxiliaryOperations } from './auxiliary-operations.mjs';
import { createTaskRevisionService } from './task-revision-service.mjs';
import { createGoalChecklist } from './goal-checklist.mjs';
import { createAssistantReviewWorker } from './review-worker.mjs';
import { createAssistantDeliveryWorker } from './delivery-worker.mjs';
import { voiceAvailability } from '../../media/src/availability.mjs';
import { protocolDescriptor } from '../../media/shared/protocol-catalog.mjs';
import { createVoiceHandlers } from '../../media/src/web.mjs';
import { mediaToolDefinitions } from '../../media/src/generation-tools.mjs';
import { assertSameOrigin } from '../../base/shared/http.mjs';
import { DataOwner } from '../../base/shared/data-owner.mjs';
import { readAdmissionRules } from './admission-rules.mjs';
import { createFeishuAdapter } from './channels/feishu/index.mjs';
import { createUnifiedChannelIngress } from './channel-ingress.mjs';
import { createWorkbenchChannelIngress } from './workbench-channel-ingress.mjs';
import { createChannelSessionHost, registerChannelSessionProjection } from './channel-session.mjs';
import { readOwnedSessionRole, superagentSessionInventory } from './execution-session.mjs';
import { registerAssistantFetchRoute } from './assistant-fetch-route.mjs';
import { mountIntegrationApi } from './integration-api.mjs';
import { createExternalActionStore } from './external-action-store.mjs';
import { createExternalActionRegistry, createExternalActionHost, registerChannelExternalActions } from './external-actions.mjs';
import { createChannelCredentials } from './channel-credentials.mjs';
import { connectionConfig, channelDefinition, channelIds } from './channel-catalog.mjs';
import { createChannelRuntime, mountChannelCallbacks } from './channel-runtime.mjs';
import { createPersonalChannelSources } from './channel-personal-scope.mjs';
import { createFeishuStream } from './channels/feishu/stream.mjs';
import { createAssessmentRunner } from './assessment-runner.mjs';
import { createEvaluationDisposition } from './eval-disposition.mjs';
import { readAssessmentPolicy, authorizeAssessment } from './assessment-policy.mjs';
import { createOrchestrationRuntime } from './orchestration-runtime.mjs';
import { createMaintenanceProcessor } from './maintenance-processors.mjs';
import { registerOwnedSkillProvider } from './owned-skill-provider.mjs';
import { createDesktopDelegationService } from './desktop-delegation-service.mjs';
import { createDesktopTaskAccess } from './desktop-task-access.mjs';
import { createDesktopTaskControl } from './desktop-task-control.mjs';
import { createModelActionTaskExecutor } from './model-action-task.mjs';
import { createAssistantDeviceStatus } from './device-status.mjs';
import { createAssistantSettingsAdapter } from './settings-adapter.mjs';
import { createConnectionSettingsAdapter } from './connection-settings-adapter.mjs';
import { applySettingsOps } from '../../base/src/settings-management.mjs';
import { createManagementHttp } from './management-http.mjs';
import { createHistorySearch } from './history-search.mjs';
import { createAssistantArtifacts } from './artifacts.mjs';
import { profileDocuments } from './profile-documents.mjs';
import { createRouterTools } from './router-tools.mjs';
import { createAssistantDispatch } from './assistant-dispatch.mjs';
import { createDeviceTools } from './device-tools.mjs';
import { readDeviceCenter, readRemoteExecutionCatalog, selectRemoteExecution } from './execution-catalog.mjs';
import { createWorkerArchive } from './worker-archive.mjs';

/** Channel uploads require a concrete, saved HTTP/SSE ASR protocol. */
export async function channelVoiceAvailability(voice, providers) {
  const availability = await voiceAvailability(voice, providers);
  if (!voice) return availability;
  const protocol = voice.value?.asr?.protocol || '';
  const descriptor = protocolDescriptor('asr', protocol);
  if (!['transcriptions', 'transcriptions-sse', 'stepfun-sse'].includes(protocol)) {
    const guidance = '请在设置 → 语音中点击自动匹配（按文件上传用途排除 WebSocket），或手动选择 HTTP/SSE 转录';
    return { ...availability, available: { ...availability.available, voiceInput: false },
      reasons: { ...availability.reasons, voiceInput: descriptor?.transport === 'websocket'
        ? `当前语音识别使用 WebSocket，渠道语音文件上传不支持此协议；${guidance}`
        : !protocol || protocol === 'auto' ? `渠道语音识别协议尚未匹配；${guidance}`
          : `渠道语音文件上传不支持此语音识别协议；${guidance}` } };
  }
  return availability;
}

export async function mountAssistant(ctx, commander, providers) {
  const owner = new DataOwner(resolve(commander.store.directory, 'assistant'));
  await owner.open();
  let store;
  try { store = await createAssistantStore({ dataDirectory: commander.store.directory }); }
  catch (error) {
    try { await owner.close(); }
    catch (closeError) { throw new AggregateError([error, closeError], 'SuperAgent 初始化及所有权释放失败'); }
    throw error;
  }
  const shutdown = new AbortController();
  let historySearch;
  const readLedger = async input => store.ledger.read(input.id, input);
  let channelCredentials;
  let database, goals, reviewWorker, deliveryWorker, engine, watchdogRetryTimer, disposal, feishu, feishuStream, channels, assessmentRunner, assessmentTimer, orchestrationRuntime, scheduleBridge, routerWatchdog;
  let notificationQueue = Promise.resolve(), skillProvider, unsubscribeSkills, unsubscribeLearning, scheduleLifecycle, externalActionStore, unregisterExternalActions, channelSessions;
  let disposeFactsRemote, executionSummaries, disposeWatchdogRoute, cleanupContinuations, executionSessionTitles, workerArchive;
  let settings;
  const unregisterSettings = [];
  const projectSchedules = async () => {
    try { await scheduleLifecycle?.sync(); }
    catch (error) { ctx.logger?.warn?.(`SuperAgent Schedule projection: ${error.code || error.name}`); }
  };
  const dispose = () => disposal ||= cleanupAssistant({
    halt: [
      () => { clearInterval(watchdogRetryTimer); clearInterval(assessmentTimer); },
      () => shutdown.abort(),
      () => feishuStream?.stop(),
    ],
    // Thunks isolate synchronous throws as well as rejected async disposers.
    stop: [() => workerArchive?.dispose(), () => executionSessionTitles?.dispose(), () => executionSummaries?.dispose(), () => channels?.dispose(), () => scheduleBridge?.stop(),
      () => orchestrationRuntime?.stop(), () => assessmentRunner?.stop(), () => feishuStream?.dispose(),
      () => deliveryWorker?.stop(), () => reviewWorker?.stop(),
      () => routerWatchdog?.stop(), () => engine?.dispose(), () => notificationQueue, () => feishu?.dispose()],
    detach: [
      ...unregisterSettings.splice(0).map(unregister => () => unregister()),
      () => disposeWatchdogRoute?.(), () => disposeFactsRemote?.(), () => unsubscribeSkills?.(), () => unsubscribeLearning?.(),
      () => skillProvider?.dispose(), () => channelCredentials?.dispose(), () => unregisterExternalActions?.(),
      () => historySearch?.dispose(),
    ],
    close: [() => externalActionStore?.close(), () => database?.close(), () => store.close()],
    release: () => owner.close(),
  });
  try {
  ctx.effect(() => dispose);
  const generation = () => ctx.get?.('mediaGeneration');
  ctx.inject(['mediaGeneration'], child => store.migrateGenerationSettings(legacy => child.get('mediaGeneration').importLegacyMedia(legacy))
    .catch(error => ctx.logger?.warn?.(`媒体配置迁移失败：${error.code || error.name}`)));
  const mediaTools = mediaToolDefinitions({ generation, attachments: ctx.get?.('attachments') });
  const mediaByName = new Map(mediaTools.map(definition => [definition.name, definition]));
  historySearch = createHistorySearch({ ctx, store });
  channelCredentials = createChannelCredentials({ credentials: ctx.credentials });
  settings = ctx.get?.('benchgoSettings');
  const hostSkills = ctx.get?.('skills');
  if (hostSkills?.registerProvider) {
    skillProvider = registerOwnedSkillProvider({ ctx, skills: hostSkills, database: store.ownedSkills.providerDatabase });
    unsubscribeSkills = store.ownedSkills.onChange(() => skillProvider.invalidate());
  }
  await registerChannelSessionProjection(ctx);
  const onInbound = (...args) => channelSessions.onInbound(...args);
  const ingress = createUnifiedChannelIngress({ store, onInbound });
  const feishuOptions = {
    getConfig: () => store.connections.read().config,
    credentials: channelCredentials,
    authorizeConnection: input => ingress.authorize('feishu', input),
    ingest: event => ingress.receive('feishu', event),
  };
  feishu = createFeishuAdapter(feishuOptions);
  feishu.prepareExternalSend = (input, context) => ingress.prepareExternalSend('feishu', input, context);
  feishuStream = createFeishuStream(feishuOptions);
  const pet = createAssistantPet({ store, readMediaArtifact: name => generation()?.artifact(name) });
  const voiceMedia = createAssistantVoice({ store, providers, credentials: ctx.credentials, shutdown: shutdown.signal });
  let voiceStore, voiceHandlers;
  const channelVoice = () => {
    const current = ctx.get?.('voice');
    if (!current) throw new Error('Voice 服务不可用');
    if (voiceStore !== current) { voiceHandlers?.dispose(); voiceStore = current; voiceHandlers = createVoiceHandlers(current, { providers, shutdown: shutdown.signal }); }
    return voiceHandlers;
  };
  ctx.effect(() => () => voiceHandlers?.dispose());
  const personalChannelSources = createPersonalChannelSources();
  channels = createChannelRuntime({ ctx, store, onInbound, observeSource: personalChannelSources.observe, adapterOptions: { credentials: channelCredentials,
    voiceAvailability: () => channelVoiceAvailability(ctx.get?.('voice'), providers),
    transcribe: request => channelVoice().transcribe(request),
    synthesize: request => channelVoice().speech(request),
  } });
  mountChannelCallbacks(ctx, channels, feishu);
  externalActionStore = createExternalActionStore({ directory: store.paths.directory, profileId: store.profileId });
  const externalRegistry = createExternalActionRegistry();
  ctx.provide('benchgoExternalActions', createExternalActionHost({ ctx, store: externalActionStore, registry: externalRegistry,
    onApprovalPending: input => engine?.notifyApprovalPending(input) }));
  orchestrationRuntime = createOrchestrationRuntime({ ctx, store, feishu, channels,
    maintainTasks: () => { void workerArchive?.tick(); return cleanupContinuations?.tick(); },
    notifyExecutionInput: input => engine.notifyExecutionInput(input),
    notifyTaskResult: async notice => {
      const receipt = await engine.notifyTaskResult(notice);
      const payload = notice?.payload;
      if (receipt?.status === 'accepted' && payload?.source?.channel === 'desktop'
        && store.orchestration.getTask(notice.taskId)?.status === 'completed') {
        void pet.taskCompleted(`${notice.taskId}:${payload.resultVersion}`, payload.source.threadId || 'main').catch(() => {});
      }
      return receipt;
    },
    onDelivered: outbox => outbox.kind === 'router' ? undefined : channelSessions.onDelivery(outbox), deliverDesktop: async delivery => {
    const task = store.orchestration.getTask(delivery.taskId);
    const event = database.notify({ id: task.id, threadId: task.mandate.source.threadId }, delivery.payload.type,
      { ...delivery.payload, taskStateEventKey: delivery.uniqueKey, title: task.title, status: task.status }, `task-delivery:${delivery.uniqueKey}`);
    try { await scheduleLifecycle?.task(task); }
    catch (error) { ctx.logger?.warn?.(`SuperAgent Schedule projection: ${error.code || error.name}`); }
    return { status: 'accepted', messageId: event.id };
  } });
  const restartFeishu = () => { void feishuStream.start().catch(() => ctx.logger?.warn?.('飞书长连接启动失败，请检查连接设置')); };
  assessmentRunner = createAssessmentRunner({ database: store.orchestration, llm: ctx.llm, readPolicy: threadId => readAssessmentPolicy(store, ctx.workspaceRegistry, threadId), authorize: authorizeAssessment, readContext: input => input.source?.channel === 'feishu' ? feishu.readContext(input) : undefined,
      readDevices: signal => readDeviceCenter(ctx, signal),
      resolveRemoteExecution: async ({ deviceId, projectId, signal }) => selectRemoteExecution(await readRemoteExecutionCatalog(ctx, deviceId, signal), { projectId }) });
  scheduleBridge = createScheduleBridge({ ctx, store, readPolicy: () => readAssessmentPolicy(store, ctx.workspaceRegistry),
    onOccurrence: occurrence => scheduleLifecycle?.occurrence(occurrence) });
  const assessIntake = () => { void assessmentRunner.tick().catch(() => { if (!shutdown.signal.aborted) ctx.logger?.warn?.('SuperAgent 研判未完成，候选保留供重试'); })
    .finally(() => { if (!shutdown.signal.aborted) store.orchestration.enqueueUnavailableReplies(); }).catch(error => ctx.logger?.warn?.(`SuperAgent 分诊状态通知未完成：${error.code || error.name}`)); };
  const evaluations = createEvaluationDisposition({ database: store.orchestration, readPolicy: () => readAssessmentPolicy(store, ctx.workspaceRegistry), wake: assessIntake });
  database = createAssistantRuntimeStore({ filename: store.paths.database,
    afterCommit: () => store.orchestration.flushExecutionFactChanges() });
  store.orchestration.installExecutionFactRuntimeSources();
  scheduleLifecycle = createScheduleLifecycle({ ctx, store, database });
  const desktopDelegation = createDesktopDelegationService({ ctx, store, wake: () => orchestrationRuntime.tick() });
  // The owner's current instruction is the authorization; the receipt only versions the exact difference.
  const taskChanges = createTaskRevisionService({ ctx, store, requestExpansion: async ({ trigger }) =>
    ({ approved: true, id: randomUUID(), triggerId: trigger.id, actorId: trigger.actor.id }) });
  const taskControl = createDesktopTaskControl({ ctx, database: store.orchestration });
  goals = createGoalChecklist({ database });
  executionSessionTitles = createExecutionSessionTitles({ ctx, database: store.orchestration, metadata: database });
  const taskManagement = createTaskManagement({ database, orchestration: store.orchestration, goals,
    onTaskRename: taskId => { void executionSessionTitles.syncTask(taskId); } });
  workerArchive = createWorkerArchive({ ctx, commander, orchestration: store.orchestration, database, signal: shutdown.signal,
    wake: () => orchestrationRuntime.tick() });
  ctx.provide('benchgoWorkerArchive', workerArchive);
  cleanupContinuations = createTaskCleanupContinuation({ database, orchestration: store.orchestration, taskManagement, signal: shutdown.signal,
    onUpdate: update => engine.notifyTaskCleanup(update) });
  const desktopTasks = createDesktopTaskAccess(store.orchestration, taskManagement);
  const projectTasks = rows => taskManagement.project('task', rows).map(row => {
    const summary = store.orchestration.executionSummary(row.id);
    const current = summary?.instructionRevision === row.instructionRevision
      && summary.runId === (row.execution?.runId || 'pending') ? summary : null;
    return { ...row, currentSummary: current,
      execution: row.execution ? { ...row.execution, summary: current } : row.execution };
  });
  orchestrationRuntime.executionFacts.setTaskProjection(projectTasks);
  await orchestrationRuntime.executionFacts.ready;
  disposeFactsRemote = await installExecutionFactsRemote({ ctx, facts: orchestrationRuntime.executionFacts,
    subscribeIdentity(listener) {
      return store.documents.subscribe(({ name }) => { if (name === 'IDENTITY.md') listener(); });
    },
  });
  executionSummaries = createExecutionSummaries({ executionFacts: orchestrationRuntime.executionFacts,
    store: store.orchestration, llm: ctx.llm, sessionQuery: ctx.sessionQuery, getConfig: () => store.getConfig(),
    config: ctx.get('benchgo')?.config?.executionSummary,
    onChange: taskId => store.orchestration.recordExecutionDisplayChange({ taskId, kind: 'summary' }),
    onError: error => ctx.logger?.warn?.(`SuperAgent execution summary: ${error.code || error.name}`) });
  void executionSummaries.ready.catch(error => ctx.logger?.warn?.(`SuperAgent execution summary: ${error.code || error.name}`));
  const modelActions = createModelActionTaskExecutor({
    ctx, database: store.orchestration, workspace: store.paths.workspace,
    readPolicy: () => readAssessmentPolicy(store, ctx.workspaceRegistry),
    perform: async ({ name, args, exec, actionKey, sourceMessage }) => {
      if (name === 'assistant_pet') return args.op === 'restore' ? pet.restore(args) : pet.apply(args);
      if (name === 'assistant_profile') return profileDocuments(store, args, { kind: 'conversation', threadId: args.threadId, sessionId: String(exec.agent.session.id), callId: exec.callId });
      return mediaByName.get(name).execute(args, exec, { requestId: actionKey, userMessage: sourceMessage });
    },
    verify: async ({ name, args, result }) => {
      if (name === 'assistant_pet') {
        const current = await store.getConfig();
        if (current.revision !== result.revision || JSON.stringify(current.pet) !== JSON.stringify(result.pet)) throw new Error('Pet configuration revision could not be verified');
        return { verified: true, evidence: { kind: 'assistant-pet', revision: current.revision, appearanceHash: createHash('sha256').update(JSON.stringify(current.pet)).digest('hex') } };
      }
      if (name === 'assistant_profile' && result.document?.name) {
        const current = await store.documents.read(result.document.name);
        if (current.hash !== result.document.hash) throw new Error('Assistant document hash could not be verified');
        return { verified: true, evidence: { kind: 'assistant-document', document: current.name, hash: current.hash, revision: current.revision } };
      }
      if (name === 'generate_video' && result?.requestId && result.jobId && !result.filename) {
        const receipt = await generation()?.videoReceipt(result.requestId);
        if (!receipt || !['jobId', 'providerId', 'modelId'].every(key => receipt[key] === result[key])) throw new Error('视频任务凭据回读失败');
        return { verified: true, evidence: { kind: 'video-submission', ...receipt } };
      }
      if (name === 'generate_image' && result?.requestId && result.externalUrl) {
        const receipt = await generation()?.imageReceipt(result.requestId);
        if (!receipt || result.url !== receipt.externalUrl
          || !['externalUrl', 'mimeType', 'providerId', 'modelId', 'status'].every(key => receipt[key] === result[key])) {
          throw new Error('外链图片收据回读失败');
        }
        const urlHash = createHash('sha256').update(receipt.externalUrl).digest('hex');
        return { verified: true, evidence: { kind: 'media-external-image', requestId: receipt.requestId, mimeType: receipt.mimeType, urlHash } };
      }
      const artifact = result?.filename && await generation()?.artifact(result.filename);
      if (!artifact) throw new Error('媒体产物回读失败');
      const hash = createHash('sha256');
      for await (const chunk of artifact.stream()) hash.update(chunk);
      return { verified: true, evidence: { kind: 'media-artifact', requestId: result.requestId, filename: artifact.filename, artifactHash: hash.digest('hex') } };
    },
  });
  let maintenanceEnabled = true;
  const processMaintenance = createMaintenanceProcessor({ ctx, store,
    readSources: input => historySearch.maintenanceSources(input) });
  reviewWorker = createAssistantReviewWorker({
    review: store.review,
    logger: ctx.logger,
    beforeRun: async () => {
      const [policy, config] = await Promise.all([store.memory.learning(), store.getConfig()]);
      maintenanceEnabled = policy.enabled;
      store.learning.configure({ quietMs: config.maintenance.quietSeconds * 1000, periodMs: config.maintenance.intervalHours * 3600000 });
      return store.learning.scheduleDue({ enabled: maintenanceEnabled });
    },
    shouldRun: item => maintenanceEnabled && !engine?.isBusy() && store.learning.canRun(item),
    process: processMaintenance,
  });
  unsubscribeLearning = store.learning.onActivity(() => reviewWorker.interrupt());
  const maintenanceFacts = () => {
    const learning = store.learning.status(), status = reviewWorker.status();
    return { ...status, enabled: maintenanceEnabled && status.enabled,
      pending: store.review.list({ status: 'pending', limit: 100 }).length,
      quietUntil: learning.lastActivityAt ? new Date(learning.lastActivityAt + learning.quietMs).toISOString() : null };
  };
  const readWatchdogFacts = options => ({ ...orchestrationRuntime.executionFacts.evidenceSnapshot(options), maintenance: maintenanceFacts() });
  // Delivery is deliberately injected by Link/host integrations. Polling and
  // acknowledgements remain available without a transport; accepted delivery
  // is never confused with a device receipt.
  const deliveryTransport = ctx.get?.('assistantNotificationDelivery') || ctx.get?.('notificationDelivery');
  deliveryWorker = createAssistantDeliveryWorker({
    database,
    send: deliveryTransport?.send,
    targets: deliveryTransport?.targets,
    logger: ctx.logger,
  });
  deliveryWorker.start();
  const capabilities = async () => {
    const voice = await voiceAvailability(ctx.get?.('voice'), providers);
    return {
      schemaVersion: 1,
      available: {
        chat: true, sideChats: true, memory: true, documents: true, tasks: true,
        goals: true, triggers: scheduleBridge.available(), skills: !!ctx.get?.('skills'), media: true,
        summary: true, vision: !!ctx.get?.('attachments'), taskRevisions: true, evaluationDisposition: true,
        linkNotifications: true, backgroundReview: true, multiProfile: false, vectorMemory: false,
        ...voice.available,
      },
      reasons: {
        multiProfile: 'BenchGo 当前固定为一个总助手和一个活动身份', vectorMemory: '不新增向量数据库依赖',
        ...(!ctx.get?.('attachments') ? { vision: '官方图片附件服务不可用' } : {}),
        ...(!scheduleBridge.available() ? { triggers: '官方 Schedule 服务不可用' } : {}),
        ...voice.reasons,
      },
    };
  };
  const applyConnectionConfiguration = async ({ channel, ops, expected, signal }) => {
    const current = store.connections.read(channel);
    const next = connectionConfig(channel, applySettingsOps(current.config, ops));
    if (next.admissionMode === 'auto' || next.enabledRuleIds?.length) {
      const document = await store.documents.read('AGENTS.md');
      const defined = new Set(readAdmissionRules(document.content).map(rule => rule.id));
      const missing = next.enabledRuleIds.filter(id => !defined.has(id));
      if (missing.length) throw new Error('Undefined or empty written rule IDs: ' + missing.join(', '));
    }
    const saved = store.connections.update({}, { channel, ops, expected, signal });
    if (channel === 'feishu') await feishuStream.start();
    else await channels.restart(channel);
    const connectionState = channel === 'feishu' ? feishuStream.status().state : undefined;
    return { ...saved, application: { state: !saved.config.enabled || connectionState === 'connected' ? 'applied' : 'pending',
      ...(!saved.config.enabled ? {} : { reason: '配置已保存，实际渠道连接状态由连接服务持续核实' }) } };
  };
  if (settings) {
    unregisterSettings.push(settings.register(createAssistantSettingsAdapter(store, {
      applyConfig: ({ ops, expected, signal }) => store.updateConfig({}, { settingsOps: ops, expected, signal }),
    })));
    unregisterSettings.push(settings.register(createConnectionSettingsAdapter(store.connections, { applyConfig: applyConnectionConfiguration })));
    await Promise.all(unregisterSettings.map(unregister => unregister.ready));
  }
  const management = createManagementHttp({ settings, taskManagement, profileId: store.profileId,
    readConfig: () => store.getConfig(), readConnection: channel => store.connections.read(channel), readLearning: () => store.memory.learning() });
  const deviceStatus = createAssistantDeviceStatus({ ctx, store });
  const deviceTools = createDeviceTools({ ctx });
  const artifacts = createAssistantArtifacts({ workspace: store.paths.workspace });
  const auxiliary = createAuxiliaryOperations({ ctx, store, artifacts, shutdown: shutdown.signal });
  const setupTools = createRouterTools({ ctx, commander, store, database, shutdown, historySearch, readLedger, goals, orchestrationRuntime, settings, projectSchedules, pet, desktopDelegation,
    taskChanges, desktopTasks, taskControl, taskManagement, cleanupContinuations, modelActions, mediaTools, capabilities, deviceStatus, auxiliary, deviceTools,
    get engine() { return engine; } });
  engine = await createAssistantEngine({ ctx, store, setupTools, scheduleBridge,
    readTaskCleanupContinuation: id => database.taskCleanupContinuations.get(id),
    resumeExecutionSession: input => orchestrationRuntime.resumeExecutionSession(input),
    readWatchdogFacts,
    onSourceMessage: input => channelSessions.onSourceMessage(input),
    onTaskReply: async input => {
      if (!['result', 'state'].includes(input.signal.kind)) return;
      const { signal } = input;
      if (signal.source.channel === 'desktop' && signal.kind === 'result') {
        const confirmed = store.orchestration.confirmResultReply(input);
        if (!confirmed && store.orchestration.resultNotification(signal.taskId, signal.eventKey)) throw new Error('Public Router reply confirmation unavailable');
        return confirmed || { status: 'suppressed', reason: 'task-superseded' };
      }
      else if (signal.source.channel !== 'desktop') store.orchestration.enqueueRouterReply(input);
    },
    onClearMain: () => database.clearMainChatNotifications() });
  const watchdogTarget = ctx.get('benchgo')?.config?.watchdogTarget;
  if (watchdogTarget?.enabled === true) {
    try {
      const token = await readWatchdogToken(watchdogTarget.tokenFile);
      disposeWatchdogRoute = installWatchdogObservationRoute({ ctx,
        config: { targetId: watchdogTarget.targetId, token },
        readFacts: () => readWatchdogFacts({ limit: 1000 }),
        acceptSignal: (signal, principal) => engine.notifyWatchdogSignal(signal, principal) });
    } catch (error) {
      ctx.logger?.warn?.(`SuperAgent watchdog unavailable: ${error.code || error.name}`);
    }
  }
  const receiveOwnerMessage = createWorkbenchChannelIngress({ store,
    readPolicy: threadId => readAssessmentPolicy(store, ctx.workspaceRegistry, threadId), wake: () => { void orchestrationRuntime.tick(); } });
  channelSessions = createChannelSessionHost({ ctx, store, engine,
    receiveOwnerMessage });
  // Channel login can wait on remote networks. Drain it during channel disposal.
  await channels.start({ waitForConnection: false });
  unregisterExternalActions = registerChannelExternalActions(externalRegistry, {
    channelIds, getAdapter: id => id === 'feishu' ? feishu : channels.get(id),
    getCapabilities: id => channelDefinition(id).capabilities,
  });
  restartFeishu();
  orchestrationRuntime.start();
  assessmentTimer = setInterval(assessIntake, 1000);
  assessmentTimer.unref?.();
  assessIntake();
  ctx.inject(['typertGateway'], scope => {
    scope.effect(() => registerNativePromptIngress(scope, engine));
  });
  routerWatchdog = createRouterWatchdog({ engine, onError: error => ctx.logger?.warn?.(`Router recovery: ${error.message}`) });
  void routerWatchdog.tick().catch(error => {
    if (!shutdown.signal.aborted) ctx.logger?.warn?.(`Router recovery: ${error.message}`);
  });
  routerWatchdog.start();
  void scheduleBridge.start().catch(error => {
    if (!shutdown.signal.aborted) ctx.logger?.warn?.(`SuperAgent Schedule: ${error.message}`);
  });
  shutdown.signal.throwIfAborted();
  // Maintenance may call a model; its first bounded tick shares the worker's
  // existing cancellation/cleanup without holding routes behind that request.
  void reviewWorker.tick();
  reviewWorker.start();
  watchdogRetryTimer = setInterval(() => { engine.retryTaskReplies().catch(error => ctx.logger?.warn?.(`SuperAgent supervision signal: ${error.code || error.name}`)); }, 30_000);
  watchdogRetryTimer.unref?.();
  const state = async () => ({ config: await store.getConfig(), petExpression: pet.event(), media: await voiceMedia.availability(), profile: await store.getProfile(), memories: await store.listMemories(), state: { ...await store.getState(), notifications: database.notifications().events } });
  const systemFiles = createAssistantSystemFiles({ directory: store.paths.directory, desktop: () => ctx.get?.('sessionController') });
  const dispatch = createAssistantDispatch({ ctx, store, shutdown, historySearch, readLedger, channelCredentials, database, goals, engine, feishu, feishuStream, channels, personalChannelSources, orchestrationRuntime,
    executionSummaries, projectSchedules, pet, restartFeishu, evaluations, taskChanges, taskManagement, projectTasks, capabilities, management, state,
    artifacts, auxiliary, systemFiles, skillProvider, workerArchive });
  ctx.effect(() => registerAssistantFetchRoute({ connection: ctx.connection, dispatch }));
  mountIntegrationApi(ctx, () => !shutdown.signal.aborted && store.connections.read('api').config.enabled);
  for (const [name, handler] of Object.entries(voiceMedia.handlers)) {
    ctx.effect(() => ctx.connection.fetch.register({ path: `/api/commander/assistant/voice/${name}`, methods: [name === 'worklet' ? 'GET' : 'POST'], requestBody: name === 'worklet' ? 'buffered' : 'streaming', async fetch(request) {
      try {
        assertSameOrigin(request);
        const voice = ctx.get?.('voice'), key = name === 'speech' ? 'readAloud' : name === 'transcribe' ? 'voiceInput' : null;
        const availability = await voiceAvailability(voice, providers);
        if (!voice || (key && !availability.available[key])) return Response.json({ error: availability.reasons[key] || 'Voice 服务已停用', code: 'VOICE_UNAVAILABLE' }, { status: 503 });
        return handler(request);
      } catch (error) { return Response.json({ error: error.message }, { status: error.status || 400 }); }
    } }));
  }
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/commander/assistant/pet-asset', methods: ['GET'], requestBody: 'buffered', fetch: request => pet.fetchAsset(request) }));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/commander/assistant/artifact', methods: ['GET'], requestBody: 'buffered', fetch: request => artifacts.fetch(request) }));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/commander/assistant/system-file', methods: ['GET'], requestBody: 'buffered', fetch: request => systemFiles.fetch(request) }));
  return { store, engine, database, dispatch, dispose,
    readSessionRole: sessionId => readOwnedSessionRole({ store, sessionId, listSessions: () => ctx.sessionQuery.listSessions() }),
    async readWorkerModels() {
      const { workerHarness, workerModels } = await store.getConfig();
      return { harness: workerHarness, models: workerModels.map(({ providerId, modelId, options }) => ({
        providerId, modelId, ...(options && Object.keys(options).length ? { params: options } : {}),
      })) };
    },
    sidebarPrivateSessionIds: async () => {
      const [snapshot, records] = await Promise.all([store.getState(), ctx.sessionQuery.listSessions()]);
      return superagentSessionInventory({ state: snapshot, database: store.orchestration, records }).privateSessionIds;
    } };
  } catch (error) {
    try { await dispose(); }
    catch (closeError) { throw new AggregateError([error, closeError], 'SuperAgent 初始化及清理失败'); }
    throw error;
  }
}

