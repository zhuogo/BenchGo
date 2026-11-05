const readOnlyTools = new Set(['web_search', 'web_fetch', 'read', 'read_image', 'glob', 'grep']);

/** Only host-known official identities establish read-only behavior. */
export const isReadOnlyWorkerTool = name => readOnlyTools.has(name);

/** Analyze the complete official log, including nested PTC dispatches. */
export function executionEffects(log) {
  const calls = [], pending = new Map();
  const addCall = (kind, id, name) => {
    const call = { id: id ?? `unidentified:${kind}:${calls.length}`, name };
    calls.push(call);
    // Malformed calls cannot borrow another call's receipt.
    if (id !== undefined && id !== null) {
      const key = `${kind}:${id}`;
      if (!pending.has(key)) pending.set(key, []);
      pending.get(key).push(call);
    }
    return call;
  };
  const settle = (kind, id, result, name) => {
    const key = `${kind}:${id}`, queue = id == null ? undefined : pending.get(key);
    const call = queue?.shift() ?? (kind === 'ptc' ? addCall(kind, id, name) : undefined);
    if (call) {
      call.result = result;
      // A settled PTC event may exist without its start in a legacy log.
      if (pending.get(key)?.[0] === call) pending.get(key).shift();
    }
  };
  for (const event of log.events || []) {
    const message = event.data?.message;
    if (event.type === 'assistant/message') for (const block of message?.content || []) {
      if (block.type === 'tool-call') addCall('tool', block.id, block.name);
    }
    if (event.type === 'tool/result') {
      const callId = message?.toolCallId ?? message?.source?.callId;
      settle('tool', callId, { failed: message?.isError === true || !!event.data?.error,
        code: event.data?.error?.code ?? event.data?.error?.info?.code });
    }
    if (event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch') {
      if (event.type === 'tool/ptc-dispatch-start') addCall('ptc', event.data.subCallId, event.data.name);
      else settle('ptc', event.data.subCallId, {
        failed: event.data.isError === true || !!event.data.error, code: event.data.error?.code,
      }, event.data.name);
    }
  }
  const unknownCallIds = [...new Set(calls.filter(({ name, result }) => {
    if (isReadOnlyWorkerTool(name)) return false;
    return !result || (result.failed && result.code !== 'ABORTED_BEFORE_DISPATCH');
  }).map(({ id }) => id))];
  return { effectsVerified: !unknownCallIds.length, unknownCallIds };
}
