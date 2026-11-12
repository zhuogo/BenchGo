// This disposable is only a cache of our scoped contributions, never proof of
// session ownership. The engine validates the persisted thread/session binding.
const attachmentKey = Symbol.for('benchgo.superagent.router-session-attachment');

export function routerWriterClosing(agent) {
  try { agent.ctx.fiber.assertActive(); return false; }
  catch { return true; }
}

/** Scope teardown can precede registry removal while the official log closes. */
export async function waitRouterWriterRelease({ ctx, agent, signal }) {
  signal.throwIfAborted();
  let stop, abort;
  try {
    await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      stop = ctx.on('agent/disposed', payload => { if (payload.agent === agent) resolve(); }, { global: true });
      if (ctx.agents.get(agent.id) !== agent) resolve();
      if (signal.aborted) abort();
    });
  } finally { stop?.(); signal.removeEventListener('abort', abort); }
}

async function idle(agent, signal) {
  signal.throwIfAborted();
  let aborted;
  const cancelled = new Promise((_, reject) => {
    aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
  });
  try { await Promise.race([agent.whenIdle(), cancelled]); }
  finally { signal.removeEventListener('abort', aborted); }
}

/** Reserve the official maintenance phase; waking input stays in its inbox. */
export async function atRouterSessionBoundary(agent, { signal, current }, operation) {
  for (;;) {
    await idle(agent, signal);
    signal.throwIfAborted();
    if (!current()) return null;
    let entered = false;
    try {
      return await agent.runMaintenance(async boundarySignal => {
        entered = true;
        signal.throwIfAborted(); boundarySignal.throwIfAborted();
        if (!current()) return null;
        return operation(AbortSignal.any([signal, boundarySignal]));
      });
    } catch (error) {
      // Another official driver can win between whenIdle and runMaintenance.
      // A failure inside our operation is real and must not be retried here.
      signal.throwIfAborted();
      if (!current()) return null;
      if (entered || error.message !== `agent "${agent.id}" already has active work`) throw error;
    }
  }
}

/** Add/remove only BenchGo contributions; a borrowed Agent keeps its owner. */
export async function mountRouterSession({ agent, scope = agent.ctx, setup, signal }) {
  signal.throwIfAborted();
  await agent[attachmentKey]?.dispose();
  signal.throwIfAborted();
  const fiber = scope.plugin({ name: 'benchgo-router-session', apply: child => setup(child, agent) });
  let disposal;
  const attachment = { agent, current: () => agent[attachmentKey] === attachment, dispose: () => disposal ||= (async () => {
    signal.removeEventListener('abort', abort);
    if (agent[attachmentKey] === attachment) delete agent[attachmentKey];
    await fiber.dispose();
  })() };
  const abort = () => { void attachment.dispose().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  fiber.ctx.effect(() => () => {
    if (agent[attachmentKey] === attachment) delete agent[attachmentKey];
  });
  try {
    await fiber;
    signal.throwIfAborted();
    agent[attachmentKey] = attachment;
    return attachment;
  } catch (error) { await attachment.dispose(); throw error; }
  finally { signal.removeEventListener('abort', abort); }
}
