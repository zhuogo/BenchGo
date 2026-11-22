import { createHash, randomUUID } from 'node:crypto';

const requestKey = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code, status: 409 });

export function createWorkerArchive({ ctx, commander, orchestration, database, signal, wake }) {
  const registry = ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry;
  const localRequests = new Map();
  const read = (sessionId, device) => orchestration.currentArchiveWorker({ sessionId, device });
  const description = current => current && ({ taskId: current.task.id, title: current.task.title,
    active: !current.task.executionExited, sessionId: current.run.sessionId, runId: current.run.id,
    assignmentId: current.assignment.id, fence: current.assignment.fence, instructionRevision: current.task.instructionRevision });
  const wakeOrchestration = () => { void Promise.resolve().then(wake).catch(error => ctx.logger?.warn?.(`工单归档调度失败：${error.code || error.name}`)); };
  const local = sessionId => {
    const request = localRequests.get(sessionId) || { requestId: randomUUID() };
    if (orchestration.archiveWorkerTask({ sessionId, ...request })) wakeOrchestration();
  };
  const onNative = ({ sessionId, archived }) => { if (archived && !signal.aborted) local(sessionId); };
  const stop = ctx.on?.('domain/changed', change => {
    if (signal.aborted || change.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return;
    const previous = new Set(registry?.archivedSessionIds || []);
    for (const sessionId of change.value?.archivedSessionIds || []) if (!previous.has(sessionId)) local(sessionId);
  }, { global: true });
  commander.on?.('session/archive', onNative);

  const peer = (remote, input) => {
    const link = ctx.get?.('benchgoLink');
    if (!link?.callDevice) throw fail('LINK_UNAVAILABLE', 'Link 执行连接不可用');
    return link.callDevice({ deviceId: remote.deviceId, expectedHostId: remote.hostId, expectedAuthorizationId: remote.authorizationId,
      input: { action: 'execution', version: remote.protocolVersion, ...input }, signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) });
  };
  let nextCheck = 0, scanning, deviceOffset = 0;
  const range = 4;
  const cursorKey = device => `worker-archive-cursor:${requestKey(device.deviceId, device.hostId, device.authorizationId)}`;
  async function scan() {
    const devices = orchestration.remoteArchiveDevices();
    if (deviceOffset >= devices.length) deviceOffset = 0;
    const batch = devices.slice(deviceOffset, deviceOffset + range);
    deviceOffset += batch.length;
    await Promise.allSettled(batch.map(async device => {
      const key = cursorKey(device);
      let cursor = database.meta(key) || 0;
      const page = await peer(device, { operation: 'archives', after: cursor });
      if (page.version !== device.protocolVersion || !Array.isArray(page.archives)) throw fail('INVALID_ARCHIVE_RECEIPT', '设备归档记录无效');
      for (const fact of page.archives) {
        if (!Number.isSafeInteger(fact.cursor) || fact.cursor <= cursor || !Number.isSafeInteger(fact.instructionRevision)
          || typeof fact.sessionId !== 'string' || typeof fact.executionId !== 'string')
          throw fail('INVALID_ARCHIVE_RECEIPT', '设备归档游标或会话无效');
        orchestration.archiveWorkerTask({ ...fact, device, requestId: requestKey(key, fact.cursor) });
        cursor = fact.cursor;
      }
      if (page.archives.length) { database.setMeta(key, cursor); wakeOrchestration(); }
    }));
  }
  const currentWorker = taskId => {
    const task = orchestration.getTask(taskId), assignment = task && orchestration.assignments(task.id).at(-1);
    const run = assignment && orchestration.runs(assignment.id).findLast(run => run.fence === assignment.fence);
    const remote = assignment?.executor === 'remote' && orchestration.remoteExecution(assignment.id);
    return run && read(run.sessionId, remote || undefined);
  };
  return {
    describe(sessionId, device) { return description(read(sessionId, device)); },
    describeTask(taskId) { return description(currentWorker(taskId)); },
    async archiveTask({ taskId, worker, requestId }) {
      if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) throw fail('CLEANUP_INPUT_INVALID', '归档请求标识无效');
      const current = currentWorker(taskId);
      const observed = description(current);
      if (!observed || !worker || ['taskId', 'sessionId', 'runId', 'assignmentId', 'fence', 'instructionRevision']
        .some(key => observed[key] !== worker[key])) throw fail('CLEANUP_CONFLICT', '工单执行已变化，请重新确认');
      const { task, assignment, run, remote } = current;
      const sessionId = run.sessionId, instructionRevision = task.instructionRevision;
      if (!remote) {
        if (database.taskCleanup.receiptForRequest(requestId)) return { archived: task.archived === true };
        if (localRequests.has(sessionId)) throw fail('CLEANUP_CONFLICT', '此会话的归档正在提交');
        localRequests.set(sessionId, { instructionRevision, requestId });
        try {
          if (commander.executionSession?.(run.id)?.id === sessionId) await commander.archive(sessionId, true, { stopActivity: true });
          else await registry.archiveSession(sessionId, { stopActivity: true });
          local(sessionId);
        } finally { localRequests.delete(sessionId); }
        return { archived: orchestration.getTask(task.id)?.archived === true };
      }
      const identity = { ownerHostId: orchestration.ownerHostId(), taskId: task.id, assignmentId: assignment.id, runId: run.id, fence: assignment.fence };
      const response = await peer(remote, { operation: 'archive', requestId, executionId: remote.executionId, sessionId, identity, instructionRevision });
      const execution = response?.execution;
      if (response?.version !== remote.protocolVersion || execution?.id !== remote.executionId || execution.sessionId !== sessionId
        || response.receipt?.instructionRevision !== instructionRevision || !Number.isSafeInteger(response.receipt.sessionArchiveCursor)
        || Object.keys(identity).some(key => execution.identity?.[key] !== identity[key]))
        throw fail('INVALID_ARCHIVE_RECEIPT', '设备尚未确认归档此会话');
      orchestration.archiveWorkerTask({ sessionId, device: remote, executionId: remote.executionId, identity, instructionRevision,
        requestId: requestKey(cursorKey(remote), response.receipt.sessionArchiveCursor) });
      wakeOrchestration();
      return { archived: orchestration.getTask(task.id)?.archived === true };
    },
    tick() {
      if (scanning) return scanning;
      if (signal.aborted || Date.now() < nextCheck) return Promise.resolve();
      nextCheck = Date.now() + 1500;
      return scanning = scan().finally(() => { scanning = undefined; });
    },
    async dispose() { stop?.(); commander.off?.('session/archive', onNative); await scanning; },
  };
}
