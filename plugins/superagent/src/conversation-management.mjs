import { HarnessError } from '@deepseek-ai/dsh-llm';
import { createHash } from 'node:crypto';
import { currentHumanInstruction } from './desktop-delegation-service.mjs';
import { requestSettingsApproval } from './approval.mjs';
import { registerSessionArchive } from './session-archive.mjs';

const fail = (code, message) => new HarnessError(`${code}: ${message}`, code);
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const string = { type: 'string', minLength: 1 };
const ids = { type: 'array', minItems: 1, maxItems: 1000, items: string, description: 'Exact Task IDs, without duplicates.' };
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
  const cleanupPrepared = new Map();
  const rememberCleanup = (preview, stamp) => {
    cleanupPrepared.set(preview.previewId, { stamp, manifestHash: preview.manifestHash });
    if (cleanupPrepared.size > 256) cleanupPrepared.delete(cleanupPrepared.keys().next().value);
    return preview;
  };
  // Internal notifications in the same turn do not erase its real human input.
  const liveInstruction = () => currentHumanInstruction(ctx, agent);
  async function authority(exec, expected) {
    exec?.signal?.throwIfAborted();
    if (!agent || exec?.agent !== agent) throw fail('MANAGEMENT_OWNER_REQUIRED', '仅当前本机主人可通过总助手办理管理操作');
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
  registerSessionArchive({ ctx, store, agent, register, authority, inputFor, fail });
  async function approve(exec, stamp, toolName, plan) {
    await authority(exec, stamp);
    const approval = scope?.get?.('approval') ?? ctx.get?.('approval');
    if (typeof approval?.request !== 'function') throw fail('MANAGEMENT_APPROVAL_UNAVAILABLE', '本次精确差异需要可用的真人审批入口');
    const outcome = await requestSettingsApproval(approval, { agent, toolName, callId: exec.callId, signal: exec.signal,
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
  register('assistant_settings', 'Manage registered BenchGo settings in the local owner conversation. Discover exact adapterId/namespace/path/schema with catalog, then read. Preserve opaque IDs and unedited fields. Prepare path operations against the read revision and commit the returned operationId. Protected changes open the official approval card during commit. rollback prepares a reverse plan; commit it separately. Never invent confirmation flags, actor identities or unsupported settings. History and receipts report actual verified results.', {
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

  register('assistant_task_manage', 'Rename a Task display title directly on the current explicit local owner instruction, across all task sources. Read assistant_tasks to resolve the exact Task and its current taskMeta.version, then provide id, title and version. Clarify only ambiguous references; do not ask again for an already explicit rename or delegate product management to a Worker. This only changes the short display title, never requirements, acceptance, results or execution. Use assistant_task_cleanup for reversible archive/restore, assistant_task_control for pause/resume/cancel and assistant_task_change for requirements. Task completion follows actual execution, never a manual complete flag.', {
    op: { type: 'string', enum: ['rename'] }, id: string, title: string, version: { type: 'integer', minimum: 0 },
  }, ['op', 'id', 'title', 'version'], async (input, exec) => {
    if (input?.op !== 'rename') throw fail('MANAGEMENT_INPUT', '无效任务管理操作');
    const args = inputFor(input, ['id', 'title', 'version']);
    const { stamp } = await authority(exec);
    if (!taskManagement) throw fail('CLEANUP_UNAVAILABLE', '任务管理服务当前不可用');
    await authority(exec, stamp);
    return taskManagement.update({ kind: 'task', operation: 'rename', ...args });
  });

  const cleanupFields = { preview: ['ids'], commit: ['previewId', 'ids', 'requestId'],
    history: ['taskId', 'receiptId', 'limit'], restore: ['receiptId', 'previewId', 'ids', 'requestId'] };
  register('assistant_task_cleanup', 'Organize Task history on the current explicit local owner instruction in main/manual side chat, across all sources. Remove/delete in this list context means reversible archive; preserve files, results and execution records and describe the actual effect naturally. This uses the same archive the workspace already uses: a Task whose execution is still running is archived and its own work is asked to stop in the same action, so you never need to wait for exit or queue a follow-up. No Worker, extra approval card or repeated consent is needed, including under never. Resolve exact targets from context and assistant_tasks; clarify only ambiguous scope. preview freezes exact ids and reports which entries would be stopped; omit ids only for an explicit all-eligible request. commit needs a preview prepared for this same human instruction and an exact subset. Unconsumed previews expire after 24 hours; changed tasks or instructions require a fresh preview. Archival never claims the execution already ended: state plainly that a running Task was archived and its work was asked to stop, and that stopping is confirmed only by later facts. Results remain unknown when a Task was uncertain. restore with receiptId prepares a restore preview; restore with previewId and exact ids restores its subset without execution. Find receipts through archived Tasks cleanup.id or history(taskId); history(receiptId) reads an exact durable receipt. Report only receipts and actual exclusions; never permanent deletion. Never invent identity or confirmation flags.', {
    op: { type: 'string', enum: Object.keys(cleanupFields) }, ids,
    previewId: string, receiptId: string, requestId: string, taskId: string, limit: { type: 'integer', minimum: 1, maximum: 1000 },
  }, ['op'], async (input, exec) => {
    if (!Object.hasOwn(cleanupFields, input?.op)) throw fail('MANAGEMENT_INPUT', '无效任务清理操作');
    const args = inputFor(input, cleanupFields[input.op]);
    const { stamp, instruction } = await authority(exec);
    if (Array.isArray(args.ids) && new Set(args.ids).size !== args.ids.length)
      throw fail('CLEANUP_SCOPE_DENIED', '任务 ID 不能重复');
    if (!taskManagement) throw fail('CLEANUP_UNAVAILABLE', '任务清理服务当前不可用');
    if (input.op === 'preview') {
      const preview = await taskManagement.previewCleanup({ ...args, scope: globalScope });
      await authority(exec, stamp);
      return rememberCleanup(preview, stamp);
    }
    if (input.op === 'history') return { history: taskManagement.cleanupHistory(args) };
    const source = { sessionId: agent.id, messageId: instruction.message.id };
    if (input.op === 'commit' || input.op === 'restore' && args.previewId) {
      if (!Array.isArray(args.ids) || !args.ids.length) throw fail('MANAGEMENT_INPUT', '请提供已预览清单的明确最终子集');
      const preview = await taskManagement.getCleanupPreview(args.previewId);
      if (input.op === 'restore' ? preview.type !== 'restore' : preview.type === 'restore') throw fail('CLEANUP_SCOPE_DENIED', '清单类型不属于本次操作');
      const prepared = cleanupPrepared.get(preview.previewId);
      if (prepared?.stamp !== stamp || prepared.manifestHash !== preview.manifestHash)
        throw fail('MANAGEMENT_STALE_INSTRUCTION', '请先在本次主人指令下预览任务清单');
      const selected = [...args.ids].sort();
      if (selected.some(id => !preview.items.some(row => row.id === id))) throw fail('CLEANUP_SCOPE_DENIED', '最终清单必须是已预览任务的子集');
      const requestId = args.requestId || fingerprint([input.op, source, args.previewId, selected]);
      if (preview.consumedBy) {
        const previous = taskManagement.cleanupHistory({ receiptId: preview.consumedBy })[0];
        if (previous?.requestId !== requestId || fingerprint(previous.confirmedBy?.ids) !== fingerprint(selected))
          throw fail('CLEANUP_PREVIEW_CONSUMED', '清单已处理；请读取归档回执，不要重复确认或扩大范围');
        if (previous.status !== 'partial') return previous;
      }
      // Reversible presentation changes use this real owner instruction as
      // authority. The store still requires a host-only frozen-list capability.
      await authority(exec, stamp);
      const confirmedBy = taskManagement.createCleanupConfirmation({ previewId: preview.previewId, manifestHash: preview.manifestHash,
        ids: selected, actorId: 'desktop-owner', source });
      const commit = input.op === 'restore' ? taskManagement.restoreCleanup : taskManagement.commitCleanup;
      return commit({ previewId: args.previewId, requestId, ids: selected, confirmedBy });
    }
    const preview = await taskManagement.previewRestore({ scope: globalScope, receiptId: args.receiptId, ids: args.ids });
    await authority(exec, stamp);
    return rememberCleanup(preview, stamp);
  });
}
