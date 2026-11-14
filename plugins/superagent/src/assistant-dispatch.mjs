import { replyNotificationOption } from './notification-option.mjs';
import { reactionScope, setMessageReaction } from './message-reaction.mjs';
import { executionSessionProjection, readOwnedSessionRole, superagentSessionInventory } from './execution-session.mjs';
import { resolveApprovalOrigins } from './execution-approval-origin.mjs';
import { channelDefinition } from './channel-catalog.mjs';
import { readAssessmentPolicy } from './assessment-policy.mjs';
import { taskStopped } from './task-lifecycle.mjs';
import { profileDocuments } from './profile-documents.mjs';

/** The owner-facing HTTP action table behind POST /api/commander/assistant. */
export function createAssistantDispatch(runtime) {
  const { ctx, store, shutdown, historySearch, readLedger, channelCredentials, database, goals, engine, feishu, feishuStream, channels, orchestrationRuntime,
    executionSummaries, projectSchedules, pet, restartFeishu, evaluations, taskChanges, taskManagement, projectTasks, capabilities, management, state,
    artifacts, auxiliary, systemFiles, skillProvider, collaboration } = runtime;
  return async function dispatch(input, peer, { signal } = {}) {
    if (shutdown.signal.aborted) throw Object.assign(new Error('SuperAgent 已停用'), { status: 503, code: 'ASSISTANT_UNAVAILABLE' });
    const queryOptions = { signal: AbortSignal.any([shutdown.signal, signal].filter(Boolean)) };
    queryOptions.signal.throwIfAborted();
    const threadId = input.threadId ?? 'main';
    switch (input.action) {
      case 'collaboration': return collaboration.receive(input, peer, queryOptions);
      case 'state': return state();
      case 'sessionRole': return { role: await readOwnedSessionRole({ store, sessionId: input.sessionId,
        listSessions: () => ctx.sessionQuery.listSessions() }) };
      case 'approvalOrigins': return resolveApprovalOrigins({ store, engine, input, peer,
        readPolicy: id => readAssessmentPolicy(store, ctx.workspaceRegistry, id) });
      case 'executionSessions': {
        const [snapshot, records] = await Promise.all([store.getState(), ctx.sessionQuery.listSessions()]);
        return { sessions: superagentSessionInventory({ state: snapshot, database: store.orchestration, records, agents: ctx.agents }).sessions };
      }
      case 'petCatalog': return pet.catalog();
      case 'petUpload': return pet.upload(input);
      case 'petPreview': return pet.preview(input);
      case 'petApply': return pet.apply(input);
      case 'petRestore': return pet.restore(input);
      case 'petDiscard': return pet.discard(input);
      case 'petExpress': return pet.express(input);
      case 'connections': return store.connections.read(input.channel);
      case 'connectionCatalog': {
        const catalog = await channels.catalog(async () => ({ ...await feishu.status(), ...feishuStream.status(), connection: feishuStream.status(), callback: channels.callbackStatus('feishu') }));
        const channel = catalog.channels.find(item => item.id === 'feishu'), status = channel?.status;
        if (status?.enabled && !status.error && status.connection?.state === 'connected'
          && (status.connection.authenticated === true || status.authentication === 'verified')) {
          channel.sourceNames = await feishu.sourceNames((await store.getState()).threads);
        }
        return catalog;
      }
      case 'connectionStatus': {
        if (input.channel && input.channel !== 'feishu') return channels.status(input.channel);
        const connection = feishuStream.status();
        return { ...await feishu.status(), events: connection.events, lastEventAt: connection.lastEventAt, connection, callback: channels.callbackStatus('feishu') };
      }
      case 'connectionVerify': {
        const channel = input.channel || 'feishu', current = store.connections.read(channel);
        const adapter = channel === 'feishu' ? feishu : channels.get(channel);
        if (!adapter?.verify) throw new Error('此渠道不支持认证验证');
        const status = await adapter.verify();
        if (store.connections.read(channel).revision !== current.revision) throw Object.assign(new Error('链接配置已更新，请重新验证'), { code: 'REVISION_CONFLICT' });
        if (channel !== 'feishu') return { ...current, status };
        const saved = current.config.botOpenId === status.botOpenId ? current : store.connections.update({ botOpenId: status.botOpenId }, { revision: current.revision });
        if (saved.config.enabled && ['stopped', 'failed'].includes(feishuStream.status().state)) restartFeishu();
        const connection = feishuStream.status();
        return { ...saved, status: { ...status, events: connection.events, lastEventAt: connection.lastEventAt, connection, callback: channels.callbackStatus('feishu') } };
      }
      case 'connectionConfigure': return management.patchConnection(input, peer);
      case 'connectionCredential': {
        const channel = input.channel || 'feishu';
        if (!channelDefinition(channel).fields.some(field => field.key === input.field && field.key.endsWith('Ref'))) throw new Error('未知渠道凭据字段');
        return channelCredentials.save({ channel, field: input.field, secret: input.secret });
      }
      case 'connectionAction': {
        const principal = peer?.principal?.kind === 'owner'
          ? { ...peer.principal, id: 'desktop-owner' } : peer?.principal;
        if (input.channel === 'feishu') {
          if (input.operation === 'listChats') return feishu.listChats({ pageToken: input.pageToken });
          throw new Error('飞书不支持此操作');
        }
        const channel = input.channel, adapter = channels.get(channel);
        if (!adapter) throw new Error('链接渠道不可用');
        if (typeof adapter.action === 'function') return adapter.action({ ...input, ownerAuthenticated: principal?.kind === 'owner' }, { principal });
        if (typeof adapter.operation === 'function') return adapter.operation(input, { principal });
        throw new Error('此链接不支持该操作');
      }
      case 'capabilities': return capabilities();
      case 'tasks': return { tasks: projectTasks(orchestrationRuntime.state({ newestFirst: true, archived: input.archived, taskId: input.taskId, limit: input.limit, offset: input.offset })) };
      case 'executionSummaryActivity': return { config: executionSummaries.config,
        ...store.orchestration.auxiliaryActivities({ taskId: input.taskId, after: input.after, limit: input.limit }) };
      case 'taskUpdate': return taskManagement.update(input);
      case 'taskCleanupPreview':
      case 'taskCleanupCommit':
      case 'taskCleanupRestorePreview':
      case 'taskCleanupRestore':
      case 'taskCleanupHistory': return management.cleanup(input, peer);
      case 'settingsCatalog':
      case 'settingsRead':
      case 'settingsPrepare':
      case 'settingsCommit':
      case 'settingsHistory':
      case 'settingsRollback': return management.dispatch(input, peer);
      case 'connectionReplies': return { replies: store.orchestration.directReplies({ channel: input.channel, threadId: input.threadId, limit: 100 })
        .map(({ id, triggerId, threadId, kind, text, state, attempts, lastError, receipt }) => ({ id, triggerId, threadId, kind, text, state, attempts, lastError, receipt })) };
      case 'directReplyReconcile':
      case 'outboxReconcile': {
        if (peer?.principal?.kind !== 'owner') throw Object.assign(new Error('投递核实需要已认证的主人身份'), { status: 403, code: 'OWNER_REQUIRED' });
        const reconcile = input.action === 'directReplyReconcile' ? store.orchestration.reconcileDirectReply : store.orchestration.reconcileOutbox;
        return reconcile(input.id, { attempts: input.attempts, outcome: input.outcome,
          evidence: input.evidence, receipt: input.receipt });
      }
      case 'evaluations': {
        const result = evaluations.list({ after: input.after, limit: input.limit });
        return { ...result, candidates: taskManagement.project('evaluation', result.candidates) };
      }
      case 'evaluationHistory': return evaluations.history(input.candidateId);
      case 'evaluationDispose': return evaluations.dispose({ ...input, action: input.disposition }, { kind: 'human', actorId: peer?.principal?.deviceId ? `device:${peer.principal.deviceId}` : 'desktop-owner' });
      case 'taskStop': return store.orchestration.cancelTask(input.taskId);
      case 'taskPause': return store.orchestration.pauseTask(input.taskId);
      case 'taskResume': {
        const task = store.orchestration.getTask(input.taskId);
        if (!task) throw new Error('任务不存在');
        if (!task.executionControl?.paused && !task.executionControl?.pauseRequested) {
          const pending = orchestrationRuntime.state({ taskId: task.id })[0]?.execution?.uncertainty;
          if (pending) return orchestrationRuntime.manageExecution({ taskId: task.id, assignmentId: pending.assignmentId,
            fence: pending.fence, instructionRevision: pending.instructionRevision, operation: 'resume', automatic: false });
        }
        return store.orchestration.resumeTask(task.id);
      }
      case 'taskAnswer': return store.orchestration.answerDesktopAttention(input);
      case 'taskChange': {
        const original = JSON.stringify(input), ownerAgent = await engine.ensureSession({ threadId });
        return taskChanges.submitForm(JSON.parse(original), { ownerAgent, threadId, original });
      }
      case 'summarize': return auxiliary.summarize({ threadId, text: input.text });
      case 'analyzeImage': return auxiliary.analyzeImage({ threadId, file: input.file, question: input.question });
      case 'ensure': return { sessionId: (await engine.ensureSession({ threadId })).id };
      case 'requestState': return engine.requestState(threadId);
      case 'history': {
        await projectSchedules();
        const history = await engine.history(threadId, { before: input.before, limit: input.limit });
        const notifications = database.chatNotifications(threadId, { after: input.afterSeq || 0, limit: input.notificationLimit || 100 }).events.map(event => {
          if (!['task.attention', 'task.result'].includes(event.type) || !event.taskId) return event;
          const task = store.orchestration.getTask(event.taskId);
          if (!task || task.mandate.source?.channel !== 'desktop' || (task.mandate.source.threadId || 'main') !== threadId) return event;
          const result = store.orchestration.results(task.id).findLast(item => item.version === task.resultVersion
            && (item.instructionRevision ?? 1) === task.instructionRevision);
          const currentResult = result ? { version: result.version, instructionRevision: result.instructionRevision ?? 1,
            outcome: result.outcome } : null;
          const attentions = store.orchestration.attentions(task.id).map(item => ({ ...item,
            instructionRevision: item.instructionRevision ?? store.orchestration.getAssignment(item.assignmentId)?.instructionRevision ?? 1 }));
          const currentAttention = task.status !== 'completed' && !taskStopped(task) ? attentions.find(item => item.state === 'waiting'
            && !item.answerTriggerId && item.instructionRevision === task.instructionRevision) || null : null;
          const current = { ...event, taskStatus: task.status, executionSession: executionSessionProjection(store.orchestration, task.id), currentInstructionRevision: task.instructionRevision,
            currentResultVersion: task.resultVersion,
            currentResult, currentAttention, currentPauseReason: task.pauseReason || null, currentExecutionControl: task.executionControl,
            currentContinuationWait: task.continuationWait || null };
          if (event.type !== 'task.attention' || !event.attentionId) return current;
          const attention = attentions.find(item => item.id === event.attentionId);
          if (!attention) return current;
          return { ...current, attention };
        });
        const scope = reactionScope(threadId, history.sessionId);
        return { ...history, reactions: database.messageReactions(scope), assistantReactions: database.assistantReactions(scope), notifications };
      }
      case 'messageReaction': return setMessageReaction({ engine, database }, { threadId, messageKey: input.messageKey, emoji: input.emoji });
      case 'send': return engine.send({ threadId, text: input.text, requestId: input.requestId, replyContext: input.replyContext });
      case 'cancel': return engine.cancel(threadId);
      case 'resetMain': {
        if (threadId !== 'main') throw new Error('仅支持清理主聊天');
        return engine.resetMain();
      }
      case 'createThread': return engine.createThread({ title: input.title });
      case 'renameThread': return engine.updateThread(threadId, { title: input.title });
      case 'archiveThread': return engine.updateThread(threadId, { archived: input.archived ?? true });
      case 'pinThread': return engine.updateThread(threadId, { pinned: input.pinned ?? true });
      case 'deleteThread': return engine.deleteThread(threadId);
      case 'deleteArchivedThreads': return engine.deleteArchivedThreads();
      case 'bringToMain': {
        if (threadId === 'main' || typeof input.text !== 'string' || !input.text.trim()) throw new Error('请选择旁聊并填写摘要');
        const thread = (await store.getState()).threads.find(row => row.id === threadId);
        if (!thread) throw new Error('旁聊不存在');
        return engine.send({ threadId: 'main', text: `旁聊摘要（来源：${thread.title}，${threadId}）：\n${input.text}`, requestId: input.requestId });
      }
      case 'config': return management.patchAssistant(input, peer);
      case 'profileInfo': return store.profileInfo();
      case 'profileExport': return store.profileExport();
      case 'profileImport': return store.profileImport(input.bundle, { apply: input.apply === true, overwrite: input.overwrite === true, includeMemories: input.includeMemories !== false });
      case 'profileDocuments': return profileDocuments(store, input, { kind: 'user', threadId });
      case 'memorySearch': return { memories: await store.memory.search(input) };
      case 'sessionSearch': return historySearch.search(input, queryOptions);
      case 'sessionHistory': return historySearch.history(input, queryOptions);
      case 'sessionList': return historySearch.sessions(input, queryOptions);
      case 'ledgerRead': return readLedger(input, queryOptions);
      case 'ownedSkills': return { available: !!skillProvider, skills: store.ownedSkills.list() };
      case 'ownedSkillAudit': return { events: store.ownedSkills.audit(input.id) };
      case 'ownedSkillApprove':
        if (!skillProvider) throw new Error('当前未启用官方技能服务，无法启用技能');
        return store.ownedSkills.approve(input.id, { revision: input.revision });
      case 'ownedSkillReject': return store.ownedSkills.reject(input.id, { revision: input.revision });
      case 'ownedSkillPin': return store.ownedSkills.pin(input.id, { revision: input.revision, pinned: input.pinned });
      case 'ownedSkillRestore':
        if (!skillProvider) throw new Error('当前未启用官方技能服务，无法恢复技能');
        return store.ownedSkills.restore(input.id, { revision: input.revision, snapshotSeq: input.snapshotSeq });
      case 'memoryForget': return { removed: await store.memory.forget(input.id, { revision: input.revision }) };
      case 'memoryLearning': return input.patch ? management.patchLearning(input, peer) : store.memory.learning();
      case 'review': {
        if (input.op === 'enqueue') {
          if (input.kind !== 'learning') throw new Error('未知后台整理任务');
          return store.review.enqueue({ kind: 'learning', payload: { task: 'memory-upkeep', trigger: 'explicit' } });
        }
        return input.op === 'budget' ? store.review.budget() : store.review.list(input);
      }
      case 'reviewClaim': return store.review.claim(input);
      case 'reviewComplete': return store.review.complete(input.id, input);
      case 'reviewFail': return store.review.fail(input.id, input);
      case 'memorySave': return store.saveMemory({ ...input.memory, source: input.memory?.source ?? { kind: 'user', threadId } }, { revision: input.revision });
      case 'memoryDelete': return { removed: await store.memory.forget(input.id, { revision: input.revision }) };
      case 'artifacts': {
        return artifacts.list({ after: input.after, limit: input.limit, category: input.category });
      }
      case 'artifactDelete': return artifacts.manage({ ...input, op: 'delete' });
      case 'artifactRename': return artifacts.manage({ ...input, op: 'rename' });
      case 'artifactCopy': return artifacts.manage({ ...input, op: 'copy' });
      case 'systemFiles': {
        if (input.op === 'openDirectory') return systemFiles.openDirectory({ path: input.path, signal: shutdown.signal });
        if (input.op === 'read') return systemFiles.read({ path: input.path });
        if (input.op && input.op !== 'list') throw new Error('不支持的系统文件操作');
        return systemFiles.list({ path: input.path });
      }
      case 'catalog': {
        const catalog = await engine.catalog();
        return { projects: ctx.workspaceRegistry.list().map(project => ({ id: String(project.id), title: project.title, path: project.path })), providers: catalog.map(({ models, ...provider }) => provider), models: catalog.flatMap(provider => provider.models.map(model => ({ ...model, provider: provider.id }))) };
      }
      case 'notifications':
      case 'notificationSync': {
        await projectSchedules();
        return database.notifications({ after: input.afterSeq || 0, limit: input.limit || 100, threadId, unread: input.unread === true });
      }
      case 'notificationOption': return replyNotificationOption({ database, orchestration: store.orchestration, engine }, { eventId: input.eventId, threadId, text: input.text });
      case 'notificationRead': return database.markRead(input.eventIds || []);
      case 'notificationAck': {
        const deviceId = peer?.principal?.deviceId;
        if (!deviceId) throw new Error('设备身份不可用，请通过已配对 Link 调用');
        return database.ackDeliveries(input.eventIds || [], deviceId);
      }
      case 'notificationDelivered': {
        const deviceId = peer?.principal?.deviceId;
        if (!deviceId) throw new Error('设备身份不可用，请通过已配对 Link 调用');
        const ids = Array.isArray(input.eventIds) ? input.eventIds : [];
        for (const eventId of ids) {
          const targets = database.deliveryTargets(eventId);
          if (!targets.some(row => row.deviceId === deviceId)) database.registerDeliveryTargets(eventId, [deviceId]);
          database.deliveryTargetAttempt(eventId, deviceId, { delivered: true });
        }
        return { eventIds: ids, deviceId, delivered: true };
      }
      case 'goalCreate': {
        const submitted = input.goal || input;
        if (typeof submitted.requestId !== 'string' || !submitted.requestId.trim() || submitted.requestId.length > 200) throw new Error('新建目标需要稳定 requestId');
        return goals.createGoal({ ...submitted, ownerSessionId: null, threadId, requestId: JSON.stringify(['goal-checklist', submitted.requestId]) });
      }
      case 'goalList': return { goals: taskManagement.project('goal', goals.goals()) };
      case 'goalGet': return goals.getGoal(input.id);
      case 'goalUpdate': return goals.updateGoal(input.id, input.patch || {}, { rowVersion: input.rowVersion });
      case 'compact': return engine.compact(threadId);
      default: throw new Error('未知总助手操作');
    }
  };
}
