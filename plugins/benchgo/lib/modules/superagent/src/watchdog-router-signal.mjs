import { createHash } from 'node:crypto';
import { validateWatchdogSignal } from './watchdog-observation-route.mjs';
import { ticketPaused } from './ticket-lifecycle.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const phases = { opened: 0, escalated: 1, resolved: 2 };
const passiveReasons = new Set(['EXECUTION_INACTIVE', 'LEASE_EXPIRED', 'REQUEST_DEADLINE_EXCEEDED']);
const terminal = new Set(['cancelled', 'completed', 'failed', 'closed']);

export const watchdogIncidentIdentity = signal => signal?.kind === 'watchdog'
  ? JSON.stringify([signal.observation.targetId, signal.observation.incidentKey]) : null;
export const watchdogSignalIdentity = signal => JSON.stringify({
  kind: signal.kind, eventKey: signal.eventKey, source: signal.source, observation: signal.observation,
});
export const watchdogNotificationIdentity = signal => JSON.stringify({ eventKey: signal.eventKey, source: signal.source,
  execution: signal.observation.execution, kind: signal.observation.kind, reasonCode: signal.observation.reasonCode });

/** The principal is supplied by the authenticated route closure, never by wire JSON. */
export function watchdogRouterSignal(database, observation, principal) {
  if (!principal || principal.kind !== 'watchdog' || principal.targetId !== observation?.targetId
    || Object.keys(principal).some(key => !['kind', 'targetId'].includes(key))) {
    throw Object.assign(new Error('Watchdog 信号缺少已认证机器来源'), { code: 'WATCHDOG_PRINCIPAL_REQUIRED' });
  }
  observation = validateWatchdogSignal(observation, principal.targetId);
  if (observation.kind === 'host' && observation.execution)
    throw Object.assign(new Error('Watchdog 观察类别与身份不一致'), { code: 'WATCHDOG_SIGNAL_INVALID' });
  const ticket = observation.execution && database.getTicket(observation.execution.ticketId);
  return { kind: 'watchdog', eventKey: `watchdog:${hash([observation.targetId, observation.incidentKey, observation.phase])}`,
    ...(observation.execution ? { ticketId: observation.execution.ticketId,
      instructionRevision: observation.execution.instructionRevision } : {}),
    source: structuredClone(ticket?.mandate?.source || { channel: 'watchdog', targetId: principal.targetId, threadId: 'main' }),
    observation };
}

/** A newer incident phase retires only its older notices, never execution state. */
export function watchdogNoticeCurrent(signal, requests) {
  const incident = watchdogIncidentIdentity(signal);
  return !requests.some(row => !row.suppressed && watchdogIncidentIdentity(row.ticketReply) === incident
    && phases[row.ticketReply.observation.phase] > phases[signal.observation.phase]);
}

/** Re-read the shared execution projection at admission, dispatch, tools and publication. */
export function inspectWatchdogRouterSignal(database, signal, snapshot, { now = Date.now() } = {}) {
  const observation = signal?.observation, identity = observation?.execution;
  const invalid = reason => ({ valid: false, reason });
  if (signal?.kind !== 'watchdog' || !snapshot || !Number.isSafeInteger(snapshot.currentCursor ?? snapshot.cursor))
    return invalid('execution-facts-unavailable');
  if (observation.evidenceCursor !== null && observation.evidenceCursor > (snapshot.currentCursor ?? snapshot.cursor))
    return invalid('evidence-watermark-unavailable');
  if (!identity) {
    if (signal.source.channel !== 'watchdog' || signal.source.targetId !== observation.targetId || signal.source.threadId !== 'main')
      return invalid('machine-source-changed');
    // Successful authenticated delivery already proves reachability. The external
    // observer sends a resolved summary after reconnecting; do not replay an old alarm.
    if (observation.phase !== 'resolved' && ['TARGET_UNREACHABLE', 'TARGET_IDENTITY_MISMATCH'].includes(observation.reasonCode))
      return invalid('target-interface-reachable');
    if (observation.reasonCode === 'FACTS_STALE' && observation.phase !== 'resolved') return invalid('current-facts-available');
    if (observation.reasonCode === 'SCHEDULER_STALLED') return invalid('scheduler-condition-not-verifiable');
    return { valid: true, facts: { interfaceReachable: true, observedAt: snapshot.observedAt } };
  }
  const ticket = database.getTicket(identity.ticketId), assignment = database.getAssignment(identity.assignmentId);
  const run = assignment && database.runs(assignment.id).find(row => row.id === identity.runId);
  if (!ticket || !assignment || !run || assignment.ticketId !== ticket.id
    || ticket.instructionRevision !== identity.instructionRevision || (run.instructionRevision ?? assignment.instructionRevision ?? 1) !== identity.instructionRevision
    || assignment.fence !== identity.fence || run.fence !== identity.fence || run.sessionId !== identity.sessionId
    || JSON.stringify(ticket.mandate.source) !== JSON.stringify(signal.source)) return invalid('execution-identity-changed');
  const facts = snapshot.executions?.find(row => row.ticket?.id === ticket.id && row.assignment?.id === assignment.id
    && row.assignment.fence === identity.fence && row.run?.id === run.id && row.run.sessionId === identity.sessionId
    && row.ticket.instructionRevision === identity.instructionRevision && row.run.instructionRevision === identity.instructionRevision);
  if (!facts || observation.evidenceCursor === null) return invalid('execution-evidence-unavailable');
  const ended = ticket.status === 'completed' || ticket.executionControl?.stopped || terminal.has(run.state);
  if (observation.phase !== 'resolved') {
    if (passiveReasons.has(observation.reasonCode) && (facts.wait?.kind !== 'none' || ended
      || ticketPaused(ticket) || ticket.status === 'waiting')) return invalid('execution-waiting-or-closed');
    if (observation.reasonCode === 'EXECUTION_INACTIVE' && !(assignment.state === 'claimed'
      && ['submitted', 'running'].includes(run.state) && facts.executionAlive?.status === 'absent')) return invalid('execution-active-or-unknown');
    if (observation.reasonCode === 'LEASE_EXPIRED' && !(assignment.state === 'claimed' && assignment.leaseUntil <= now)) return invalid('lease-not-expired');
    if (observation.reasonCode === 'REQUEST_DEADLINE_EXCEEDED' && !(facts.request?.state === 'inflight'
      && facts.request.deadline && Date.parse(facts.request.deadline) <= now)) return invalid('request-deadline-not-exceeded');
    if (observation.reasonCode === 'STOP_UNCONFIRMED' && facts.stop?.confirmationOverdue !== true) return invalid('stop-not-overdue');
  } else if (observation.kind === 'execution') {
    const waiting = ['user', 'approval', 'paused'].includes(facts.wait?.kind) || ticketPaused(ticket)
      || ['background-job', 'long-operation'].includes(facts.wait?.kind) && Date.parse(facts.wait.expectedUntil) > now;
    const cleared = ended || observation.reasonCode === 'EXECUTION_INACTIVE' && (waiting || assignment.state !== 'claimed'
      || !['submitted', 'running'].includes(run.state) || ['running', 'idle'].includes(facts.executionAlive?.status))
      || observation.reasonCode === 'LEASE_EXPIRED' && (waiting || assignment.state !== 'claimed' || assignment.leaseUntil > now)
      || observation.reasonCode === 'REQUEST_DEADLINE_EXCEEDED' && (waiting || facts.request?.state === 'settled'
        || facts.request?.state === 'inflight' && Date.parse(facts.request.deadline) > now)
      || observation.reasonCode === 'STOP_UNCONFIRMED' && facts.stop?.confirmationOverdue === false;
    if (!cleared) return invalid('recovery-observation-not-current');
  }
  return { valid: true, facts: structuredClone(facts) };
}
