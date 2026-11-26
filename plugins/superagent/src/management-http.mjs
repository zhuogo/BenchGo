import { randomUUID } from 'node:crypto';

const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
export function managementOwner(peer) {
  if (peer?.principal?.kind !== 'owner') throw fail('OWNER_REQUIRED', '此管理操作需要已认证的主人身份', 403);
  return { kind: 'owner', id: 'desktop-owner' };
}

/** Preserve the existing patch semantics, including sibling fields. Arrays are atomic. */
export function settingsPatchOps(patch, current = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw fail('SETTINGS_INPUT', '请提供配置差异');
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const merge = (before, change) => {
    if (!object(change)) return structuredClone(change);
    const result = object(before) ? structuredClone(before) : {};
    for (const [key, value] of Object.entries(change)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw fail('SETTINGS_INPUT', '配置字段无效');
      result[key] = merge(result[key], value);
    }
    return result;
  };
  return Object.keys(patch).map(key => {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw fail('SETTINGS_INPUT', '配置字段无效');
    return { op: 'set', path: [key], value: merge(current[key], patch[key]) };
  });
}

export function createManagementHttp({ settings, taskManagement, profileId, readConfig, readConnection, readLearning }) {
  const available = () => {
    if (!settings) throw fail('SETTINGS_UNAVAILABLE', '通用配置服务尚未就绪', 503);
    return settings;
  };
  const pageActor = peer => ({ ...managementOwner(peer), profileId });
  async function patch({ adapterId, namespace, patch, revision, peer, requestId, readback }) {
    const actor = pageActor(peer), manager = available();
    const current = await manager.read({ adapterId, namespace });
    const ops = settingsPatchOps(patch, current.value);
    if (!ops.length) return readback();
    if (requestId) {
      const previous = await manager.lookupRequest({ requestId, adapterId, namespace, ops }, actor);
      if (previous) {
        await manager.commit({ operationId: previous.operationId }, { ...actor,
          confirm: async frozen => ({ outcome: 'allowed-once', digest: frozen.digest }) });
        return readback();
      }
    }
    if (revision !== undefined && revision !== current.backendRevision) throw fail('SETTINGS_CONFLICT', '配置已变化，请重新读取');
    const plan = await manager.prepare({ adapterId, namespace, ops, expectedRevision: current.revision,
      requestId }, actor);
    // This route is the authenticated page's explicit Save action, with the
    // exact submitted difference frozen above. It is not exposed as model input.
    await manager.commit({ operationId: plan.operationId }, { ...actor,
      confirm: async frozen => ({ outcome: 'allowed-once', digest: frozen.digest }) });
    return readback();
  }
  const scope = { owner: 'desktop-owner', mode: 'global' };
  async function archiveWorkerTask({ taskId, worker, requestId }, peer, workerArchive) {
    const actor = managementOwner(peer);
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200)
      throw fail('CLEANUP_INPUT_INVALID', '归档请求标识无效');
    const keys = ['sessionId', 'assignmentId', 'runId', 'fence', 'instructionRevision'];
    const expected = worker && Object.fromEntries(keys.map(key => [key, worker[key]]));
    if (!expected || worker.taskId !== taskId)
      throw fail('CLEANUP_CONFLICT', '工单执行已变化，请重新确认', 409);
    const previous = taskManagement.cleanupReceiptByRequest(requestId);
    const current = workerArchive.describeTask(taskId);
    const matches = current?.taskId === taskId && keys.every(key => current[key] === expected[key]);
    if (!previous && !matches) throw fail('CLEANUP_CONFLICT', '工单执行已变化，请重新确认', 409);
    const preview = previous ? taskManagement.getCleanupPreview(previous.previewId) : taskManagement.previewCleanup({ scope, ids: [taskId] });
    const frozen = preview.items.find(row => row.id === taskId);
    if (!frozen || keys.some(key => frozen[key] !== expected[key])) {
      const exclusion = preview.excluded?.find(row => row.id === taskId);
      throw fail(exclusion?.code || 'CLEANUP_CONFLICT', exclusion?.reason || '工单执行已变化，请重新确认', 409);
    }
    const source = { sessionId: 'desktop-owner-page', callId: requestId, worker: expected };
    const ids = [taskId];
    const confirmedBy = taskManagement.createCleanupConfirmation({ previewId: preview.previewId,
      manifestHash: preview.manifestHash, ids, actorId: actor.id, source });
    const receipt = await taskManagement.commitCleanup({ previewId: preview.previewId, ids, confirmedBy, requestId });
    const item = receipt.items.find(row => row.id === taskId);
    if (item?.outcome === 'failed') throw fail(item.code, item.reason, 409);
    return { archived: item?.archived === true && taskManagement.isArchivedTask(taskId)
      && taskManagement.latestArchiveReceipt(taskId)?.receiptId === receipt.receiptId };
  }
  async function cleanup(input, peer) {
    managementOwner(peer);
    if (input.action === 'taskCleanupPreview') return taskManagement.previewCleanup({ scope, ids: input.taskIds });
    if (input.action === 'taskCleanupRestorePreview') {
      const ids = input.taskIds;
      if (!Array.isArray(ids) || !ids.length) throw fail('CLEANUP_INPUT_INVALID', '请选择需要恢复展示的任务');
      // Each Task carries its own current archive pointer. Scanning history by
      // one Task's id could pick an older receipt that no longer governs it.
      const receipts = new Set(ids.map(id => {
        const latest = taskManagement.latestArchiveReceipt(id);
        if (!latest) throw fail('CLEANUP_RECEIPT_NOT_FOUND', '归档记录不存在');
        return latest.receiptId;
      }));
      if (receipts.size !== 1) throw fail('CLEANUP_CONFLICT', '所选任务的归档记录不同，请分开恢复');
      const [receiptId] = receipts;
      return { excluded: [], ...taskManagement.previewRestore({ scope, receiptId, ids }) };
    }
    if (input.action === 'taskCleanupHistory') return { history: taskManagement.cleanupHistory(input) };
    const preview = taskManagement.getCleanupPreview(input.previewId);
    if (preview.manifestHash !== input.manifestHash) throw fail('CLEANUP_CONFLICT', '清单已变化，请重新预览');
    if ((input.action === 'taskCleanupRestore') !== (preview.type === 'restore')) throw fail('CLEANUP_CONFLICT', '清单类型不属于本次操作');
    const ids = input.selectedTaskIds;
    const source = { sessionId: 'desktop-owner-page', callId: input.requestId || randomUUID() };
    const confirmedBy = taskManagement.createCleanupConfirmation({ previewId: preview.previewId,
      manifestHash: preview.manifestHash, ids, actorId: 'desktop-owner', source });
    const args = { previewId: preview.previewId, ids, confirmedBy, requestId: input.requestId };
    return input.action === 'taskCleanupRestore' ? await taskManagement.restoreCleanup(args) : await taskManagement.commitCleanup(args);
  }
  return {
    patchAssistant: (input, peer) => patch({ adapterId: 'superagent', namespace: 'superagent', patch: input.patch,
      revision: input.revision, requestId: input.requestId, peer, readback: readConfig }),
    patchConnection: (input, peer) => patch({ adapterId: 'superagent-connections', namespace: `superagent-connections:${input.channel || 'feishu'}`,
      patch: input.patch, revision: input.revision, requestId: input.requestId, peer, readback: () => readConnection(input.channel || 'feishu') }),
    patchLearning: (input, peer) => patch({ adapterId: 'superagent', namespace: 'superagent-learning',
      patch: input.patch, revision: input.expectedHash, requestId: input.requestId, peer, readback: readLearning }),
    cleanup,
    archiveWorkerTask,
    async dispatch(input, peer) {
      const manager = available(), actor = pageActor(peer);
      switch (input.action) {
        case 'settingsCatalog': return manager.catalog(input);
        case 'settingsRead': return manager.read(input);
        case 'settingsHistory': return { history: manager.history(input) };
        case 'settingsPrepare': return manager.prepare(input, actor);
        case 'settingsRollback': return manager.rollback(input, actor);
        case 'settingsCommit': return manager.commit({ operationId: input.operationId }, { ...actor,
          confirm: async plan => {
            if (input.digest !== plan.digest) throw fail('SETTINGS_CONFIRMATION_REQUIRED', '请先核对并确认本次精确配置差异');
            return { outcome: 'allowed-once', digest: plan.digest };
          } });
        default: throw fail('SETTINGS_INPUT', '未知管理操作');
      }
    },
  };
}
