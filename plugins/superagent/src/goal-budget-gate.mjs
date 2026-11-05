import { randomUUID } from 'node:crypto';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { executionEffects } from './execution-effects.mjs';

export const GOAL_BUDGET_EXHAUSTED = 'BENCHGO_GOAL_BUDGET_EXHAUSTED';
export const EXECUTION_BUDGET_HOOK = 'benchgo-execution-budget-exhausted';
const denials = new WeakMap();
export const goalBudgetDenial = error => error instanceof Error ? denials.get(error) : undefined;
function denialError(decision) {
  const error = new LlmError('Goal budget exhausted', GOAL_BUDGET_EXHAUSTED);
  denials.set(error, decision);
  return error;
}

/** Non-Agent calls have no durable assistant event, so settle their own request receipt. */
async function* meterRequest(next, { database, ticketId, requestId }) {
  let tokens = null;
  try {
    for await (const chunk of next()) {
      if (chunk.type === 'usage') tokens = Number.isSafeInteger(chunk.usage?.totalTokens) && chunk.usage.totalTokens >= 0 ? chunk.usage.totalTokens : null;
      yield chunk;
    }
  } finally { database.recordGoalRequestUsage({ ticketId, requestId, tokens, cost: null }); }
}

function reserveRequest({ database, ticketId, onDenied }) {
  const requestId = randomUUID(), decision = database.reserveGoalRequest({ ticketId, requestId });
  if (!decision.allowed) { const error = denialError(decision); onDenied?.(decision, error); throw error; }
  return requestId;
}

export function goalBudgetLlm(llm, { database, ticketId }) {
  if (!database.ticketGoalBudget(ticketId)) return llm;
  return { stream(options) {
    options.signal?.throwIfAborted();
    const requestId = reserveRequest({ database, ticketId });
    return meterRequest(() => llm.stream(options), { database, ticketId, requestId });
  } };
}

/** One reservation per stream dispatch, including retry and compaction calls. */
export function installGoalBudgetGate(ctx, { database, ticketId, sessionId, onDenied }) {
  if (!database.ticketGoalBudget(ticketId)) return { dispose() {}, owns: () => false };
  const denied = new WeakSet();
  const dispose = ctx.on('llm/stream', (options, next) => {
    if (options.sessionId !== sessionId) return next();
    options.signal?.throwIfAborted();
    const requestId = reserveRequest({ database, ticketId, onDenied: (decision, error) => { denied.add(error); onDenied?.(decision); } });
    return options.purpose === 'compaction' ? meterRequest(next, { database, ticketId, requestId }) : next();
  });
  return { dispose, owns: error => error instanceof Error && denied.has(error) };
}

export function isVerifiedPauseEnding(reason, saved) {
  // The host records this exact ending only after observing its own gate Error.
  // Separate installed LLM instances may serialize that Error as UNKNOWN.
  return reason?.kind === 'blocked' || (saved?.waitingExecutionBudget?.kind === 'execution-time'
    && reason?.kind === 'aborted' && reason.reason?.kind === 'hook' && reason.reason.reason === EXECUTION_BUDGET_HOOK
    && JSON.stringify(reason) === JSON.stringify(saved.waitingExecutionBudget.terminal)) || (saved?.waitingBudget?.terminal?.kind === 'error'
    && reason?.kind === 'error' && JSON.stringify(reason) === JSON.stringify(saved.waitingBudget.terminal));
}

/** A stopped tool is not proof that an external effect did not happen. */
export function executionBudgetPause(log, deadlineAt) {
  const events = log.events || [], terminal = events.at(-1);
  if (terminal?.type !== 'turn/end' || terminal.data?.reason?.kind !== 'aborted'
    || terminal.data.reason.reason?.kind !== 'hook' || terminal.data.reason.reason.reason !== EXECUTION_BUDGET_HOOK) {
    throw Object.assign(new Error('Execution deadline has no verified official pause ending'), { code: 'EXECUTION_PAUSE_UNVERIFIED' });
  }
  return { kind: 'execution-time', deadlineAt, terminal: terminal.data.reason,
    ...executionEffects(log) };
}
