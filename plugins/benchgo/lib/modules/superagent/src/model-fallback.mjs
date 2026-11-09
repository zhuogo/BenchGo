/** Durable host continuations; a fallback notice never supplies user authority. */
export const modelFallbackType = 'plugin:benchgo-plugin/model-fallback';
export const modelFallbackSource = 'benchgo-model-fallback';
export const modelRouteType = 'plugin:benchgo-plugin/model-route';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export function fallbackCallSignature(name, args) {
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* Preserve opaque input. */ } }
  return JSON.stringify([name, canonical(args)]);
}
export function requestExecutionEvents(events, requestId) {
  const request = events.findIndex(event => event.type === 'user/message' && event.data?.id === requestId);
  const start = events.findLastIndex((event, index) => event.type === 'turn/start' && (request < 0 || index < request));
  return events.slice(Math.max(0, start));
}
export function dispatchedCallSignatures(events) {
  return [...new Set(events.filter(event => event.type === 'tool/call').map(event => fallbackCallSignature(event.data.name, event.data.arguments)))];
}

// Exact Router tool contracts from service.mjs; no prefix or model annotations.
const routerQueries = new Set(['assistant_context', 'assistant_tickets', 'assistant_projects', 'assistant_sessions', 'assistant_history',
  'assistant_session_search', 'assistant_ledger_read', 'assistant_capabilities', 'assistant_models', 'assistant_memory_search',
  'assistant_summarize', 'assistant_analyze_image', 'assistant_device_status', 'schedule_list']);
export function isRouterQuery(name, args) {
  if (routerQueries.has(name)) return true;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return false; } }
  if (!args || typeof args !== 'object') return false;
  if (name === 'assistant_config') return !args.patch;
  if (name === 'assistant_memory') return !args.remove && !args.content;
  if (name === 'assistant_profile') return args.op !== 'update';
  if (name === 'assistant_pet') return args.op === 'catalog';
  if (name === 'assistant_review') return args.op !== 'enqueue';
  if (name === 'assistant_goals') return args.op === undefined || ['list', 'get'].includes(args.op);
  return false;
}

export function readModelFallbacks(events) {
  const plans = new Map();
  let turn;
  for (const event of events) {
    if (event.type === 'turn/start') turn = event.data?.turn;
    if (event.type === modelFallbackType && event.ignorable === true) {
      const row = event.data;
      if (row?.kind === 'cancel') { if (plans.has(row.id)) plans.get(row.id).cancelled = true; }
      else if (row?.id && row.message?.source?.kind === modelFallbackSource && row.message.source.fallbackId === row.id) {
        plans.set(row.id, { ...row });
      }
    }
    if (event.type === 'user/message' && event.data?.source?.kind === modelFallbackSource) {
      const plan = plans.get(event.data.source.fallbackId);
      if (plan?.message.id === event.data.id) plan.turn = turn;
    }
    if (event.type === 'turn/end') {
      for (const plan of plans.values()) {
        if (plan.turn === event.data?.turn) plan.end = event.data.reason;
        if (plan.failedTurn === event.data?.turn && event.data.reason?.kind === 'aborted'
          && event.data.reason.reason?.kind === 'user') plan.cancelled = true;
      }
      turn = undefined;
    }
  }
  return plans;
}

/** Only a persisted host plan can associate its exact notice with an earlier request. */
export function fallbackRequestIds(events) {
  const result = new Map(), users = new Set();
  const plans = readModelFallbacks(events);
  for (const event of events) {
    if (event.type !== 'user/message') continue;
    if (event.data?.source?.kind === 'user') users.add(event.data.id);
    const plan = plans.get(event.data?.source?.fallbackId);
    if (plan && !plan.cancelled && plan.message.id === event.data?.id && users.has(plan.requestId)) result.set(event.data.id, plan.requestId);
  }
  return result;
}
