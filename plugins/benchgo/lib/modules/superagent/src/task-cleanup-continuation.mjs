import { createHash } from 'node:crypto';
import { recordDesktopTrigger } from './desktop-trigger.mjs';
import { stopDesktopTask } from './desktop-task-control.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const scope = Object.freeze({ owner: 'desktop-owner', mode: 'global' });
export const taskCleanupNoticeKey = (operationId, items) => hash([operationId, items.map(row =>
  [row.id, row.status, row.receiptId || null, row.code || null]).sort((a, b) => a[0].localeCompare(b[0]))]);
const idsOf = ids => {
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || new Set(ids).size !== ids.length
    || ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 512))
    throw fail('CLEANUP_INPUT_INVALID', '先停止再归档需要 1 至 1000 个不重复的明确任务 ID');
  return [...ids].sort();
};

/** Executes only the durable exact-target intent admitted by a real local owner turn. */
export function createTaskCleanupContinuation({ database, orchestration, taskManagement, signal, onUpdate }) {
  const ledger = database.taskCleanupContinuations;
  let after, running;
  const projection = task => taskManagement.project('task', [task])[0];
  function process(row) {
    if (signal?.aborted || ledger.get(row.id)?.status !== 'pending') return;
    const requestId = `cleanup-followup:${row.id}`;
    // Recover a crash between the archive transaction and marking this intent done.
    const receipt = taskManagement.cleanupReceiptByRequest(requestId);
    if (receipt) {
      if (receipt.operation !== 'archive' || receipt.confirmedBy.source.sessionId !== row.source.sessionId
        || receipt.confirmedBy.source.messageId !== row.source.messageId || receipt.items.length !== 1 || receipt.items[0].id !== row.taskId)
        throw fail('CLEANUP_CONTINUATION_CONFLICT', '归档回执与原待办不一致');
      return ledger.finish(row.id, { status: 'completed', receiptId: receipt.receiptId });
    }
    const trigger = orchestration.getTrigger(row.triggerId), task = orchestration.getTask(row.taskId);
    if (!trigger || trigger.actor.kind !== 'human' || trigger.actor.id !== 'desktop-owner'
      || trigger.source.channel !== 'desktop' || trigger.source.sessionId !== row.source.sessionId
      || trigger.source.messageId !== row.source.messageId || (trigger.source.threadId || 'main') !== row.source.threadId)
      throw fail('CLEANUP_CONTINUATION_SOURCE', '待归档原始真人来源已不可核对');
    if (!task) throw fail('TASK_NOT_FOUND', '任务已不存在');
    const current = projection(task);
    if (task.instructionRevision !== row.instructionRevision || task.resultVersion !== row.resultVersion
      || current.taskMeta.version !== row.metaVersion)
      throw fail('CLEANUP_CONTINUATION_STALE', '任务要求、结果或展示已变化，原待归档不再适用');
    if (!row.executionStamp || orchestration.taskCleanupExecutionStamp(task.id, { excludeTriggerId: row.triggerId }) !== row.executionStamp)
      throw fail('CLEANUP_CONTINUATION_STALE', '执行身份或后续输入已变化，原待归档不再适用');
    if (current.archived) throw fail('TASK_ALREADY_ARCHIVED', '任务已由其他整理操作归档');
    if (!task.executionExited) {
      if (!task.executionControl?.stopRequested && !task.executionControl?.stopped)
        stopDesktopTask(orchestration, task.id, row.triggerId, `cleanup-stop:${row.id}`);
      if (!orchestration.getTask(task.id).executionExited) return;
    }
    const preview = taskManagement.previewCleanup({ scope, ids: [task.id] });
    if (preview.items.length !== 1) return;
    const confirmedBy = taskManagement.createCleanupConfirmation({ previewId: preview.previewId, manifestHash: preview.manifestHash,
      ids: [task.id], actorId: 'desktop-owner', source: { sessionId: row.source.sessionId, messageId: row.source.messageId } });
    const saved = taskManagement.commitCleanup({ previewId: preview.previewId, ids: [task.id], confirmedBy, requestId });
    return ledger.finish(row.id, { status: 'completed', receiptId: saved.receiptId });
  }
  function advance(row) {
    try { return process(row); }
    catch (error) {
      // Storage/transient failures retry from the same durable identity, never from a new intent.
      if (!['CLEANUP_CONTINUATION_CONFLICT', 'CLEANUP_CONTINUATION_SOURCE', 'TASK_NOT_FOUND', 'CLEANUP_CONTINUATION_STALE',
        'TASK_ALREADY_ARCHIVED', 'CLEANUP_CONFLICT'].includes(error.code)) throw error;
      return ledger.finish(row.id, { status: 'conflict', code: error.code, reason: error.message });
    }
  }
  function start({ ids }, { agent, threadId = 'main', instruction }) {
    ids = idsOf(ids);
    const message = instruction?.message;
    if (!agent?.id || !message?.id || message.source?.kind !== 'user'
      || !(message.content || []).some(block => block.type === 'text' && block.text?.trim()))
      throw fail('MANAGEMENT_OWNER_REQUIRED', '缺少当前真人停止并归档指令');
    const source = { sessionId: agent.id, threadId, messageId: message.id,
      excerpt: (message.content || []).filter(block => block.type === 'text').map(block => block.text || '').join('\n').slice(0, 6000) };
    const requestId = hash(['stop-and-archive', source, ids]);
    const previous = ledger.byRequest(requestId);
    if (previous) return { operation: 'stop-and-archive', operationId: previous.operationId,
      ...ledger.list({ operationId: previous.operationId }), replay: true };
    const { trigger } = recordDesktopTrigger(orchestration, { sessionId: agent.id, threadId, message });
    const excluded = [], items = [];
    for (const id of ids) {
      const task = orchestration.getTask(id);
      if (!task) { excluded.push({ id, code: 'TASK_NOT_FOUND', reason: '任务不存在' }); continue; }
      const row = projection(task);
      if (row.archived) { excluded.push({ id, code: 'TASK_ALREADY_ARCHIVED', reason: '任务已归档' }); continue; }
      items.push({ id, instructionRevision: task.instructionRevision, resultVersion: task.resultVersion, metaVersion: row.taskMeta.version,
        executionStamp: orchestration.taskCleanupExecutionStamp(id, { excludeTriggerId: trigger.id }) });
    }
    if (!items.length) return { operation: 'stop-and-archive', operationId: null, items: [], nextOffset: null, excluded };
    const prepared = ledger.prepare({ requestId, source, triggerId: trigger.id, items });
    return { operation: 'stop-and-archive', operationId: prepared.operationId, ...ledger.list({ operationId: prepared.operationId }), excluded };
  }
  function tick() {
    if (signal?.aborted) return Promise.resolve();
    if (running) return running;
    running = Promise.resolve().then(async () => {
      let rows = ledger.pending({ limit: 100, ...(after ? { after } : {}) });
      if (!rows.length && after) rows = ledger.pending({ limit: 100 });
      after = rows.length ? rows.at(-1).id : undefined;
      for (const row of rows) { if (signal?.aborted) return; advance(row); }
      if (!onUpdate) return;
      for (const { batchId, operationId, items } of ledger.pendingNoticeBatches({ limit: 50 })) {
        if (signal?.aborted) return;
        await onUpdate({ operationId, items });
        ledger.markNoticeBatchNotified(batchId);
      }
    }).finally(() => { running = undefined; });
    return running;
  }
  return { start, tick, pending: args => ledger.list(args), cancel: args => ledger.cancel(args) };
}
