import { createHash, randomUUID } from 'node:crypto';
import { validateTaskMandate } from './assessment-policy.mjs';
import { attentionAnswer } from './worker-attention.mjs';
import { taskPaused, taskStopped } from './task-lifecycle.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const requestKey = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const phaseOf = phase => ({ accepted: 'submitted', stopped: 'cancelled' })[phase] || phase;
const phases = new Set(['prepared', 'submitted', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled', 'uncertain']);
const ended = phase => ['completed', 'failed', 'cancelled'].includes(phase);
const identityKeys = ['ownerHostId', 'taskId', 'assignmentId', 'runId', 'fence'];

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
    const remote = remoteOf(assignment), link = ctx.get?.('benchgoLink');
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
    if (saved?.operation === 'submit' && data.instructionRevision === saved.payload.requirements.instructionRevision) return;
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
    for (const triggerId of saved.payload.triggerIds || []) database.applyTaskInput(triggerId, application);
  }
  async function consume(assignment, response) {
    const execution = verify(assignment, response), remote = remoteOf(assignment);
    let result = remote.result;
    for (const event of response.events) {
      if (event.kind === 'instruction.applied') applied(assignment, event);
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
      patch(assignment, { cursor: event.seq, ...(result ? { result } : {}) });
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
    const external = task.mandate.execution.config.harness !== 'official';
    const revisionInputs = external ? [] : pending.filter(row => ['revision', 'authorization'].includes(row.kind));
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
      const entries = database.attentions(task.id).filter(row => row.sessionId === remote.sessionId && row.callId === question.callId);
      if (entries.length === question.questions.length && entries.every(row => row.answerTriggerId)) {
        const answers = question.questions.map(q => attentionAnswer(database, entries.find(row => row.question.id === q.id)));
        command(assignment, 'input', { kind: 'answer', questionId: question.questionId, answers,
          instructionRevision: question.instructionRevision, text: JSON.stringify(answers), triggerIds: entries.map(row => row.answerTriggerId) }, `answer:${question.questionId}`);
      }
    }
    for (const input of (external ? [] : pending.filter(row => row.kind === 'context').slice(0, 20))) {
      if (database.remoteCommand(assignment.id, requestKey(remote.executionId, 'input', `context:${input.id}`))) continue;
      const trigger = database.getTrigger(input.triggerId);
      if (trigger?.content?.trim()) command(assignment, 'input', { kind: 'context', instructionRevision: task.instructionRevision,
        text: trigger.content, triggerIds: [input.triggerId] }, `context:${input.id}`);
    }
  }
  async function reconcile(assignment, requestSignal) {
    let remote = remoteOf(assignment);
    const submit = database.remoteSubmitCommand(assignment.id);
    if (!submit) throw fail('REMOTE_SUBMIT_MISSING', '执行缺少已保存的原始提交命令');
    // Retry exactly the saved idempotent submit until a receipt exists. It can
    // never generate a second Run, session or peer execution.
    if (submit.state === 'pending') {
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
        } else await send(assignment, submit, requestSignal);
      }
    } else await consume(assignment, await call(assignment, { operation: 'get', executionId: remote.executionId,
      after: remote.cursor, limit: 100 }, requestSignal));
    remote = remoteOf(assignment);
    if (remote.cursor > (remote.ackThrough || 0)) {
      await call(assignment, { operation: 'ack', executionId: remote.executionId, through: remote.cursor }, requestSignal);
      patch(assignment, { ackThrough: remote.cursor });
      remote = remoteOf(assignment);
    }
    if (!remote.hasMore && !ended(remote.phase)) {
      const task = database.getTask(assignment.taskId), policy = await readPolicy();
      const revoked = assignment.authorizationRevoked || !validateTaskMandate(task.mandate, { policy });
      const desired = revoked || taskStopped(task) ? 'cancel' : taskPaused(task) ? 'pause'
        : remote.phase === 'paused' || remote.observed?.pauseRequested ? 'resume' : null;
      if (desired && !(desired === 'pause' && remote.phase === 'paused') && (remote.phase !== 'uncertain' || desired === 'cancel')) {
        const previous = database.remoteControlCommand(assignment.id);
        const entry = previous?.operation === desired ? previous : command(assignment, desired, {}, previous?.requestId || 'initial');
        if (entry.state === 'pending') await send(assignment, entry, requestSignal);
      }
      if (!revoked && !taskStopped(task) && !taskPaused(task) && remoteOf(assignment).phase !== 'uncertain') {
        enqueueInputs(assignment);
        for (const entry of database.remoteCommands(assignment.id, { state: 'pending', operation: 'input', limit: 4 })) {
          if (entry.operation !== 'input') continue;
          await send(assignment, entry, requestSignal);
          if (remoteOf(assignment).hasMore || ended(remoteOf(assignment).phase)) break;
        }
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
      ...(task.mandate.project ? { projectId: task.mandate.project.id } : {}), text: assignment.text || task.target,
      requirements: snapshot }, 'initial');
    try { await send(assignment, submit, requestSignal); }
    catch (error) { unavailable(assignment, error); return { remotePending: true }; }
    database.parkRemoteAssignment(assignment.id, { ...ownership(assignment), nextAt: now() });
    return { remotePending: true };
  }
  async function cycle() {
    const candidates = database.remoteExecutionCandidates({ now: now(), limit: batchSize });
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
      for (;;) {
        const candidate = candidates[next++];
        if (!candidate || shutdown.signal.aborted || signal?.aborted) return;
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
  return { execute,
    tick() { if (shutdown.signal.aborted || signal?.aborted) return Promise.resolve(); return running ||= cycle().finally(() => { running = undefined; }); },
    async manageExecution({ taskId, assignmentId, fence, instructionRevision, operation }) {
      const task = database.getTask(taskId), assignment = database.getAssignment(assignmentId), remote = assignment && remoteOf(assignment);
      if (!task || task.instructionRevision !== instructionRevision || assignment?.taskId !== taskId || assignment.fence !== fence || !remote)
        throw fail('REMOTE_EXECUTION_IDENTITY_CHANGED', '原执行身份或当前要求已变化');
      if (operation !== 'resume') throw fail('UNSUPPORTED_EXECUTION_CONTROL', '仅支持核实原始执行');
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
      const current = remoteOf(assignment);
      return { status: current.available && current.phase !== 'uncertain' ? 'observed' : 'blocked', taskId, assignmentId,
        executionId: current.executionId, phase: current.phase,
        ...(current.phase === 'uncertain' ? { reason: '原会话执行边界尚未核实，未创建替代执行' } : {}) };
    },
    async stop() { shutdown.abort(); await Promise.allSettled([running, ...management]); },
  };
}
