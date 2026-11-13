export const MAINTENANCE_WATCHDOG_REASONS = Object.freeze([
  'MAINTENANCE_EXECUTION_TIMEOUT', 'MAINTENANCE_SCHEDULER_STALLED',
]);

const states = new Set(['disabled', 'running', 'checking', 'yielded', 'idle']);
const instant = value => typeof value === 'string'
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/u.test(value) ? Date.parse(value) : NaN;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Inspect only the single executor's bounded status. No action or user content
 * is returned. Null preserves uncertainty, including older hosts without it. */
export function inspectMaintenanceHealth(maintenance, { now = Date.now(), graceMs = 120_000 } = {}) {
  const unknown = [], result = { executionTimeout: null, schedulerStalled: null, unknown };
  if (!object(maintenance)) { unknown.push('maintenance'); return result; }
  const clear = () => ({ executionTimeout: false, schedulerStalled: false, unknown });
  if (maintenance.enabled === false || ['disabled', 'yielded'].includes(maintenance.state)) return clear();
  if (maintenance.enabled !== true || !states.has(maintenance.state)) {
    unknown.push('state'); return result;
  }
  const quietUntil = instant(maintenance.quietUntil);
  if (maintenance.quietUntil != null && !Number.isFinite(quietUntil)) {
    unknown.push('quietUntil'); return result;
  }
  if (quietUntil > now) return clear();
  if (typeof maintenance.running !== 'boolean'
    || maintenance.running !== (maintenance.state === 'running')) {
    unknown.push('running'); return result;
  }
  const executing = maintenance.state === 'running' && maintenance.running;
  if (executing) {
    const startedAt = instant(maintenance.active?.startedAt), deadlineAt = instant(maintenance.deadlineAt);
    const activeDeadline = maintenance.active?.deadlineAt;
    if (!Number.isFinite(startedAt) || !Number.isFinite(deadlineAt) || startedAt > now || deadlineAt < startedAt
      || activeDeadline !== undefined && instant(activeDeadline) !== deadlineAt) unknown.push('deadlineAt');
    else result.executionTimeout = deadlineAt <= now;
    // A real active request owns its deadline; its normal duration is not a
    // scheduler failure, even when a queued item is waiting behind it.
    result.schedulerStalled = false;
    return result;
  }
  result.executionTimeout = false;
  if (!Number.isSafeInteger(maintenance.pending) || maintenance.pending < 0) { unknown.push('pending'); return result; }
  if (maintenance.pending === 0) { result.schedulerStalled = false; return result; }
  const nextCheckAt = instant(maintenance.nextCheckAt);
  if (typeof maintenance.schedulerActive !== 'boolean' || !Number.isFinite(nextCheckAt)) {
    unknown.push('nextCheckAt'); return result;
  }
  const lastCheckAt = instant(maintenance.lastCheckAt);
  if (maintenance.lastCheckAt != null && (!Number.isFinite(lastCheckAt) || lastCheckAt > now || nextCheckAt < lastCheckAt)) {
    unknown.push('lastCheckAt'); return result;
  }
  result.schedulerStalled = now - nextCheckAt > graceMs;
  return result;
}
