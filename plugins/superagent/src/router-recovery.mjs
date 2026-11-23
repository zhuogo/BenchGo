import { createHash } from 'node:crypto';
import { recoveryStorage } from './execution-evidence.mjs';
import { fallbackRequestIds } from './model-fallback.mjs';

export const routerRecoverySource = 'benchgo-router-recovery';
const interrupted = reason => reason?.kind === 'interrupted'
  || reason?.kind === 'aborted' && reason.reason?.kind === 'disposed';

/** Bind recovery notices to the immediately preceding interrupted human request. */
export function routerRecoveryRequests(events, fallbacks = fallbackRequestIds(events)) {
  const requests = new Map();
  let active, previous;
  for (const event of events) {
    if (event.type === 'turn/start') active = { turn: event.data?.turn, requestId: undefined };
    if (!active) continue;
    if (event.type === 'user/message') {
      const { id, source } = event.data;
      if (source?.kind === 'user') active.requestId = id;
      else if (fallbacks.has(id)) active.requestId = fallbacks.get(id);
      else if (source?.kind === routerRecoverySource) {
        if (!active.requestId && previous && (source.requestId === undefined || source.requestId === previous)) {
          requests.set(id, previous);
          active.requestId = previous;
        }
      } else if (source?.kind !== 'runtime-context' && source?.kind !== 'agent-instructions') {
        // A later internal request cannot borrow an older human instruction.
        active.requestId = undefined;
      }
    }
    if (event.type === 'turn/end' && event.data?.turn === active.turn) {
      previous = interrupted(event.data.reason) ? active.requestId : undefined;
      active = undefined;
    }
  }
  return { requests, interruptedRequestId: active ? active.requestId : previous };
}

/** Inspect original durable events, before the host adds crash-repair closers. */
export function routerRecoveryEvidence(events) {
  const started = new Map();
  let openTurn = false, pendingUser = false, ending;
  for (const event of events) {
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') pendingUser = true;
    if (event.type === 'turn/start') { openTurn = true; ending = undefined; pendingUser = false; }
    if (event.type === 'turn/end') { openTurn = false; ending = event.data?.reason; }
    if (event.type === 'tool/call') started.set(event.data.callId, { callId: event.data.callId, seq: event.seq });
    if (event.type === 'tool/result') {
      const callId = event.data?.message?.source?.callId ?? event.data?.message?.toolCallId;
      // Synthetic outcome-unknown errors are not receipts. They must survive
      // subsequent host restarts until external state is actually reconciled.
      if (event.data?.error?.code === 'TOOL_OUTCOME_UNKNOWN') started.set(callId, { callId, seq: event.seq });
      else started.delete(callId);
    }
  }
  return {
    lastSeq: events.at(-1)?.seq ?? null,
    hash: createHash('sha256').update(JSON.stringify(events)).digest('hex'),
    needsContinuation: pendingUser || openTurn || interrupted(ending),
    unknownEffects: [...started.values()],
  };
}

/** Missing heartbeat is never evidence of death; the official writer lease is. */
export async function inspectRouterRecovery({ ctx, sessionId, signal }) {
  signal?.throwIfAborted();
  if (ctx.agents.get(sessionId)) return { status: 'live', sessionId };
  const persistence = recoveryStorage(ctx);
  if (!persistence?.open) throw new Error('无法核实 Router 单写者状态：官方持久化服务不可用');
  const handle = await persistence.open(sessionId, 'write', { signal });
  try {
    signal?.throwIfAborted();
    if (handle.id !== sessionId || handle.access !== 'write') throw new Error('Router 写入者身份不一致');
    const stored = await handle.read(undefined, undefined, { signal });
    return { status: 'inactive', sessionId, ...routerRecoveryEvidence(stored.events) };
  } finally { await handle.close(); }
}

/** The host owns this timer. It only restores an absent Router, never a live one. */
export function createRouterWatchdog({ engine, intervalMs = 30_000, onError = () => {} }) {
  let timer, pending, stopped = false;
  const tick = () => {
    if (stopped) return Promise.resolve({ status: 'stopped' });
    if (pending) return pending;
    pending = Promise.resolve().then(() => engine.recoverMain()).finally(() => { pending = undefined; });
    return pending;
  };
  return {
    tick,
    start() {
      if (stopped || timer) return;
      timer = setInterval(() => { void tick().catch(onError); }, intervalMs);
      timer.unref?.();
    },
    async stop() { stopped = true; clearInterval(timer); timer = undefined; await pending?.catch(() => {}); },
  };
}
