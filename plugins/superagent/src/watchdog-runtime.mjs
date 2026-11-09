import { watchdogDigest } from './watchdog-store.mjs';
import { inspectWatchdogFacts } from './watchdog-checks.mjs';
import { createExecutionSummaryInput, zeroFileChangeWindow } from './execution-summary-input.mjs';

const iso = value => new Date(value).toISOString();
const clone = value => structuredClone(value);
const networkKey = 'host:reachability';
const identityKey = 'host:identity';
const judgeCodes = { EXECUTION_INACTIVE: 'worker-inactive', LEASE_EXPIRED: 'lease-expired',
  REQUEST_DEADLINE_EXCEEDED: 'request-overdue', STOP_UNCONFIRMED: 'stop-overdue', RECOVERY_NOT_CONVERGING: 'recovery-not-converging' };
const safeCode = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || '') ? error.code : error?.name === 'TimeoutError' ? 'WATCHDOG_TIMEOUT' : 'WATCHDOG_PROBE_FAILED';

function unchangedFileCandidate(execution, facts, config, now) {
  if (facts.complete !== true || facts.truncated !== false || !Number.isFinite(Date.parse(facts.observedAt))
    || Date.parse(facts.observedAt) > now || now - Date.parse(facts.observedAt) > config.observationWindowMs
    || execution.ticket?.status !== 'open' || execution.assignment?.state !== 'claimed' || execution.run?.state !== 'running'
    || execution.run.instructionRevision !== execution.ticket.instructionRevision || execution.wait?.kind !== 'none'
    || execution.executionAlive?.status !== 'running' || execution.executionAlive.bootId !== facts.bootId
    || !Number.isFinite(Date.parse(execution.executionAlive.observedAt)) || Date.parse(execution.executionAlive.observedAt) > now
    || now - Date.parse(execution.executionAlive.observedAt) > config.observationWindowMs
    || !execution.watermarks?.length || execution.watermarks.some(row => row.complete !== true)) return null;
  let safe;
  try { safe = createExecutionSummaryInput({ ticketId: execution.ticket.id, runId: execution.run.id,
    instructionRevision: execution.ticket.instructionRevision, watermark: facts.currentCursor ?? facts.cursor,
    observedAt: facts.observedAt, modelEvidence: execution.modelEvidence }); } catch { return null; }
  if (safe.binding.fence !== execution.assignment.fence || !safe.evidenceComplete || !safe.counts.calls || !safe.counts.results
    || !safe.events.some(row => ['tool/call', 'tool/result'].includes(row.kind) && row.count > 0)) return null;
  const window = zeroFileChangeWindow(safe, config.observationWindowMs);
  if (!window) return null;
  const identity = { ticketId: execution.ticket.id, assignmentId: execution.assignment.id, runId: execution.run.id,
    sessionId: execution.run.sessionId, fence: execution.assignment.fence, instructionRevision: execution.ticket.instructionRevision };
  return { key: `observed-files:${watchdogDigest(Object.values(identity))}`, execution: identity,
    evidenceCursor: facts.currentCursor ?? facts.cursor, firstObservedAt: window.startedAt, reasonCode: 'OBSERVED_FILES_UNCHANGED' };
}

async function bounded(operation, signal) {
  signal.throwIfAborted();
  let reject;
  const aborted = new Promise((_, fail) => { reject = fail; });
  const cancel = () => reject(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  try { signal.throwIfAborted(); return await Promise.race([Promise.resolve().then(operation), aborted]); }
  finally { signal.removeEventListener('abort', cancel); }
}

function queueSignal(state, incident, phase, check, at) {
  const id = `watchdog-signal:${watchdogDigest([incident.incidentKey, phase])}`;
  if (state.signals.some(row => row.id === id)) return;
  if (phase === 'resolved') for (const row of state.signals) {
    if (row.incidentKey === incident.incidentKey && row.state === 'pending') row.state = 'superseded';
  }
  state.signals.push({ id, incidentKey: incident.incidentKey, phase, kind: incident.kind, targetId: state.targetId,
    observedAt: at, checkId: check.id, evidenceCursor: incident.evidenceCursor ?? null,
    ...(incident.execution ? { execution: incident.execution } : {}), reasonCode: incident.reasonCode,
    summary: phase !== 'resolved' ? incident.summary
      : incident.reasonCode === 'TARGET_UNREACHABLE' ? '主系统监督接口已恢复可达，原不可达告警已关闭。'
        : incident.reasonCode === 'TARGET_IDENTITY_MISMATCH' ? '主系统监督目标身份已重新核实，原身份告警已关闭。'
          : incident.reasonCode === 'FACTS_STALE' ? '主系统执行事实已恢复更新，原过期告警已关闭。'
            : incident.reasonCode === 'SCHEDULER_STALLED' ? '主系统调度心跳已恢复，原告警已关闭。'
              : incident.kind === 'model' ? '当前事实已解除该次模型疑似告警，原判断保留在监督历史。'
                : '当前事实已解除该次执行告警，原异常保留在监督历史。',
    state: 'pending', attempts: 0, nextAttemptAt: null });
}

function reconcileIncidents(state, { findings, resolvedKeys = [] }, check, config, at) {
  for (const finding of findings) {
    let incident = state.incidents.find(row => row.conditionKey === finding.key && row.active);
    if (!incident) {
      incident = { conditionKey: finding.key, incidentKey: `watchdog-incident:${watchdogDigest([finding.key, check.id])}`,
        kind: finding.kind, reasonCode: finding.reasonCode, summary: finding.summary,
        ...(finding.execution ? { execution: finding.execution } : {}), evidenceCursor: finding.evidenceCursor ?? null,
        firstObservedAt: finding.firstObservedAt || at, lastObservedAt: at, active: true, phase: 'opened', observations: 0 };
      state.incidents.push(incident);
      queueSignal(state, incident, 'opened', check, at);
    }
    if (incident.lastCheckId !== check.id) incident.observations = Number.isSafeInteger(finding.observations)
      ? finding.observations : incident.observations + 1;
    Object.assign(incident, { lastCheckId: check.id, lastObservedAt: at, evidenceCursor: finding.evidenceCursor ?? null });
    if (incident.phase === 'opened' && incident.observations >= config.escalationAttempts) {
      incident.phase = 'escalated'; queueSignal(state, incident, 'escalated', check, at);
    }
  }
  const current = new Set(findings.map(row => row.key));
  for (const incident of state.incidents) {
    if (!incident.active || current.has(incident.conditionKey) || !resolvedKeys.includes(incident.conditionKey)) continue;
    Object.assign(incident, { active: false, phase: 'resolved', resolvedAt: at, lastObservedAt: at });
    queueSignal(state, incident, 'resolved', check, at);
  }
  const protectedKeys = new Set(state.signals.filter(row => row.state === 'pending').map(row => row.incidentKey));
  const settled = state.incidents.filter(row => !row.active && !protectedKeys.has(row.incidentKey)).slice(-config.retentionChecks);
  state.incidents = state.incidents.filter(row => row.active || protectedKeys.has(row.incidentKey)).concat(settled);
  state.signals = state.signals.filter(row => row.state === 'pending').concat(state.signals.filter(row => row.state !== 'pending').slice(-config.retentionChecks * 3));
}

const signalPayload = row => Object.fromEntries(['id', 'incidentKey', 'phase', 'kind', 'targetId', 'observedAt', 'checkId',
  'evidenceCursor', 'execution', 'reasonCode', 'summary'].filter(key => row[key] !== undefined).map(key => [key, row[key]]));

/** Read-only probes and signal delivery are driven only by official Schedule receipts. */
export function createWatchdogRuntime({ store, config, client, judge, now = Date.now }) {
  const shutdown = new AbortController();
  let pending, queued;
  async function deliver() {
    const rows = store.snapshot().signals.filter(row => row.state === 'pending' && (!row.nextAttemptAt || Date.parse(row.nextAttemptAt) <= now())).slice(0, 4);
    await Promise.all(rows.map(async row => {
      const startedAt = iso(now());
      await store.update(state => {
        const current = state.signals.find(item => item.id === row.id);
        if (current?.state === 'pending') { current.attempts++; current.lastAttemptAt = startedAt; }
      });
      try {
        const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(config.probeTimeoutMs)]);
        const receipt = await bounded(() => client.sendSignal(signalPayload(row), { signal }), signal);
        if (receipt?.accepted !== true || receipt.id !== row.id) throw Object.assign(new Error('监督信号未确认接收'), { code: 'WATCHDOG_SIGNAL_NOT_ACCEPTED' });
        await store.update(state => {
          const current = state.signals.find(item => item.id === row.id);
          if (current?.state === 'pending') Object.assign(current, { state: 'accepted', deliveredAt: iso(now()), nextAttemptAt: null, lastError: null });
        });
      } catch (error) {
        await store.update(state => {
          const current = state.signals.find(item => item.id === row.id);
          if (current?.state === 'pending') Object.assign(current, { lastError: safeCode(error),
            nextAttemptAt: iso(now() + Math.min(config.backoffMaxMs, config.intervalSeconds * 1000 * 2 ** Math.min(current.attempts - 1, 10))) });
        });
      }
    }));
  }
  async function run(receipt) {
    const before = store.snapshot(), at = now();
    const id = `watchdog-check:${watchdogDigest([receipt.scheduleId, receipt.scheduledAt])}`;
    const previous = before.checks.find(row => row.id === id);
    if (previous && !['running', 'interrupted', 'failed'].includes(previous.status)) return previous;
    if (before.checks.some(row => Date.parse(row.scheduledAt) > Date.parse(receipt.scheduledAt))) return { status: 'superseded', id };
    const check = { id, scheduleId: receipt.scheduleId, scheduledAt: receipt.scheduledAt, deliveredAt: receipt.deliveredAt,
      messageId: receipt.messageId, startedAt: iso(at), completedAt: null, status: 'running', attempt: (previous?.attempt || 0) + 1,
      configRevision: before.configRevision, outcome: 'unknown', model: judge ? 'not-needed' : 'unconfigured' };
    await store.update(state => {
      state.checks = state.checks.filter(row => row.id !== id).concat(check).slice(-config.retentionChecks);
    });
    try {
      const maintenance = config.paused || !config.enabled || config.maintenanceUntil && Date.parse(config.maintenanceUntil) > at;
      if (maintenance || before.nextProbeAt && Date.parse(before.nextProbeAt) > at) {
        Object.assign(check, { status: 'completed', outcome: maintenance ? 'maintenance' : 'backoff', completedAt: iso(now()) });
      } else {
        let envelope, probeError;
        try {
          const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(config.probeTimeoutMs)]);
          envelope = await bounded(() => client.readFacts({ signal }), signal);
          if (envelope?.targetId !== config.targetId) throw Object.assign(new Error('监督目标身份不匹配'), { code: 'WATCHDOG_TARGET_MISMATCH' });
        } catch (error) { probeError = error; }
        shutdown.signal.throwIfAborted();
        if (probeError) {
          const identity = /IDENTITY|TARGET_MISMATCH/.test(probeError.code || '');
          const finding = { key: identity ? identityKey : networkKey, kind: 'host', reasonCode: identity ? 'TARGET_IDENTITY_MISMATCH' : 'TARGET_UNREACHABLE',
            summary: identity ? '监督接口返回的目标身份不可核实' : '主系统监督接口暂不可达，执行状态未知', evidenceCursor: null };
          await store.update(state => {
            state.probeFailures++;
            state.nextProbeAt = iso(now() + Math.min(config.backoffMaxMs, config.intervalSeconds * 1000 * 2 ** Math.min(state.probeFailures - 1, 10)));
            reconcileIncidents(state, { findings: [finding] }, check, config, iso(now()));
          });
          Object.assign(check, { status: 'completed', outcome: 'unreachable', code: safeCode(probeError), findings: [finding.reasonCode], completedAt: iso(now()) });
        } else {
          const facts = envelope.facts;
          if (!facts || typeof facts !== 'object' || !Array.isArray(facts.executions)) throw Object.assign(new Error('监督执行事实不可用'), { code: 'WATCHDOG_FACTS_INVALID' });
          const inspection = inspectWatchdogFacts({ facts, previous: before.candidates, config, now: now() });
          const findings = [...inspection.findings], degraded = judge ? [] : ['MODEL_JUDGE_UNCONFIGURED'];
          const judgments = [];
          // Commit deterministic observations before any auxiliary operation.
          await store.update(state => {
            state.probeFailures = 0; state.nextProbeAt = null; state.candidates = inspection.candidates;
            reconcileIncidents(state, { findings, resolvedKeys: [...(inspection.resolvedKeys || []), networkKey, identityKey] }, check, config, iso(now()));
          });
          const modelResolved = [];
          if (inspection.complete) for (const incident of before.incidents.filter(row => row.active && row.kind === 'model')) {
            const row = facts.executions.find(item => item.ticket?.id === incident.execution.ticketId);
            if (row && (row.run?.id !== incident.execution.runId || row.assignment?.fence !== incident.execution.fence
              || row.ticket?.instructionRevision !== incident.execution.instructionRevision
              || ['completed', 'failed', 'closed', 'cancelled'].includes(row.ticket?.status)
              || ['completed', 'failed', 'cancelled'].includes(row.run?.state)
              || ['user', 'approval', 'paused'].includes(row.wait?.kind)
              || ['background-job', 'long-operation'].includes(row.wait?.kind) && Date.parse(row.wait.expectedUntil) > now()
              || row.modelEvidence?.outputObservation?.comparison?.netChanged === true)) modelResolved.push(incident.conditionKey);
          }
          const judgeSignal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(config.probeTimeoutMs)]);
          let judged = 0;
          if (judge) for (const execution of facts.executions.slice(0, 1000)) {
            const relevant = findings.filter(row => row.execution?.runId === execution.run?.id && judgeCodes[row.reasonCode]);
            const candidate = unchangedFileCandidate(execution, facts, config, now());
            if (candidate) relevant.push(candidate); // A candidate alone never creates an incident or sends a signal.
            if (!relevant.length) continue;
            if (judgeSignal.aborted || judged >= 4) { degraded.push('MODEL_JUDGE_DEFERRED'); break; }
            judged++;
            const evidence = { ticketId: execution.ticket.id, runId: execution.run.id, instructionRevision: execution.ticket.instructionRevision,
              watermark: facts.currentCursor ?? facts.cursor, observationStartedAt: relevant[0].firstObservedAt,
              anomalies: relevant.map(row => row.reasonCode === 'OBSERVED_FILES_UNCHANGED' ? 'no-output-change' : judgeCodes[row.reasonCode]),
              observedAt: facts.observedAt, modelEvidence: execution.modelEvidence,
              waiting: { kind: execution.wait?.kind || 'unknown', active: !['none', 'unknown'].includes(execution.wait?.kind),
                ...(execution.wait?.expectedUntil ? { until: execution.wait.expectedUntil } : {}) }, facts: execution };
            try {
              const result = await bounded(() => judge({ evidence, signal: judgeSignal }), judgeSignal);
              judgments.push({ runId: execution.run.id, status: result.status, classification: result.classification,
                signalEligible: result.signalEligible === true, evidenceWatermark: result.evidenceWatermark ?? null, code: result.code ?? null });
              if (result.status === 'degraded') degraded.push('MODEL_JUDGE_UNAVAILABLE');
              if (result.signalEligible && ['no-progress', 'off-target'].includes(result.classification)) {
                const base = relevant[0];
                findings.push({ ...base, key: `model:${base.key}:${result.classification}`, kind: 'model',
                  reasonCode: result.classification === 'no-progress' ? 'MODEL_NO_PROGRESS' : 'MODEL_OFF_TARGET',
                  summary: `辅助判断：${String(result.reason || '证据不足').slice(0, 300)}` });
              }
            } catch { degraded.push('MODEL_JUDGE_UNAVAILABLE'); judgments.push({ runId: execution.run.id, status: 'degraded' }); }
          }
          await store.update(state => {
            state.probeFailures = 0; state.nextProbeAt = null; state.candidates = inspection.candidates;
            state.degraded = [...new Set(degraded)];
            reconcileIncidents(state, { findings, resolvedKeys: modelResolved }, check, config, iso(now()));
          });
          Object.assign(check, { status: 'completed', outcome: findings.length ? 'fault'
            : inspection.complete && !inspection.coverage.unknown.length ? 'observed' : 'unknown',
            findings: findings.map(row => row.reasonCode), coverage: inspection.coverage, evidenceCursor: facts.currentCursor ?? facts.cursor ?? null,
            bootId: typeof facts.bootId === 'string' ? facts.bootId : null, model: judge ? degraded.length ? 'degraded' : 'available' : 'unconfigured', judgments, completedAt: iso(now()) });
          await deliver();
        }
      }
    } catch (error) {
      Object.assign(check, { status: shutdown.signal.aborted ? 'interrupted' : 'failed', outcome: 'unknown', completedAt: shutdown.signal.aborted ? null : iso(now()), code: safeCode(error) });
    }
    await store.update(state => {
      const index = state.checks.findIndex(row => row.id === id);
      if (index >= 0) state.checks[index] = check;
      if (check.status === 'completed') state.lastCheckAt = check.completedAt;
    });
    return check;
  }
  return {
    check(receipt) {
      if (shutdown.signal.aborted) return Promise.resolve({ status: 'stopped' });
      const state = store.snapshot();
      if (receipt?.scheduleId !== state.scheduleId || receipt.targetSessionId !== state.sessionId
        || typeof receipt.messageId !== 'string' || !Number.isFinite(Date.parse(receipt.scheduledAt)) || !Number.isFinite(Date.parse(receipt.deliveredAt))) {
        return Promise.reject(Object.assign(new Error('监督检查缺少正式 Schedule 投递凭据'), { code: 'WATCHDOG_RECEIPT_INVALID' }));
      }
      if (!queued || Date.parse(receipt.scheduledAt) >= Date.parse(queued.scheduledAt)) queued = clone(receipt);
      return pending ||= (async () => {
        let result;
        while (queued && !shutdown.signal.aborted) { const next = queued; queued = undefined; result = await run(next); }
        return result;
      })().finally(() => { pending = undefined; });
    },
    readLog({ limit = 10 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('监督日志条数须为 1–50');
      const state = store.snapshot();
      return { targetId: state.targetId, configRevision: state.configRevision, sessionId: state.sessionId, scheduleId: state.scheduleId,
        lastCheckAt: state.lastCheckAt, nextProbeAt: state.nextProbeAt, degraded: state.degraded,
        checks: state.checks.slice(-limit), incidents: state.incidents.filter(row => row.active).concat(state.incidents.filter(row => !row.active).slice(-limit)),
        pendingSignals: state.signals.filter(row => row.state === 'pending').length,
        deliveries: state.signals.slice(-limit).map(({ id, incidentKey, phase, state, attempts, nextAttemptAt, deliveredAt, lastError }) =>
          ({ id, incidentKey, phase, state, attempts, nextAttemptAt, deliveredAt, lastError })) };
    },
    async stop() { shutdown.abort(); queued = undefined; await pending?.catch(() => {}); },
  };
}
