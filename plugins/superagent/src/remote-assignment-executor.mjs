import { createHash, randomUUID } from 'node:crypto';
import { validateTaskMandate } from './assessment-policy.mjs';
import { attentionAnswer } from './worker-attention.mjs';
import { taskPaused, taskStopped } from './task-lifecycle.mjs';
import { redactExecutionText } from '../../base/shared/execution-text.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const requestKey = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const phaseOf = phase => ({ accepted: 'submitted', stopped: 'cancelled' })[phase] || phase;
const phases = new Set(['prepared', 'submitted', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled', 'uncertain']);
const ended = phase => ['completed', 'failed', 'cancelled'].includes(phase);
const identityKeys = ['ownerHostId', 'taskId', 'assignmentId', 'runId', 'fence'];
const workerStatuses = new Set(['running', 'waiting', 'completed', 'failed', 'cancelled', 'unknown']);
const observationTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
function progressActivity(value) {
  if (!workerStatuses.has(value?.status) || typeof value.activity !== 'string'
    || !['runtime', 'report'].includes(value.activitySource)) return null;
  return { status: value.status, activity: redactExecutionText(value.activity, 120), activitySource: value.activitySource };
}
function progressWorker(value, label) {
  const activity = progressActivity(value);
  if (!activity || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 512 || !Array.isArray(value.history)) return null;
  let seq = -1;
  const history = [];
  for (const item of value.history.slice(-64)) {
    const entry = progressActivity(item);
    if (!entry || !Number.isSafeInteger(item.seq) || item.seq <= seq) continue;
    seq = item.seq;
    history.push({ ...entry, seq, time: observationTime(item.time) });
  }
  return { ...activity, id: value.id, label, updatedAt: observationTime(value.updatedAt), history,
    historyTruncated: value.historyTruncated === true || value.history.length > 64 };
}
function executionProgress(data, sessionId) {
  if (data?.worker?.id !== sessionId || !Array.isArray(data.children)) return null;
  const worker = progressWorker(data.worker, '主 Worker');
  if (!worker) return null;
  const seen = new Set([sessionId]), children = [];
  for (const candidate of data.children.slice(0, 32)) {
    const child = progressWorker(candidate, '子 Worker ' + (children.length + 1));
    if (!child || seen.has(child.id)) continue;
    seen.add(child.id);
    children.push(child);
  }
  return { worker, children };
}
// The authenticated peer judged this exact submit unacceptable. Resending the same bytes can never be accepted,
// so the owner Task fails with the peer's reason instead of retrying forever. Capacity, outages and network
// errors are not listed: they keep the saved submit pending.
const refusedCodes = new Set(['UNSUPPORTED_EXECUTION_PROTOCOL', 'UNSUPPORTED_EXECUTION_CONFIG', 'INVALID_EXECUTION_CONFIG', 'INVALID_EXECUTION_REQUEST',
  'INVALID_EXECUTION_REVISION', 'EXECUTION_MODEL_UNAVAILABLE', 'EXECUTION_MODEL_MISMATCH', 'EXECUTION_ADAPTER_UNAVAILABLE', 'EXECUTION_ROUTE_UNAVAILABLE',
  'NATIVE_WORKER_SCOPE_UNSUPPORTED', 'EXECUTION_PROJECT_UNAVAILABLE', 'EXECUTION_PROJECT_CHANGED', 'EXECUTION_CONFIG_CHANGED', 'EXECUTION_HOST_CHANGED',
  'EXECUTION_PAYLOAD_TOO_LARGE', 'LINK_REQUEST_TOO_LARGE']);
const refused = error => refusedCodes.has(error?.code) || [413, 422].includes(error?.status ?? error?.statusCode);

/** A owns the complete Task; peer RPCs only operate its one frozen execution. */
export function createRemoteAssignmentExecutor({ ctx, database, readPolicy, commitResult, signal, now = Date.now,
  requestTimeoutMs = 5000, pollMs = 1000, batchSize = 8, concurrency = 4 } = {}) {
  const owner = `remote-observer:${randomUUID()}`, shutdown = new AbortController();
  const management = new Set();
  let running;
  const ownership = assignment => ({ owner: assignment.owner, fence: assignment.fence, now: now() });
  const remoteOf = assignment => database.remoteExecution(assignment.id);
  const patch = (assignment, value) => database.recordRemoteExecution(assignment.id, { ...ownership(assignment), patch: value });
  const identity = (assignment, remote = remoteOf(assignment)) => ({ ownerHostId: database.ownerHostId(), taskId: assignment.taskId,
    assignmentId: assignment.id, runId: remote.runId, fence: assignment.fence });
  async function call(assignment, input, requestSignal) {
    // Each observation may make several peer calls, each bounded by its own timeout.
    database.renewRemoteObservation(assignment.id, ownership(assignment));
    return callPeer(remoteOf(assignment), input, requestSignal);
  }
  async function callPeer(remote, input, requestSignal) {
    const link = ctx.get?.('benchgoLink');
    if (!link?.callDevice) throw fail('LINK_UNAVAILABLE', 'Link 执行连接不可用');
    const signals = [shutdown.signal, ...(signal ? [signal] : []), ...(requestSignal ? [requestSignal] : []), AbortSignal.timeout(requestTimeoutMs)];
    return link.callDevice({ deviceId: remote.deviceId, expectedHostId: remote.hostId,
      expectedAuthorizationId: remote.authorizationId, input: { action: 'execution', version: remote.protocolVersion, ...input },
      signal: AbortSignal.any(signals) });
  }
  function verify(assignment, response) {
    const remote = remoteOf(assignment), execution = response?.execution, expected = identity(assignment, remote);
    if (response?.version !== remote.protocolVersion || !execution || (execution.id ?? execution.executionId) !== remote.executionId
      || execution.sessionId !== remote.sessionId || identityKeys.some(key => execution.identity?.[key] !== expected[key])
      || !phases.has(phaseOf(execution.phase)) || !Array.isArray(response.events)
      || !Number.isSafeInteger(response.cursor) || response.cursor < remote.cursor)
      throw fail('REMOTE_EXECUTION_IDENTITY_CHANGED', '执行回执身份、版本或水位不匹配，未接纳该事实');
    const project = database.getTask(assignment.taskId).mandate.project;
    if (project && (execution.project?.id !== project.id || execution.project.path !== project.path || execution.workingDirectory !== project.path))
      throw fail('REMOTE_EXECUTION_PROJECT_CHANGED', '执行设备没有使用工单冻结的原始工作区');
    let cursor = remote.cursor;
    for (const event of response.events) {
      if (!Number.isSafeInteger(event.seq) || event.seq !== cursor + 1 || event.seq > response.cursor)
        throw fail('REMOTE_EVENT_GAP', '执行事件存在缺口，未推进已保存水位');
      cursor = event.seq;
    }
    if (cursor !== response.cursor) throw fail('REMOTE_EVENT_GAP', '执行事件水位与实际事件不符');
    return execution;
  }
  function command(assignment, operation, payload, key) {
    const remote = remoteOf(assignment), requestId = requestKey(remote.executionId, operation, key);
    return database.recordRemoteCommand(assignment.id, { ...ownership(assignment), requestId, operation,
      payload: { ...payload, requestId } });
  }
  function applied(assignment, event) {
    const data = event.data || {};
    if (!data.requestId) return; // The initial snapshot is already frozen in the A Run.
    const saved = database.remoteCommand(assignment.id, data.requestId);
    if (saved?.operation === 'submit' && data.instructionRevision === saved.payload.requirements.instructionRevision) {
      if (assignment.redispatchOfAssignmentId) {
        const remote = remoteOf(assignment);
        database.acknowledgeRemoteRevision(assignment.id, { ...ownership(assignment), runId: remote.runId,
          executionId: remote.executionId, requestId: saved.requestId, instructionRevision: data.instructionRevision,
          boundaryId: `remote:${event.seq}` });
      }
      return;
    }
    if (!saved || saved.operation !== 'input' || !Number.isSafeInteger(data.instructionRevision)
      || (saved.payload.kind === 'context' ? data.instructionRevision < saved.payload.instructionRevision : data.instructionRevision !== saved.payload.instructionRevision))
      throw fail('REMOTE_INPUT_ACK_MISMATCH', '执行设备确认了不属于当前输入的版本');
    if (saved.state !== 'receipted') database.finishRemoteCommand(assignment.id, { ...ownership(assignment),
      requestId: saved.requestId, receipt: { state: 'applied', instructionRevision: data.instructionRevision,
        boundaryId: `remote:${event.seq}` } });
    const remote = remoteOf(assignment), application = { ...ownership(assignment), assignmentId: assignment.id,
      runId: remote.runId, sessionId: remote.sessionId, boundaryId: `remote:${event.seq}`, requestId: saved.requestId };
    if (saved.payload.kind === 'revision') database.acknowledgeRemoteRevision(assignment.id, { ...application,
      executionId: remote.executionId, instructionRevision: data.instructionRevision });
    const subscriptions = saved.payload.kind === 'context' ? new Set(database.pendingSubscriptionMessages(assignment.taskId).map(row => row.id)) : new Set();
    for (const triggerId of saved.payload.triggerIds || []) {
      if (subscriptions.has(triggerId)) database.acknowledgeSubscriptionMessage(assignment.id, { ...application, triggerId, messageId: saved.requestId });
      else database.applyTaskInput(triggerId, application);
    }
  }
  // One page is one fact. Its effects, the cursor and the observed phase commit together, so a crash or a bad event
  // can neither replay an applied event nor leave a half-read page behind.
  async function consume(assignment, response) { return database.observeRemotePage(() => consumePage(assignment, response)); }
  function consumePage(assignment, response) {
    const execution = verify(assignment, response), remote = remoteOf(assignment);
    let result = remote.result;
    for (const event of response.events) {
      const progress = event.kind === 'execution.progress' ? executionProgress(event.data, remote.sessionId) : null;
      if (event.kind === 'instruction.applied') applied(assignment, event);
      if (event.kind === 'question.superseded') {
        const question = remoteOf(assignment).question;
        if (question && event.data?.questionId === question.questionId) {
          database.supersedeRemoteAttention(assignment.id, { ...ownership(assignment), sessionId: remote.sessionId,
            callId: question.callId, questionId: question.questionId });
          const pending = database.remoteCommand(assignment.id, requestKey(remote.executionId, 'input', `answer:${question.questionId}`));
          if (pending?.state === 'pending') database.finishRemoteCommand(assignment.id, {
            ...ownership(assignment), requestId: pending.requestId, receipt: { state: 'superseded' } });
          patch(assignment, { question: null });
        }
      }
      if (event.kind === 'question') {
        const question = event.data;
        if (!question?.questionId || !question.callId || !Array.isArray(question.questions))
          throw fail('REMOTE_QUESTION_INVALID', '执行问题缺少官方问题身份');
        // A newer owner revision invalidates this old question; it is retained
        // in peer history, while the new snapshot reaches the original session.
        if (question.instructionRevision === database.getTask(assignment.taskId).instructionRevision) {
          const run = database.runs(assignment.id).find(row => row.id === remote.runId);
          if (run.state === 'prepared') database.observeRemoteRun(assignment.id, { ...ownership(assignment), executionId: remote.executionId,
            sessionId: remote.sessionId, cursor: remoteOf(assignment).cursor, state: 'running', evidence: { ...execution } });
          database.openAttention(assignment.id, { ...ownership(assignment), sessionId: remote.sessionId,
            callId: question.callId, questions: question.questions });
          patch(assignment, { question });
        }
      }
      if (event.kind === 'result') {
        if (event.data?.sessionId !== remote.sessionId || !Number.isSafeInteger(event.data.instructionRevision)
          || !event.data.transcript || !event.data.completion)
          throw fail('REMOTE_RESULT_INVALID', '执行结果没有绑定原会话或真实结束事实');
        result = { ...event.data, runId: remote.runId, sessionId: remote.sessionId, directory: `remote:${remote.deviceId}:${remote.sessionId}` };
        database.saveWorkerDraft(assignment.id, { ...ownership(assignment), runId: remote.runId, result });
      }
      patch(assignment, { cursor: event.seq, ...(result ? { result } : {}), ...(progress ? { progress } : {}) });
    }
    // A response snapshot may be ahead of its bounded event page. Do not
    // publish terminal state until the corresponding result/events are stored.
    const observedPhase = response.hasMore ? (remoteOf(assignment).phase === 'prepared' ? 'submitted' : remoteOf(assignment).phase) : phaseOf(execution.phase);
    if (observedPhase === 'paused' && !execution.evidence?.transcript)
      throw fail('REMOTE_PAUSE_UNVERIFIED', '远端暂停尚无已保存的官方会话边界');
    const evidence = observedPhase === 'paused' ? { ...execution.evidence, runId: remote.runId,
      sessionId: remote.sessionId, waitingPause: true } : result || { ...execution };
    database.observeRemoteRun(assignment.id, { ...ownership(assignment), executionId: remote.executionId,
      sessionId: remote.sessionId, cursor: response.cursor, state: observedPhase, evidence });
    patch(assignment, { available: true, code: null, failures: 0, hasMore: response.hasMore === true,
      appliedInstructionRevision: execution.appliedInstructionRevision,
      receivedInstructionRevision: execution.receivedInstructionRevision, ...(result ? { result } : {}) });
    return execution;
  }
  async function send(assignment, entry, requestSignal) {
    const remote = remoteOf(assignment);
    const input = entry.operation === 'submit' ? { operation: 'submit', ...entry.payload }
      : entry.operation === 'input' ? { operation: 'input', executionId: remote.executionId, ...entry.payload }
        : { operation: 'control', executionId: remote.executionId, control: entry.operation, ...entry.payload };
    const response = await call(assignment, { ...input, after: remote.cursor, limit: 100 }, requestSignal);
    // Cursor/pagination are transport reads, not part of command identity.
    await consume(assignment, response);
    if (entry.operation !== 'input' && entry.state !== 'receipted') database.finishRemoteCommand(assignment.id, {
      ...ownership(assignment), requestId: entry.requestId, receipt: { accepted: true } });
  }
  function enqueueInputs(assignment) {
    const task = database.getTask(assignment.taskId), remote = remoteOf(assignment), pending = database.pendingTaskInputs(task.id);
    const acceptsChanges = task.mandate.execution.config.harness === 'official' || task.mandate.execution.nativeContinuation === true;
    const revisionInputs = acceptsChanges ? pending.filter(row => ['revision', 'authorization'].includes(row.kind)) : [];
    const pendingRevision = database.remoteCommands(assignment.id, { state: 'pending', operation: 'input', limit: 200 })
      .some(row => row.payload.kind === 'revision');
    if (!pendingRevision && revisionInputs.length && task.instructionRevision > (remote.receivedInstructionRevision ?? assignment.instructionRevision)) {
      command(assignment, 'input', { kind: 'revision', instructionRevision: task.instructionRevision, text: task.target,
        requirements: { instructionRevision: task.instructionRevision, target: task.target, acceptance: task.acceptance,
          mandate: task.mandate, context: task.context || [], executionScope: assignment.wholeTaskScope === false ? assignment.text : task.target },
        triggerIds: revisionInputs.filter(row => row.instructionRevision <= task.instructionRevision).map(row => row.triggerId) }, `revision:${task.instructionRevision}`);
    }
    if (task.instructionRevision > (remote.receivedInstructionRevision ?? assignment.instructionRevision)) return;
    const question = remote.question;
    if (question && question.instructionRevision === task.instructionRevision) {
      const entries = database.attentions(task.id).filter(row => row.state !== 'superseded' && row.sessionId === remote.sessionId && row.callId === question.callId);
      if (entries.length === question.questions.length && entries.every(row => row.answerTriggerId)) {
        const answers = question.questions.map(q => attentionAnswer(database, entries.find(row => row.question.id === q.id)));
        command(assignment, 'input', { kind: 'answer', questionId: question.questionId, answers,
          instructionRevision: question.instructionRevision, text: JSON.stringify(answers), triggerIds: entries.map(row => row.answerTriggerId) }, `answer:${question.questionId}`);
      }
    }
    if (!acceptsChanges) return;
    for (const input of pending.filter(row => row.kind === 'context').slice(0, 20)) {
      if (database.remoteCommand(assignment.id, requestKey(remote.executionId, 'input', `context:${input.id}`))) continue;
      const trigger = database.getTrigger(input.triggerId);
      if (trigger?.content?.trim()) command(assignment, 'input', { kind: 'context', instructionRevision: task.instructionRevision,
        text: input.snapshot?.text ?? trigger.content, triggerIds: [input.triggerId] }, `context:${input.id}`);
    }
  }
  async function reconcile(assignment, requestSignal) {
    let remote = remoteOf(assignment);
    const submit = database.remoteSubmitCommand(assignment.id);
    if (!submit) throw fail('REMOTE_SUBMIT_MISSING', '执行缺少已保存的原始提交命令');
    // Retry exactly the saved idempotent submit until a receipt exists. It can
    // never generate a second Run, session or peer execution.
    // A refused or absent execution is already settled locally: the peer holds nothing to read, acknowledge or control.
    const settled = ended(remote.phase) && (remote.observed?.absent === true || remote.observed?.abandoned === true);
    if (!settled && submit.state === 'pending') {
      try {
        await consume(assignment, await call(assignment, { operation: 'get', executionId: remote.executionId,
          after: remote.cursor, limit: 100 }, requestSignal));
        database.finishRemoteCommand(assignment.id, { ...ownership(assignment), requestId: submit.requestId, receipt: { accepted: true } });
      } catch (error) {
        if (error.code !== 'EXECUTION_NOT_FOUND') throw error;
        const task = database.getTask(assignment.taskId), policy = await readPolicy();
        if (taskStopped(task) || assignment.authorizationRevoked || !validateTaskMandate(task.mandate, { policy })) {
          database.observeRemoteRun(assignment.id, { ...ownership(assignment), executionId: remote.executionId,
            sessionId: remote.sessionId, cursor: remote.cursor, state: 'cancelled', evidence: { absent: true, reason: 'authenticated-execution-not-found' } });
          patch(assignment, { available: true });
        } else if (taskPaused(task)) {
          database.parkRemoteAssignment(assignment.id, { ...ownership(assignment), nextAt: now() + pollMs });
          return;
        } else {
          try { await send(assignment, submit, requestSignal); }
          catch (failure) { if (!refused(failure)) throw failure; refuse(assignment, failure); }
        }
      }
    } else if (!settled) await consume(assignment, await call(assignment, { operation: 'get', executionId: remote.executionId,
      after: remote.cursor, limit: 100 }, requestSignal));
    remote = remoteOf(assignment);
    if (!settled && remote.cursor > (remote.ackThrough || 0)) {
      await call(assignment, { operation: 'ack', executionId: remote.executionId, through: remote.cursor }, requestSignal);
      patch(assignment, { ackThrough: remote.cursor });
      remote = remoteOf(assignment);
    }
    if (!remote.hasMore && !ended(remote.phase)) {
      const task = database.getTask(assignment.taskId), policy = await readPolicy();
      const revoked = assignment.authorizationRevoked || !validateTaskMandate(task.mandate, { policy });
      const desired = revoked || taskStopped(task) ? 'cancel' : taskPaused(task) ? 'pause'
        : remote.phase === 'paused' || remote.observed?.pauseRequested ? 'resume' : null;
      if (!revoked && !taskStopped(task) && !taskPaused(task) && remote.phase !== 'uncertain') {
        enqueueInputs(assignment);
        for (const entry of database.remoteCommands(assignment.id, { state: 'pending', operation: 'input', limit: desired === 'resume' ? 200 : 4 })) {
          await send(assignment, entry, requestSignal);
          if (remoteOf(assignment).hasMore || ended(remoteOf(assignment).phase)) break;
        }
      }
      remote = remoteOf(assignment);
      if (desired && !remote.hasMore && !ended(remote.phase) && (remote.phase !== 'uncertain' || desired === 'cancel')
        && (desired !== 'resume' || remote.phase === 'paused') && !(desired === 'pause' && remote.phase === 'paused')
        && !(desired === 'cancel' && remote.observed?.sessionArchived && remote.observed?.cancelRequested)) {
        const previous = database.remoteControlCommand(assignment.id);
        const entry = previous?.operation === desired ? previous : command(assignment, desired, {}, previous?.requestId || 'initial');
        if (entry.state === 'pending') await send(assignment, entry, requestSignal);
      }
      // An official peer that durably accepted the stop denies every later tool, input and
      // resume of this execution. Its unverified result boundary must not hold the owner's stop open.
      const accepted = remoteOf(assignment), control = database.remoteControlCommand(assignment.id);
      if (desired === 'cancel' && accepted.phase === 'uncertain' && !accepted.hasMore && accepted.observed?.cancelRequested === true
        && control?.operation === 'cancel' && control.state === 'receipted' && task.mandate.execution?.config?.harness === 'official') {
        database.observeRemoteRun(assignment.id, { ...ownership(assignment), executionId: accepted.executionId, sessionId: accepted.sessionId,
          cursor: accepted.cursor, state: 'cancelled', evidence: { ...accepted.observed, stopAccepted: true } });
      }
    }
    remote = remoteOf(assignment);
    if (!remote.hasMore && ended(remote.phase)) {
      if (remote.result) {
        await commitResult(remote.result, { assignment: database.getAssignment(assignment.id), task: database.getTask(assignment.taskId) });
      } else if (remote.phase === 'failed') {
        database.recordAssignmentFailure(assignment.id, { ...ownership(assignment), stage: 'execution', code: remote.observed?.error?.code || 'REMOTE_EXECUTION_FAILED',
          message: remote.observed?.error?.message || '远端执行失败，未重派', effects: remote.observed?.executionEffects });
      }
      if (database.getAssignment(assignment.id)?.state === 'claimed') {
        database.confirmExecutionStopped(assignment.id, ownership(assignment));
        if (database.getAssignment(assignment.id)?.state === 'claimed') database.finishAssignment(assignment.id, {
          ...ownership(assignment), status: remote.phase === 'completed' ? 'completed' : remote.phase === 'failed' ? 'failed' : 'cancelled' });
      }
      return;
    }
    if (!remote.hasMore && remote.phase === 'paused' && database.getTask(assignment.taskId).executionControl?.pauseRequested) {
      const run = database.runs(assignment.id).find(row => row.id === remote.runId);
      database.confirmExecutionStopped(assignment.id, ownership(assignment));
      database.parkPause(assignment.id, { ...ownership(assignment), result: run.evidence });
      return;
    }
    database.parkRemoteAssignment(assignment.id, { ...ownership(assignment), nextAt: now() + (remote.hasMore ? 0 : pollMs) });
  }
  function refuse(assignment, error) {
    const remote = remoteOf(assignment), code = error.code || 'REMOTE_SUBMIT_REFUSED';
    database.observeRemoteRun(assignment.id, { ...ownership(assignment), executionId: remote.executionId, sessionId: remote.sessionId, cursor: remote.cursor,
      state: 'failed', evidence: { absent: true, reason: 'peer-refused-submit', refusedCode: code,
        error: { code: 'REMOTE_SUBMIT_REFUSED', message: `目标设备拒绝了这次派发（${code}）：${error.message}` },
        executionEffects: { effectsVerified: true, unknownCallIds: [] } } });
    patch(assignment, { available: true, code, failures: 0 });
  }
  // Neither device can verify this execution. The owner's explicit decision ends it: it is recorded as failed with
  // unknown effects, the peer is no longer polled, and the Task is released for a change or a new dispatch.
  function abandon(assignment) {
    const remote = remoteOf(assignment), message = '执行设备一直无法核实这次执行的结果，已按你的决定按失败处理；执行设备上可能留有未完成的改动';
    database.observeRemoteRun(assignment.id, { ...ownership(assignment), executionId: remote.executionId, sessionId: remote.sessionId, cursor: remote.cursor,
      state: 'failed', evidence: { abandoned: true, reason: 'owner-abandoned-unverified-execution',
        error: { code: 'REMOTE_EXECUTION_ABANDONED', message },
        executionEffects: { effectsVerified: false, ownerAbandoned: true, unknownCallIds: [] } } });
    patch(assignment, { available: true, code: 'REMOTE_EXECUTION_ABANDONED', failures: 0, hasMore: false });
  }
  function unavailable(assignment, error) {
    if (database.getAssignment(assignment.id)?.state !== 'claimed') return;
    const remote = remoteOf(assignment), failures = (remote.failures || 0) + 1;
    patch(assignment, { available: false, code: error.code || 'REMOTE_OBSERVATION_UNAVAILABLE', failures });
    database.parkRemoteAssignment(assignment.id, { ...ownership(assignment), nextAt: now() + Math.min(30000, pollMs * 2 ** Math.min(failures, 5)) });
  }
  async function execute(assignment, { task, signal: requestSignal } = {}) {
    if (assignment.executor !== 'remote' || !task?.mandate?.execution) throw fail('REMOTE_EXECUTION_REQUIRED', '派工缺少冻结远端执行配置');
    const executionId = randomUUID(), sessionId = randomUUID(), execution = task.mandate.execution;
    const run = database.prepareRun(assignment.id, { ...ownership(assignment), sessionId,
      directory: `remote:${execution.deviceId}:${sessionId}`, ...(task.mandate.project?.path ? { workingDirectory: task.mandate.project.path } : {}) });
    patch(assignment, { runId: run.id, executionId, sessionId, deviceId: execution.deviceId, protocolVersion: execution.protocolVersion,
      hostId: execution.hostId, authorizationId: execution.authorizationId, phase: 'prepared', cursor: 0 });
    const snapshot = database.appliedTaskSnapshot(assignment.id);
    const submit = command(assignment, 'submit', { executionId, sessionId, identity: identity(assignment), config: execution.config,
      ...(task.mandate.project ? { projectId: task.mandate.project.id } : {}), text: snapshot.executionScope || assignment.text || task.target,
      requirements: snapshot }, 'initial');
    try { await send(assignment, submit, requestSignal); }
    catch (error) {
      if (!refused(error)) { unavailable(assignment, error); return { remotePending: true }; }
      refuse(assignment, error);
    }
    database.parkRemoteAssignment(assignment.id, { ...ownership(assignment), nextAt: now() });
    return { remotePending: true };
  }
  async function cycle() {
    const candidates = [
      ...database.pendingDetachedRemoteStops({ now: now(), limit: batchSize }).map(entry => ({ detachedStop: entry })),
      ...database.remoteExecutionCandidates({ now: now(), limit: batchSize }),
    ];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
      for (;;) {
        const candidate = candidates[next++];
        if (!candidate || shutdown.signal.aborted || signal?.aborted) return;
        if (candidate.detachedStop) {
          await deliverDetachedStop(candidate.detachedStop);
          continue;
        }
        let assignment;
        try {
          assignment = database.claimRemoteAssignment(candidate.assignment.id, { owner, fence: candidate.assignment.fence, now: now() });
          await reconcile(assignment);
        } catch (error) {
          if (assignment) unavailable(assignment, error);
          ctx.logger?.warn?.(`远端执行核实待重试：${error.code || 'UNAVAILABLE'}`);
        }
      }
    }));
  }
  async function deliverDetachedStop(entry) {
    const assignment = database.getAssignment(entry.assignmentId), remote = remoteOf(assignment);
    let receipt;
    try {
      const response = await callPeer(remote, { operation: 'control', executionId: remote.executionId,
        control: 'cancel', requestId: entry.requestId, after: remote.cursor, limit: 1 });
      const execution = verify(assignment, response);
      if (ended(phaseOf(execution.phase))) receipt = { accepted: true, phase: phaseOf(execution.phase) };
      else if (execution.cancelRequested) receipt = { accepted: true };
    } catch (error) {
      // Both replies follow authentication of the frozen device. Neither can leave this execution running.
      if (['EXECUTION_NOT_FOUND', 'EXECUTION_INACTIVE'].includes(error.code)) receipt = { inactive: true, code: error.code };
    }
    const at = now();
    database.finishDetachedRemoteStop(entry, { now: at, nextAt: at + Math.max(pollMs, 5000), receipt });
  }
  return { execute,
    tick() { if (shutdown.signal.aborted || signal?.aborted) return Promise.resolve(); return running ||= cycle().finally(() => { running = undefined; }); },
    async manageExecution({ taskId, assignmentId, fence, instructionRevision, operation }) {
      const task = database.getTask(taskId), assignment = database.getAssignment(assignmentId), remote = assignment && remoteOf(assignment);
      if (!task || task.instructionRevision !== instructionRevision || assignment?.taskId !== taskId || assignment.fence !== fence || !remote)
        throw fail('REMOTE_EXECUTION_IDENTITY_CHANGED', '原执行身份或当前要求已变化');
      if (!['resume', 'abandon', 'redispatch'].includes(operation)) throw fail('UNSUPPORTED_EXECUTION_CONTROL', '仅支持核实原始执行、按失败处理或重新派发');
      if (operation === 'redispatch') {
        // The old execution is over. The same Task goes to the same device again as a new assignment; nothing is replayed.
        const policy = await readPolicy();
        const next = database.redispatchRemoteAssignment(taskId, { assignmentId, fence,
          validateMandate: mandate => validateTaskMandate(mandate, { policy }), now: now() });
        return { status: 'queued', taskId, assignmentId: next.id, previousAssignmentId: assignmentId };
      }
      if (shutdown.signal.aborted || signal?.aborted) throw fail('REMOTE_OBSERVER_STOPPED', '工单宿主正在关闭');
      // Explicit verification bypasses the background backoff, while preserving
      // the exact same observation lease and original execution identity.
      if (remote.phase === 'paused' && taskPaused(task)) database.resumeTask(taskId);
      const currentAssignment = database.getAssignment(assignmentId);
      if (currentAssignment.state === 'uncertain' || currentAssignment.state === 'claimed' && currentAssignment.leaseUntil <= now()) {
        const work = (async () => {
          const claimed = database.claimRemoteAssignment(assignmentId, { owner, fence, now: now() });
          try { await reconcile(claimed); } catch (error) { unavailable(claimed, error); }
        })();
        management.add(work);
        try { await work; } finally { management.delete(work); }
      }
      let current = remoteOf(assignment);
      // The execution was re-checked just above. Only one that is still unverified or unreachable may be abandoned:
      // an execution that is observably alive is stopped through its Task, not abandoned.
      if (operation === 'abandon' && !ended(current.phase) && (current.phase === 'uncertain' || current.available === false)) {
        const work = (async () => {
          const claimed = database.claimRemoteAssignment(assignmentId, { owner, fence, now: now() });
          // Best effort: a reachable peer is told to stop whatever may still run. Its answer is not taken as a fact.
          try { await call(claimed, { operation: 'control', executionId: current.executionId, control: 'cancel', requestId: requestKey(current.executionId, 'cancel', 'abandon') }); }
          catch { /* The owner's decision does not depend on the peer. */ }
          abandon(claimed);
          await reconcile(claimed);
        })();
        management.add(work);
        try { await work; } finally { management.delete(work); }
        current = remoteOf(assignment);
        return { status: 'abandoned', taskId, assignmentId, executionId: current.executionId, phase: current.phase };
      }
      return { status: current.available && current.phase !== 'uncertain' ? 'observed' : 'blocked', taskId, assignmentId,
        executionId: current.executionId, phase: current.phase,
        ...(current.phase === 'uncertain' ? { reason: '原会话执行边界尚未核实，未创建替代执行' } : {}) };
    },
    async stop() { shutdown.abort(); await Promise.allSettled([running, ...management]); },
  };
}
