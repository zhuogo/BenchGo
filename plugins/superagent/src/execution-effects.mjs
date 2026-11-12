const readOnlyTools = new Set(['web_search', 'web_fetch', 'read', 'read_image', 'glob', 'grep']);

/** Only host-known official identities establish read-only behavior. */
export const isReadOnlyWorkerTool = name => readOnlyTools.has(name);

const object = value => {
  try { value = typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
};
const beforeDispatchCodes = new Set(['ABORTED_BEFORE_DISPATCH', 'FS_SANDBOX_DENIED', 'UNKNOWN_TOOL', 'INVALID_TOOL_ARGS', 'INVALID_ARGUMENTS',
  'ACTION_TARGET_NOT_FOUND', 'WORKER_TOOL_SCOPE', 'WORKER_AUTHORIZATION_CHANGED', 'WORKER_TICKET_INACTIVE',
  'MANAGEMENT_OWNER_REQUIRED', 'MANAGEMENT_APPROVAL_UNAVAILABLE', 'MANAGEMENT_APPROVAL_DENIED', 'SETTINGS_UNAVAILABLE', 'CLEANUP_UNAVAILABLE']);
const unknownFailure = result => result?.failed && !beforeDispatchCodes.has(result.code);
const output = content => object((content || []).filter(block => block.type === 'text').map(block => block.text).join('\n'));

/** This exact host tool separates local preparation from one-time submission. */
function externalActionUnknown(call) {
  const operation = object(call.arguments)?.operation, result = call.result;
  if (result?.value?.requiresReconciliation === true || ['submitted', 'uncertain'].includes(result?.value?.state)) return true;
  if (operation === 'catalog' || operation === 'prepare') return false;
  if (operation !== 'submit') return false;
  if (result?.code === 'ABORTED_BEFORE_DISPATCH') return false;
  if (result?.failed) return unknownFailure(result);
  return !result || !['completed', 'denied', 'handoff'].includes(result.value?.state);
}

/** Analyze the complete official log, including nested PTC dispatches. */
export function executionEffects(log, receipts = new Map()) {
  const calls = [], pending = new Map();
  const addCall = (kind, id, name, args) => {
    const call = { id: id ?? `unidentified:${kind}:${calls.length}`, name, arguments: args };
    calls.push(call);
    // Malformed calls cannot borrow another call's receipt.
    if (id !== undefined && id !== null) {
      const key = `${kind}:${id}`;
      if (!pending.has(key)) pending.set(key, []);
      pending.get(key).push(call);
    }
    return call;
  };
  const settle = (kind, id, result, name, args) => {
    const key = `${kind}:${id}`, queue = id == null ? undefined : pending.get(key);
    const call = queue?.shift() ?? (kind === 'ptc' ? addCall(kind, id, name, args) : undefined);
    if (call) {
      call.result = { failed: result.failed, code: result.code,
        ...(call.name === 'assistant_external_action' ? { value: output(result.content) } : {}) };
      // A settled PTC event may be logged without its start.
      if (pending.get(key)?.[0] === call) pending.get(key).shift();
    }
  };
  for (const event of log.events || []) {
    const message = event.data?.message;
    if (event.type === 'assistant/message') for (const block of message?.content || []) {
      if (block.type === 'tool-call') addCall('tool', block.id, block.name, block.arguments);
    }
    if (event.type === 'tool/result') {
      const callId = message?.toolCallId ?? message?.source?.callId;
      settle('tool', callId, { failed: message?.isError === true || !!event.data?.error,
        code: event.data?.error?.code ?? event.data?.error?.info?.code ?? receipts.get(callId)?.code, content: message?.content });
    }
    if (event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch') {
      if (event.type === 'tool/ptc-dispatch-start') addCall('ptc', event.data.subCallId, event.data.name, event.data.arguments);
      else settle('ptc', event.data.subCallId, {
        failed: event.data.isError === true || !!event.data.error, code: event.data.error?.code ?? event.data.error?.info?.code, content: event.data.content,
      }, event.data.name, event.data.arguments);
    }
  }
  const unknownCallIds = [...new Set(calls.filter(call => {
    const { name, result } = call;
    if (isReadOnlyWorkerTool(name)) return false;
    if (name === 'assistant_external_action') return externalActionUnknown(call);
    return !result || unknownFailure(result);
  }).map(({ id }) => id))];
  return { effectsVerified: !unknownCallIds.length, unknownCallIds };
}
