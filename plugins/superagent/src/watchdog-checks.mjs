import { createHash } from 'node:crypto';

const summaries = Object.freeze({
  FACTS_STALE: '主系统执行事实已超过观察窗口，当前状态待核实',
  SCHEDULER_STALLED: '主系统调度心跳已超过观察窗口',
  EXECUTION_INACTIVE: '原 Worker 执行持续不可见，且没有已知合法等待',
  LEASE_EXPIRED: '执行租约持续过期，原分派仍未被既有机制处理',
  REQUEST_DEADLINE_EXCEEDED: '正在进行的模型请求已超过其真实截止时间',
  STOP_UNCONFIRMED: '停止请求已超过原系统确认期限，执行端尚未确认',
  RECOVERY_NOT_CONVERGING: '既有自动核查或恢复多次尝试后仍未收敛',
});
const hostReasons = new Set(['FACTS_STALE', 'SCHEDULER_STALLED']);
const executionReasons = Object.keys(summaries).filter(code => !hostReasons.has(code));
const terminal = new Set(['completed', 'failed', 'closed', 'cancelled']);
const ticketStates = new Set(['open', 'waiting', 'pausing', 'paused', 'cancelling', ...terminal]);
const assignmentStates = new Set(['queued', 'claimed', 'waiting', 'paused', 'uncertain', ...terminal]);
const runStates = new Set(['prepared', 'submitted', 'running', 'waiting', 'verifying', 'uncertain', ...terminal]);
const MAX_EXECUTIONS = 1000;
const MAX_CANDIDATES = MAX_EXECUTIONS * executionReasons.length + hostReasons.size;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const time = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/u.test(value) ? Date.parse(value) : NaN;
const iso = value => new Date(value).toISOString();
const cursor = facts => integer(facts?.currentCursor) ? facts.currentCursor : integer(facts?.cursor) ? facts.cursor : null;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const executionKey = execution => digest([execution.ticketId, execution.assignmentId, execution.runId,
  execution.sessionId, execution.fence, execution.instructionRevision]);
const keyFor = (reasonCode, execution) => execution ? `${reasonCode}:${executionKey(execution)}` : reasonCode;

function identity(row) {
  const value = { ticketId: row?.ticket?.id, assignmentId: row?.assignment?.id,
    runId: row?.run?.id, sessionId: row?.run?.sessionId, fence: row?.assignment?.fence,
    instructionRevision: row?.ticket?.instructionRevision };
  if (!['ticketId', 'assignmentId', 'runId', 'sessionId'].every(field => id(value[field]))
    || !integer(value.fence) || !integer(value.instructionRevision, 1)
    || row.run.instructionRevision !== value.instructionRevision) return null;
  return value;
}

function priorCandidate(value, key) {
  if (!value || !Object.hasOwn(summaries, value.reasonCode) || !id(value.bootId)
    || !Number.isFinite(time(value.firstObservedAt)) || !Number.isFinite(time(value.lastObservedAt))
    || time(value.firstObservedAt) > time(value.lastObservedAt) || !integer(value.observations, 1)) return null;
  let execution;
  if (!hostReasons.has(value.reasonCode)) {
    const source = value.execution;
    if (!source || !['ticketId', 'assignmentId', 'runId', 'sessionId'].every(field => id(source[field]))
      || !integer(source.fence) || !integer(source.instructionRevision, 1)) return null;
    execution = { ticketId: source.ticketId, assignmentId: source.assignmentId, runId: source.runId,
      sessionId: source.sessionId, fence: source.fence, instructionRevision: source.instructionRevision };
  }
  if (key !== keyFor(value.reasonCode, execution)) return null;
  return { key, reasonCode: value.reasonCode, kind: execution ? 'execution' : 'host',
    ...(execution ? { execution } : {}), bootId: value.bootId,
    firstObservedAt: value.firstObservedAt, lastObservedAt: value.lastObservedAt,
    observations: value.observations, evidenceCursor: integer(value.evidenceCursor) ? value.evidenceCursor : null,
    reachedWindow: value.reachedWindow === true, interrupted: value.interrupted === true,
    ...(typeof value.conditionKey === 'string' && /^[a-f0-9]{64}$/u.test(value.conditionKey) ? { conditionKey: value.conditionKey } : {}) };
}

/** Tri-state wait: true is an evidenced exemption; null cannot prove either work or a hang. */
function legitimateWait(row, now) {
  if (row.ticket?.status === 'paused' || ['user', 'approval', 'paused'].includes(row.wait?.kind)) return true;
  if (row.wait?.kind === 'none') return false;
  if (['background-job', 'long-operation'].includes(row.wait?.kind)) {
    const until = time(row.wait.expectedUntil);
    return Number.isFinite(until) && until > now ? true : null;
  }
  if (row.wait?.kind === 'continuation') {
    const until = time(row.recovery?.nextCheckAt);
    return Number.isFinite(until) && until > now ? true : null;
  }
  return null;
}

/**
 * Inspect exported facts only. Candidates survive unknown observations, while
 * resolvedKeys requires fresh evidence for the particular previous condition.
 * Neither a tool event, a valid lease nor an idle Agent establishes progress.
 */
export function inspectWatchdogFacts({ facts, previous = {}, config = {}, now = Date.now() } = {}) {
  const windowMs = config.observationWindowMs ?? 120_000;
  const escalationAttempts = config.escalationAttempts ?? 3;
  const intervalMs = (config.intervalSeconds ?? 60) * 1000;
  if (!integer(now, 1) || !integer(windowMs, 1000) || !integer(escalationAttempts, 1)
    || !integer(intervalMs, 1000)) throw new TypeError('Invalid Watchdog observation configuration');
  const continuityMs = Math.max(windowMs, intervalMs * 2);
  const observedAt = time(facts?.observedAt), bootId = id(facts?.bootId) ? facts.bootId : null;
  const timestampKnown = Number.isFinite(observedAt) && observedAt <= now;
  const fresh = timestampKnown && now - observedAt <= windowMs;
  const records = Array.isArray(facts?.executions) ? facts.executions : [];
  const coverage = { snapshot: timestampKnown ? fresh ? 'fresh' : 'stale' : 'unknown',
    boot: bootId ? 'known' : 'unknown', schedulerHeartbeat: 'unknown',
    executions: { total: records.length, inspected: 0, unavailable: 0 }, unknown: [] };
  const unknown = (field, reason, execution) => {
    if (coverage.unknown.length < MAX_CANDIDATES) coverage.unknown.push({ field, reason,
      ...(execution ? { executionKey: executionKey(execution) } : {}) });
  };
  let complete = fresh && !!bootId && facts?.complete === true && facts?.truncated === false
    && Array.isArray(facts?.executions) && records.length <= MAX_EXECUTIONS;
  if (!timestampKnown) unknown('observedAt', 'unavailable-or-future');
  if (!bootId) unknown('bootId', 'unavailable');
  if (facts?.complete !== true || facts?.truncated !== false) unknown('snapshot', 'incomplete');
  if (records.length > MAX_EXECUTIONS) unknown('executions', 'limit-exceeded');
  const candidates = {}, findings = [], conditions = [], resolvedKeys = [], checked = new Set(), previousByTicket = new Map();
  const previousEntries = previous && typeof previous === 'object' && !Array.isArray(previous) ? Object.entries(previous) : [];
  if (previousEntries.length > MAX_CANDIDATES) { complete = false; unknown('candidates', 'limit-exceeded'); }
  for (const [key, value] of previousEntries.slice(0, MAX_CANDIDATES)) {
    const stored = priorCandidate(value, key);
    if (stored) {
      candidates[key] = { ...stored, interrupted: true };
      if (stored.execution) {
        const list = previousByTicket.get(stored.execution.ticketId) || [];
        list.push(key); previousByTicket.set(stored.execution.ticketId, list);
      }
    }
  }
  let candidateCount = Object.keys(candidates).length;

  // A null predicate neither closes a prior fault nor contributes elapsed time
  // to its continuous observation window. Repeated old snapshots count once.
  function inspect(reasonCode, execution, condition, delayed = false, conditionKey) {
    const key = keyFor(reasonCode, execution), stored = candidates[key];
    checked.add(key);
    condition = !bootId || !timestampKnown ? null : condition === true ? true : condition === false ? false : null;
    conditions.push({ reasonCode, ...(execution ? { execution: { ...execution } } : {}), condition });
    if (condition === null) return;
    if (condition === false) {
      if (stored) { delete candidates[key]; candidateCount--; resolvedKeys.push(key); }
      return;
    }
    if (!stored && candidateCount >= MAX_CANDIDATES) {
      complete = false; unknown('candidates', 'limit-exceeded', execution); return;
    }
    const original = priorCandidate(previous?.[key], key);
    const consecutive = original && original.bootId === bootId && !original.interrupted && original.conditionKey === conditionKey
      && observedAt >= time(original.lastObservedAt)
      && observedAt - time(original.lastObservedAt) <= continuityMs;
    const next = { key, reasonCode, kind: execution ? 'execution' : 'host',
      ...(execution ? { execution } : {}), bootId,
      firstObservedAt: consecutive ? original.firstObservedAt : iso(observedAt), lastObservedAt: iso(observedAt),
      observations: consecutive ? original.observations + Number(observedAt > time(original.lastObservedAt)) : 1,
      evidenceCursor: cursor(facts), interrupted: false, ...(conditionKey ? { conditionKey } : {}) };
    next.reachedWindow = !delayed || next.observations >= 2 && observedAt - time(next.firstObservedAt) >= windowMs;
    if (!stored) candidateCount++;
    candidates[key] = next;
    if (next.reachedWindow) findings.push({ key, reasonCode, kind: next.kind, summary: summaries[reasonCode],
      ...(execution ? { execution: { ...execution } } : {}), evidenceCursor: next.evidenceCursor,
      firstObservedAt: next.firstObservedAt, observations: next.observations });
  }

  inspect('FACTS_STALE', null, timestampKnown ? !fresh : null);
  const heartbeatAt = time(facts?.schedulerHeartbeat?.at);
  if (fresh && bootId && Number.isFinite(heartbeatAt) && heartbeatAt <= observedAt) {
    const stale = now - heartbeatAt > windowMs;
    coverage.schedulerHeartbeat = stale ? 'stale' : 'fresh';
    inspect('SCHEDULER_STALLED', null, stale);
  } else { unknown('schedulerHeartbeat', 'unavailable-or-stale-source'); inspect('SCHEDULER_STALLED', null, null); }

  for (const row of records.slice(0, MAX_EXECUTIONS)) {
    const execution = identity(row);
    if (!execution || !fresh || !bootId) {
      coverage.executions.unavailable++;
      unknown('execution', execution ? 'stale-source' : 'identity-unavailable', execution);
      complete = false;
      if (execution) for (const reasonCode of executionReasons) inspect(reasonCode, execution, null);
      continue;
    }
    coverage.executions.inspected++;
    if (!ticketStates.has(row.ticket.status) || !assignmentStates.has(row.assignment.state) || !runStates.has(row.run.state)) {
      complete = false; unknown('domainState', 'unavailable', execution);
      for (const reasonCode of executionReasons) inspect(reasonCode, execution, null);
      continue;
    }
    if (!Array.isArray(row.watermarks) || !row.watermarks.length || row.watermarks.some(watermark => watermark?.complete !== true)) {
      complete = false; unknown('watermarks', 'incomplete', execution);
    }
    const ended = terminal.has(row.ticket.status) || terminal.has(row.run.state);
    const waiting = legitimateWait(row, now);
    if (waiting === null) unknown('wait', 'unavailable-or-unbounded', execution);
    const suspended = ended || waiting === true;
    const claimed = row.assignment.state === 'claimed';
    const alive = row.executionAlive;
    const aliveTime = time(alive?.observedAt);
    const aliveKnown = alive?.bootId === bootId && Number.isFinite(aliveTime) && aliveTime <= now
      && now - aliveTime <= windowMs && ['running', 'idle', 'absent'].includes(alive.status);
    if (!aliveKnown) unknown('executionAlive', 'unavailable-or-stale', execution);
    inspect('EXECUTION_INACTIVE', execution, suspended || !claimed || !['submitted', 'running'].includes(row.run.state) ? false
      : waiting === null || !aliveKnown ? null : alive.status === 'absent', true);
    const lease = row.assignment.leaseUntil;
    if (!integer(lease, 1)) unknown('leaseUntil', 'unavailable', execution);
    inspect('LEASE_EXPIRED', execution, suspended || !claimed ? false
      : waiting === null || !integer(lease, 1) ? null : lease <= now, true);
    const request = row.request, deadline = time(request?.deadline), requestStarted = time(request?.startedAt);
    if (!Number.isFinite(deadline)) unknown('requestDeadline', 'unavailable', execution);
    if (!['inflight', 'settled'].includes(request?.state)) unknown('request', 'unavailable', execution);
    if (request?.state === 'inflight' && (!Number.isFinite(requestStarted) || requestStarted > now
      || Number.isFinite(deadline) && deadline < requestStarted)) unknown('requestTime', 'unavailable-or-inconsistent', execution);
    inspect('REQUEST_DEADLINE_EXCEEDED', execution, suspended || request?.state === 'settled' ? false
      : waiting === null || request?.state !== 'inflight' || !Number.isFinite(deadline)
        || !Number.isFinite(requestStarted) || requestStarted > now || deadline < requestStarted ? null : deadline <= now);
    const stop = row.stop, requested = time(stop?.requestedAt), confirmed = time(stop?.confirmedAt);
    const explicitlyPaused = row.ticket.status === 'paused' || row.wait?.kind === 'paused';
    const stopConfirmed = Number.isFinite(confirmed) && confirmed <= now && (!Number.isFinite(requested) || confirmed >= requested);
    inspect('STOP_UNCONFIRMED', execution, ended || explicitlyPaused || stopConfirmed ? false
      : stop?.requestedAt === null && stop?.confirmationOverdue === false ? false
        : !Number.isFinite(requested) || requested > now || typeof stop?.confirmationOverdue !== 'boolean' ? null : stop.confirmationOverdue);
    const recovery = row.recovery;
    const recovering = recovery && id(recovery.reasonCode) && integer(recovery.attempts)
      && (recovery.automatic === true || recovery.escalated === true);
    inspect('RECOVERY_NOT_CONVERGING', execution, suspended || recovery === null ? false
      : !recovery || !integer(recovery.attempts) ? null
        : recovering && recovery.attempts >= escalationAttempts, true, recovering ? digest(recovery.reasonCode) : undefined);
    // A fresh authoritative replacement or explicit terminal state retires
    // alerts belonging to the former execution; omission alone cannot do so.
    for (const key of previousByTicket.get(execution.ticketId) || []) {
      const candidate = candidates[key];
      if (!candidate) continue;
      if (ended || executionKey(candidate.execution) !== executionKey(execution)) {
        delete candidates[key];
        candidateCount--;
        if (!resolvedKeys.includes(key)) resolvedKeys.push(key);
      }
    }
  }
  for (const [key, candidate] of Object.entries(candidates)) {
    if (!checked.has(key)) unknown('candidate', 'current-evidence-unavailable', candidate.execution);
  }
  return { findings, conditions, candidates, coverage, complete, resolvedKeys };
}
