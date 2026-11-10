import { createHash } from 'node:crypto';
import { currentHumanInstruction } from './desktop-delegation-service.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const string = { type: 'string', minLength: 1 };
const ids = { type: 'array', minItems: 1, maxItems: 1000, uniqueItems: true, items: string };
const globalScope = Object.freeze({ owner: 'desktop-owner', mode: 'global' });
function inputFor(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['op', ...fields].includes(key))) throw fail('MANAGEMENT_INPUT', '管理工具参数无效；身份和确认只能由宿主提供');
  return Object.fromEntries(fields.filter(key => Object.hasOwn(input, key)).map(key => [key, structuredClone(input[key])]));
}

/** Only the mounted local Router can construct owner actors or approval capabilities. */
export function registerConversationManagement({ ctx, scope, agent, register, settings, taskManagement, threadId = 'main', store }) {
  const prepared = new Map();
  const liveInstruction = () => {
    const instruction = currentHumanInstruction(ctx, agent);
    const latest = agent.session.snapshotEvents().slice((instruction?.turn ?? -1) + 1).findLast(event => event.type === 'user/message')?.data;
    return instruction && latest && fingerprint(latest) === fingerprint(instruction.message) ? instruction : null;
  };
  async function authority(exec, expected) {
    exec?.signal?.throwIfAborted();
    if (!agent || exec?.agent !== agent) throw fail('MANAGEMENT_OWNER_REQUIRED', '仅当前本机主人 Router 可管理设置和工单');
    const instruction = liveInstruction();
    if (!instruction?.message?.id
      || !(instruction.message.content || []).some(block => block.type === 'text' && block.text?.trim())) throw fail('MANAGEMENT_OWNER_REQUIRED', '管理操作需要当前原始主人文字指令，机器通知不能授权');
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
  const actor = (exec, stamp) => ({ kind: 'owner', id: 'desktop-owner', ...(store.profileId ? { profileId: store.profileId } : {}),
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
    return result;
  });

  const cleanupFields = { preview: ['ids', 'includeUnsettled'], commit: ['previewId', 'ids', 'requestId'],
    history: ['ticketId', 'limit'], restore: ['receiptId', 'previewId', 'ids', 'requestId'] };
  register('assistant_task_cleanup', 'Organize ticket history by reversible archive tombstones only; never physically delete Tickets, evidence or files. Available in the local owner main chat or manual side chat, across all ticket sources. preview returns a concrete global or selected-ID manifest and excludes ongoing work. Present its actual items and exclusions. commit requires its previewId and an exact unchanged subset of IDs; the host displays that subset for fresh allowed-once human approval before archiving. That host manifest confirmation is the only approval step: do not first ask for verbal consent and then add a second approval card. A general cleanup request is not approval of a manifest. Stop active work through its existing separate control path, then preview again. history reads durable receipts. restore with receiptId and no requestId saves a concrete restore preview; restore with previewId, exact subset IDs and requestId requests fresh one-time human confirmation before restoring against saved versions. Never pass confirmed booleans or impersonate an owner.', {
    op: { type: 'string', enum: Object.keys(cleanupFields) }, ids, includeUnsettled: { type: 'boolean' },
    previewId: string, receiptId: string, requestId: string, ticketId: string, limit: { type: 'integer', minimum: 1, maximum: 1000 },
  }, ['op'], async (input, exec) => {
    if (!Object.hasOwn(cleanupFields, input?.op)) throw fail('MANAGEMENT_INPUT', '无效工单清理操作');
    const args = inputFor(input, cleanupFields[input.op]);
    const { stamp, instruction } = await authority(exec);
    if (!taskManagement) throw fail('CLEANUP_UNAVAILABLE', '工单清理服务当前不可用');
    if (input.op === 'preview') return taskManagement.previewCleanup({ ...args, scope: globalScope });
    if (input.op === 'history') return taskManagement.cleanupHistory(args);
    const source = { sessionId: agent.id, messageId: instruction.message.id, callId: exec.callId };
    if (input.op === 'commit' || input.op === 'restore' && args.requestId) {
      if (!Array.isArray(args.ids) || !args.ids.length || !args.requestId) throw fail('MANAGEMENT_INPUT', '请提供清单的明确最终子集与稳定请求标识');
      const preview = await taskManagement.getCleanupPreview(args.previewId);
      if (input.op === 'restore' ? preview.type !== 'restore' : preview.type === 'restore') throw fail('CLEANUP_SCOPE_DENIED', '清单类型不属于本次操作');
      const selected = [...args.ids].sort();
      if (new Set(selected).size !== selected.length || selected.some(id => !preview.items.some(row => row.id === id))) throw fail('CLEANUP_SCOPE_DENIED', '最终清单必须是已预览工单的不重复子集');
      await approve(exec, stamp, 'assistant_task_cleanup', { operation: input.op === 'restore' ? 'restore' : 'archive', previewId: preview.previewId,
        manifestHash: preview.manifestHash, items: selected.map(id => preview.items.find(row => row.id === id)), excluded: preview.excluded });
      const confirmedBy = taskManagement.createCleanupConfirmation({ previewId: preview.previewId, manifestHash: preview.manifestHash,
        ids: selected, actorId: 'desktop-owner', source });
      const commit = input.op === 'restore' ? taskManagement.restoreCleanup : taskManagement.commitCleanup;
      return commit({ previewId: args.previewId, requestId: args.requestId, ids: selected, confirmedBy });
    }
    return taskManagement.previewRestore({ scope: globalScope, receiptId: args.receiptId, ids: args.ids });
  });
}
