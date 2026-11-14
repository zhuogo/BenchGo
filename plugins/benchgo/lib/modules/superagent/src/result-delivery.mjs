import { taskExecutionBlocked, taskStopped } from './task-lifecycle.mjs';
import { isRouterTaskAck } from './task-ack.mjs';

const systemStates = new Set(['delivery_wait', 'continuation_wait', 'action_verified']);
export function systemStateDelivery({ state = 'continuation_wait', code = 'EXECUTION_UNAVAILABLE', stage = 'execution' } = {}) {
  if (!systemStates.has(state)) throw new Error('Invalid system state');
  const text = state === 'action_verified' ? '操作回执已核实。'
    : state === 'delivery_wait' ? '结果已保存，等待原来源交付。' : '执行已中断，尚未完成；记录已保留，等待用户续接。';
  return { action: 'deliver', origin: 'system', systemState: { state, code, stage }, text: `系统状态：${text}` };
}

/** Protocol checks only; Router expression does not accept or re-run Worker work. */
export function validateDelivery(value) {
  if (!value || !['deliver', 'ask'].includes(value.action) || typeof value.text !== 'string' || !value.text.trim()) throw new Error('Delivery requires text');
  if (value.options !== undefined && (!Array.isArray(value.options) || value.options.length > 6 || value.options.some(x => typeof x !== 'string' || !x.trim() || x.length > 500))) throw new Error('Invalid delivery options');
  let provenance;
  if (value.origin === 'system') {
    if (value.action !== 'deliver' || !systemStates.has(value.systemState?.state)
      || typeof value.systemState.code !== 'string' || !/^[A-Z0-9_:-]{1,100}$/.test(value.systemState.code)
      || typeof value.systemState.stage !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(value.systemState.stage)) throw new Error('Invalid system publication');
    provenance = { origin: 'system', systemState: { state: value.systemState.state, code: value.systemState.code, stage: value.systemState.stage } };
  } else {
    if (value.systemState !== undefined) throw new Error('System state requires a system publication');
    if (value.origin !== undefined && !['worker', 'router'].includes(value.origin)) throw new Error('Invalid publication origin');
    if (value.origin === 'router' && (value.action !== 'deliver' || value.options !== undefined)) throw new Error('Router reply requires natural text');
    provenance = value.origin ? { origin: value.origin } : {};
  }
  return { action: value.action, text: value.text, ...(value.options?.length ? { options: value.options } : {}), ...provenance };
}
/** Synchronous Router actions already speak in their original tool turn. */
export function resultOutbox({ task, result, delivery }) {
  if (delivery?.origin !== 'system' || delivery.systemState?.state !== 'action_verified') throw new Error('Only Router action audit uses a result outbox');
  return { type: 'task.result', source: task.mandate.source, taskId: task.id, title: task.title,
    instructionRevision: task.instructionRevision, resultVersion: task.resultVersion + 1, evidenceRefs: result.evidenceRefs,
    replyState: 'suppressed', suppressionReason: 'router-action-already-replied' };
}

export function deliverySuppression(database, row) {
  const payload = row.payload;
  if (payload.type === 'task.accepted') {
    if (!isRouterTaskAck(payload)) return 'invalid-ack';
    const task = database.getTask(row.taskId);
    if (!task || taskExecutionBlocked(task) || task.resultVersion > 0) return 'ack-superseded';
    if (payload.taskId !== task.id || JSON.stringify(payload.source) !== JSON.stringify(task.mandate.source)) return 'source-mismatch';
    return null;
  }
  if (!['task.result', 'task.attention'].includes(payload.type)) return null;
  const task = database.getTask(row.taskId);
  if (!task || taskStopped(task)) return 'task-inactive';
  if (payload.taskId !== undefined && payload.taskId !== task.id) return 'task-mismatch';
  if (payload.type === 'task.attention' && task.status === 'completed') return 'task-inactive';
  if (payload.instructionRevision !== undefined && payload.instructionRevision !== task.instructionRevision) return 'superseded-instruction';
  if (payload.resultVersion !== undefined && payload.resultVersion !== task.resultVersion) return 'superseded-result';
  if (JSON.stringify(payload.source) !== JSON.stringify(task.mandate.source)) return 'source-mismatch';
  if (payload.replyState === 'suppressed' && payload.suppressionReason === 'router-action-already-replied') return payload.suppressionReason;
  const state = payload.stateSignal || (payload.publication?.origin === 'system' ? payload.publication.systemState : null);
  if (state?.state === 'continuation_wait') {
    const current = database.assignments(task.id).some(row => ['uncertain', 'failed'].includes(row.state)
      && row.lastFailure?.code === state.code && row.lastFailure?.stage === state.stage
      && (!payload.assignmentId || row.id === payload.assignmentId && row.fence === payload.fence));
    if (!current) return 'state-superseded';
  }
  if (payload.type === 'task.attention') {
    const attention = database.attentions(task.id).find(entry => entry.id === payload.attentionId);
    if (attention?.answerTriggerId) return 'attention-resolved';
  }
  return null;
}
