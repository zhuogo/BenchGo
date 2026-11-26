import { createHash } from 'node:crypto';

const requestKey = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code, status: 409 });

/**
 * Projects the archive state owned by Workspace, Commander or a remote device.
 */
export function createWorkerArchive({ ctx, commander, orchestration, database, signal, wake }) {
  const registry = ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry;
  const requests = new Set();
  const read = (sessionId, device, requireCurrentRevision) => orchestration.currentArchiveWorker({ sessionId, device, requireCurrentRevision });
  const description = current => current && ({ taskId: current.task.id, title: current.task.title,
    active: !current.task.executionExited, sessionId: current.run.sessionId, runId: current.run.id,
    assignmentId: current.assignment.id, fence: current.assignment.fence, instructionRevision: current.task.instructionRevision });
  const wakeOrchestration = () => { void Promise.resolve().then(wake).catch(error => ctx.logger?.warn?.(`工单归档调度失败：${error.code || error.name}`)); };
  const executionIdentity = ({ task, assignment, run }) => ({ ownerHostId: orchestration.ownerHostId(), taskId: task.id,
    assignmentId: assignment.id, runId: run.id, fence: assignment.fence });
  const matchesIdentity = (current, identity) => Object.entries(executionIdentity(current)).every(([key, value]) => identity?.[key] === value);
  const invalidReceipt = () => fail('INVALID_ARCHIVE_RECEIPT', '设备会话归档记录无效');

  const archivedSessionIds = (official = registry?.archivedSessionIds || []) => [
    ...official,
    ...(commander?.list?.() || []).filter(session => session.executionId && session.archived).map(session => session.id),
  ];
  const syncProjection = official => {
    try { orchestration.syncTaskArchive(archivedSessionIds(official)); }
    catch (error) { ctx.logger?.warn?.(`工单归档投影同步失败：${error.code || error.name}`); }
  };
  syncProjection();

  const peer = (remote, input) => {
    const link = ctx.get?.('benchgoLink');
    if (!link?.callDevice) throw fail('LINK_UNAVAILABLE', 'Link 执行连接不可用');
    return link.callDevice({ deviceId: remote.deviceId, expectedHostId: remote.hostId, expectedAuthorizationId: remote.authorizationId,
      input: { action: 'execution', version: remote.protocolVersion, ...input }, signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) });
  };
  const persistRemoteState = (current, state) => {
    // An older requirement can never become current again. A future one may
    // still be arriving, so keep the device cursor before its fact.
    if (state.instructionRevision < current.task.instructionRevision) return;
    if (state.instructionRevision > current.task.instructionRevision) throw fail('ARCHIVE_REVISION_PENDING', '工单尚未同步到设备归档对应的要求版本');
    orchestration.recordRemoteTaskArchive(current.task.id, current.run.sessionId, { ...state, archivedSessionIds: archivedSessionIds() });
  };
  const stateOf = (response, current) => {
    const { remote, run } = current;
    const execution = response?.execution;
    if (response?.version !== remote.protocolVersion || execution?.id !== remote.executionId || execution.sessionId !== run.sessionId
      || !matchesIdentity(current, execution.identity) || (execution.sessionArchived !== undefined && typeof execution.sessionArchived !== 'boolean'))
      throw invalidReceipt();
    const state = { archived: execution.sessionArchived === true, cursor: execution.sessionArchiveCursor ?? 0,
      instructionRevision: execution.sessionArchiveInstructionRevision ?? execution.receivedInstructionRevision };
    if (!Number.isSafeInteger(state.cursor) || state.cursor < 0 || !Number.isSafeInteger(state.instructionRevision) || state.instructionRevision < 1)
      throw invalidReceipt();
    return state;
  };
  let nextCheck = 0, scanning, deviceOffset = 0;
  const range = 4;
  // Revisit cursors written before the receiver persisted each observed state.
  const cursorKey = device => `worker-archive-state-cursor:${requestKey(device.deviceId, device.hostId, device.authorizationId)}`;
  async function scan() {
    const devices = orchestration.remoteArchiveDevices();
    if (deviceOffset >= devices.length) deviceOffset = 0;
    const batch = devices.slice(deviceOffset, deviceOffset + range);
    deviceOffset += batch.length;
    await Promise.allSettled(batch.map(async device => {
      const key = cursorKey(device);
      let cursor = database.meta(key) || 0;
      const page = await peer(device, { operation: 'archives', after: cursor });
      if (page?.version !== device.protocolVersion || !Array.isArray(page.archives)) throw invalidReceipt();
      for (const fact of page.archives) {
        if (!Number.isSafeInteger(fact?.cursor) || fact.cursor <= cursor || !Number.isSafeInteger(fact.instructionRevision) || fact.instructionRevision < 1
          || typeof fact.sessionId !== 'string' || typeof fact.executionId !== 'string')
          throw invalidReceipt();
        let current = read(fact.sessionId, device, false);
        if (current) {
          if (current.remote.executionId !== fact.executionId || !matchesIdentity(current, fact.identity)) throw invalidReceipt();
          let state = fact.state;
          if (state === undefined) {
            const response = await peer(device, { operation: 'get', executionId: fact.executionId, identity: fact.identity, limit: 1 });
            state = stateOf(response, current);
            current = read(fact.sessionId, device, false);
          }
          if (typeof state?.archived !== 'boolean' || !Number.isSafeInteger(state.cursor) || state.cursor < fact.cursor
            || !Number.isSafeInteger(state.instructionRevision) || state.instructionRevision < fact.instructionRevision
            || state.cursor === fact.cursor && state.instructionRevision !== fact.instructionRevision)
            throw invalidReceipt();
          if (current && current.remote.executionId === fact.executionId && matchesIdentity(current, fact.identity)) persistRemoteState(current, state);
        }
        cursor = fact.cursor;
        database.setMeta(key, cursor);
      }
      if (page.archives.length) wakeOrchestration();
    }));
  }
  const currentWorker = taskId => {
    const task = orchestration.getTask(taskId), assignment = task && orchestration.assignments(task.id).at(-1);
    const run = assignment && orchestration.runs(assignment.id).findLast(run => run.fence === assignment.fence);
    const remote = assignment?.executor === 'remote' && orchestration.remoteExecution(assignment.id);
    return run && read(run.sessionId, remote || undefined);
  };
  /** The observed archive set changed; Tasks follow it, never the reverse. */
  const stop = ctx.on?.('domain/changed', change => {
    if (signal.aborted || change.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return;
    if (Array.isArray(change.value?.archivedSessionIds)) syncProjection(change.value.archivedSessionIds);
  }, { global: true });
  const onNativeArchive = () => { if (!signal.aborted) syncProjection(); };
  commander?.on?.('session/archive', onNativeArchive);

  async function setArchived({ taskId, worker, requestId }, archived) {
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) throw fail('CLEANUP_INPUT_INVALID', '归档请求标识无效');
    const current = currentWorker(taskId);
    const observed = description(current);
    if (!observed || !worker || ['taskId', 'sessionId', 'runId', 'assignmentId', 'fence', 'instructionRevision']
      .some(key => observed[key] !== worker[key])) throw fail('CLEANUP_CONFLICT', '工单执行已变化，请重新确认');
    const { task, run, remote } = current;
    const sessionId = run.sessionId, instructionRevision = task.instructionRevision;
    if (requests.has(sessionId)) throw fail('CLEANUP_CONFLICT', '此会话的归档或恢复正在提交');
    requests.add(sessionId);
    try {
      if (remote) {
        const identity = executionIdentity(current);
        const response = await peer(remote, { operation: archived ? 'archive' : 'unarchive', requestId, executionId: remote.executionId,
          sessionId, identity, instructionRevision });
        const state = stateOf(response, current);
        if (response.receipt?.executionId !== remote.executionId || response.receipt.instructionRevision !== instructionRevision
          || !Number.isSafeInteger(response.receipt.sessionArchiveCursor) || response.receipt.sessionArchiveCursor < 0
          || response.receipt.sessionArchiveCursor > state.cursor) throw invalidReceipt();
        const latest = read(sessionId, remote);
        if (!latest || !matchesIdentity(latest, identity) || latest.task.instructionRevision !== instructionRevision)
          throw fail('CLEANUP_CONFLICT', '工单执行已变化，请重新确认');
        persistRemoteState(latest, state);
      } else {
        const native = commander?.executionSession?.(run.id);
        if (native?.id === sessionId) await commander.archive(sessionId, archived, archived ? { stopActivity: true } : {});
        else {
          const method = archived ? 'archiveSession' : 'unarchiveSession';
          if (typeof registry?.[method] !== 'function') throw fail('ARCHIVE_UNAVAILABLE', '官方会话归档服务不可用');
          if (registry.archivedSessionIds?.includes(sessionId) !== archived) await registry[method](sessionId, archived ? { stopActivity: true } : undefined);
        }
        orchestration.syncTaskArchive(archivedSessionIds());
      }
    } finally { requests.delete(sessionId); }
    if (archived) wakeOrchestration();
    return { archived: orchestration.getTask(task.id)?.archived === true };
  }

  return {
    describe(sessionId, device) { return description(read(sessionId, device)); },
    describeTask(taskId) { return description(currentWorker(taskId)); },
    archivedSessionIds,
    syncProjection,
    archiveTask(input) { return setArchived(input, true); },
    unarchiveTask(input) { return setArchived(input, false); },
    tick() {
      if (scanning) return scanning;
      if (signal.aborted || Date.now() < nextCheck) return Promise.resolve();
      nextCheck = Date.now() + 1500;
      return scanning = scan().finally(() => { scanning = undefined; });
    },
    async dispose() { stop?.(); commander?.off?.('session/archive', onNativeArchive); await scanning; },
  };
}
