import { HarnessError } from '@deepseek-ai/dsh-llm';
import { createHash } from 'node:crypto';
import { currentHumanInstruction } from './desktop-delegation-service.mjs';

const fail = (code, message) => new HarnessError(`${code}: ${message}`, code);
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const string = { type: 'string', minLength: 1 };
const ids = { type: 'array', minItems: 1, maxItems: 1000, uniqueItems: true, items: string };
const globalScope = Object.freeze({ owner: 'desktop-owner', mode: 'global' });
function inputFor(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('MANAGEMENT_INPUT', 'Management parameters must be an object');
  const unsupported = Object.keys(input).filter(key => !['op', ...fields].includes(key));
  if (unsupported.length) throw fail('MANAGEMENT_INPUT', `Operation ${input.op} does not support parameters: ${unsupported.join(', ')}. Allowed: ${fields.join(', ') || 'none'}. Identity and confirmation fields are supplied only by the host.`);
  return Object.fromEntries(fields.filter(key => Object.hasOwn(input, key)).map(key => [key, structuredClone(input[key])]));
}

/** Only the mounted local Router can construct owner actors or approval capabilities. */
export function registerConversationManagement({ ctx, scope, agent, register, settings, taskManagement, threadId = 'main', store }) {
  const prepared = new Map();
  // Internal notifications in the same turn do not erase its real human input.
  const liveInstruction = () => currentHumanInstruction(ctx, agent);
  async function authority(exec, expected) {
    exec?.signal?.throwIfAborted();
    if (!agent || exec?.agent !== agent) throw fail('MANAGEMENT_OWNER_REQUIRED', '仅当前本机主人 Router 可管理设置和工单');
    const instruction = liveInstruction();
    if (!instruction?.message?.id
      || !(instruction.message.content || []).some(block => block.type === 'text' && block.text?.trim())) throw fail('MANAGEMENT_OWNER_REQUIRED', '未找到本轮用户输入；本次未提交。请回到原对话发送明确要求，勿换参数重复调用');
    const state = await store.getState();
    const thread = threadId === 'main' ? { sessionId: state.mainSessionId } : state.threads.find(row => row.id === threadId);
    if (!thread || thread.archived || thread.sourceKey || thread.source && thread.source.channel !== 'desktop'
      || thread.sessionId !== agent.id) throw fail('MANAGEMENT_OWNER_REQUIRED', '外部渠道和非当前本机会话不能管理主人设置');
    const stamp = fingerprint(instruction);
    if (expected && expected !== stamp) throw fail('MANAGEMENT_STALE_INSTRUCTION', '主人指令已变化，请重新读取并准备本次操作');
    // Recheck after the asynchronous state projection read.
    if (fingerprint(liveInstruction()) !== stamp) throw fail('MANAGEMENT_STALE_INSTRUCTION', '主人指令已变化，请重试');
    return { stamp, instruction };
  }
  async function approve(exec, stamp, toolName, plan) {
    await authority(exec, stamp);
    const approval = scope?.get?.('approval') ?? ctx.get?.('approval');
    if (typeof approval?.request !== 'function') throw fail('MANAGEMENT_APPROVAL_UNAVAILABLE', '本次精确差异需要可用的真人审批入口');
    const outcome = await approval.request({ agent, toolName, callId: exec.callId, signal: exec.signal,
      reason: `仅确认本次具体管理操作，不授予后续权限：\n${JSON.stringify(plan)}` });
    await authority(exec, stamp);
    if (outcome !== 'allowed-once') throw fail('MANAGEMENT_APPROVAL_DENIED', '本次操作未获真人单次确认');
  }
  const actor = (exec, stamp) => ({ kind: 'owner', id: 'desktop-owner', profileId: store.profileId,
    sessionId: agent.id, signal: exec.signal,
    confirm: async plan => { await approve(exec, stamp, 'assistant_settings', plan); return { outcome: 'allowed-once', digest: plan.digest }; } });
  const settingsFields = {
    catalog: ['adapterId'], read: ['adapterId', 'namespace'],
    prepare: ['adapterId', 'namespace', 'ops', 'expectedRevision', 'requestId'], commit: ['operationId'],
    history: ['adapterId', 'namespace', 'limit', 'before'], rollback: ['historyId', 'expectedRevision', 'requestId'],
  };
  register('assistant_settings', 'Manage every registered BenchGo setting directly in the local owner conversation. Discover exact adapterId/namespace/path/schema with catalog, then read. Preserve opaque IDs and unedited fields. For an explicit ordinary change, prepare path operations against the read revision then commit the returned operationId without asking again. The host requests exact one-time human approval only for safety-boundary or uncertain-risk changes. rollback prepares a reverse plan; commit it separately. Never invent confirmation flags, actor identities or unsupported settings. History and receipts report actual verified results.', {
    op: { type: 'string', enum: Object.keys(settingsFields) }, adapterId: string, namespace: string,
    ops: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'object', additionalProperties: false, required: ['op', 'path'],
      properties: { op: { type: 'string', enum: ['set', 'unset'] }, path: { type: 'array', maxItems: 32, items: string }, value: {} } } },
    expectedRevision: { type: 'integer', minimum: 0 }, requestId: string, operationId: string, historyId: string,
    limit: { type: 'integer', minimum: 1, maximum: 200 }, before: { type: 'integer', minimum: 0 },
  }, ['op'], async (input, exec) => {
    if (!Object.hasOwn(settingsFields, input?.op)) throw fail('MANAGEMENT_INPUT', '无效设置管理操作');
    const args = inputFor(input, settingsFields[input.op]);
    const { stamp } = await authority(exec);
    if (!settings || typeof settings[input.op] !== 'function') throw fail('SETTINGS_UNAVAILABLE', '统一设置管理服务当前不可用');
    if (input.op === 'commit' && prepared.get(args.operationId) !== stamp) throw fail('MANAGEMENT_STALE_INSTRUCTION', '请先在本次主人指令下准备配置差异');
    const result = await settings[input.op](args, actor(exec, stamp));
    if (['prepare', 'rollback'].includes(input.op) && result?.operationId) {
      prepared.set(result.operationId, stamp);
      if (prepared.size > 256) prepared.delete(prepared.keys().next().value);
    }
    return input.op === 'history' ? { history: result } : result;
  });

  const cleanupFields = { preview: ['ids', 'includeUnsettled'], commit: ['previewId', 'ids', 'requestId'],
    history: ['ticketId', 'receiptId', 'limit'], restore: ['receiptId', 'previewId', 'ids', 'requestId'] };
  register('assistant_task_cleanup', 'Organize ticket history. Available in the local main chat or manual side chat, across all ticket sources. preview verifies current status and eligibility and returns a concrete global or selected-ID manifest, excluding ongoing work. When exact IDs are already known, call preview directly; do not first fetch every Ticket or its full results. Present its actual items and exclusions. commit requires its previewId and an exact unchanged subset of IDs; the host displays that subset for fresh allowed-once human approval before archiving. That host manifest confirmation is the only approval step: do not first ask for verbal consent and then add a second approval card. A general cleanup request is not approval of a manifest. Resolve the exact requested target IDs before preview; clarify an ambiguous count or scope. Waiting is not proof of active execution: use actual exclusions. Stop only work requiring it, then preview again; stopping is not cleanup. commit returns the persisted receipt with per-ticket before/after archive facts; report those actual facts directly. If the user explicitly requests independent readback, call history once with the returned receiptId; do not also fetch each full Ticket unless the receipt leaves a specific fact unresolved. Do not repeat a deterministic failure with changed parameters while its cause is unchanged. history reads durable receipts; pass receiptId to read one exact receipt, optionally intersecting ticketId. restore with receiptId and no previewId saves a concrete restore preview; restore with previewId, exact subset IDs requests fresh one-time human confirmation before restoring against saved versions. Never pass confirmed booleans or impersonate an owner.', {
    op: { type: 'string', enum: Object.keys(cleanupFields) }, ids, includeUnsettled: { type: 'boolean' },
    previewId: string, receiptId: string, ticketId: string, limit: { type: 'integer', minimum: 1, maximum: 1000 },
  }, ['op'], async (input, exec) => {
    if (!Object.hasOwn(cleanupFields, input?.op)) throw fail('MANAGEMENT_INPUT', '无效工单清理操作');
    const args = inputFor(input, cleanupFields[input.op]);
    const { stamp, instruction } = await authority(exec);
    if (!taskManagement) throw fail('CLEANUP_UNAVAILABLE', '工单清理服务当前不可用');
    if (input.op === 'preview') return taskManagement.previewCleanup({ ...args, scope: globalScope });
    if (input.op === 'history') return { history: taskManagement.cleanupHistory(args) };
    const source = { sessionId: agent.id, messageId: instruction.message.id };
    if (input.op === 'commit' || input.op === 'restore' && args.previewId) {
      if (!Array.isArray(args.ids) || !args.ids.length) throw fail('MANAGEMENT_INPUT', '请提供已预览清单的明确最终子集');
      const preview = await taskManagement.getCleanupPreview(args.previewId);
      if (input.op === 'restore' ? preview.type !== 'restore' : preview.type === 'restore') throw fail('CLEANUP_SCOPE_DENIED', '清单类型不属于本次操作');
      const selected = [...args.ids].sort();
      if (new Set(selected).size !== selected.length || selected.some(id => !preview.items.some(row => row.id === id))) throw fail('CLEANUP_SCOPE_DENIED', '最终清单必须是已预览工单的不重复子集');
      const requestId = args.requestId || fingerprint([input.op, source, args.previewId, selected]);
      if (preview.consumedBy) {
        const previous = taskManagement.cleanupHistory({ ticketId: selected[0] }).find(row => row.receiptId === preview.consumedBy);
        if (previous?.requestId === requestId && fingerprint(previous.confirmedBy?.ids) === fingerprint(selected)) return previous;
        throw fail('CLEANUP_PREVIEW_CONSUMED', '清单已处理；请读取归档回执，不要重复确认或扩大范围');
      }
      await approve(exec, stamp, 'assistant_task_cleanup', { operation: input.op === 'restore' ? 'restore' : 'archive', previewId: preview.previewId,
        manifestHash: preview.manifestHash, items: selected.map(id => preview.items.find(row => row.id === id)), excluded: preview.excluded });
      const confirmedBy = taskManagement.createCleanupConfirmation({ previewId: preview.previewId, manifestHash: preview.manifestHash,
        ids: selected, actorId: 'desktop-owner', source });
      const commit = input.op === 'restore' ? taskManagement.restoreCleanup : taskManagement.commitCleanup;
      return commit({ previewId: args.previewId, requestId, ids: selected, confirmedBy });
    }
    return taskManagement.previewRestore({ scope: globalScope, receiptId: args.receiptId, ids: args.ids });
  });
}
