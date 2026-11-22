import { createHash, randomUUID } from 'node:crypto';
import { migrateRemoteExecutionOwnership } from './remote-execution-migration.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const identity = value => typeof value === 'string' && value.trim() && value.length <= 512;
const canonical = value => JSON.stringify(value, (_key, item) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const phases = new Set(['prepared', 'submitted', 'running', 'verifying', 'waiting', 'paused', 'completed', 'failed', 'cancelled', 'uncertain']);
const terminal = new Set(['completed', 'failed', 'cancelled']);
const keys = ['runId', 'executionId', 'sessionId', 'deviceId', 'hostId', 'authorizationId'];
const limitOf = (value, fallback = 100) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, 200) : fallback;
const validTime = now => { if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid remote execution time'); return new Date(now).toISOString(); };

/** A database belongs to one business host for its complete lifetime. */
export function initializeOwnerHostId(db, requested) {
  if (requested !== undefined && !identity(requested)) throw new TypeError('Invalid owner host identity');
  db.prepare('INSERT OR IGNORE INTO task_meta(key,value) VALUES (?,?)')
    .run('owner-host-id', JSON.stringify(requested ?? randomUUID()));
  const saved = JSON.parse(db.prepare('SELECT value FROM task_meta WHERE key=?').get('owner-host-id').value);
  if (!identity(saved) || requested !== undefined && requested !== saved)
    throw fail('OWNER_HOST_CONFLICT', 'Business task storage is bound to another host');
  return saved;
}

/** Remote facts belong to the authoritative Assignment, never a parallel task ledger. */
export function installRemoteExecutionStore({ db, tx, api, ownedAssignment }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_remote_execution_state(
    assignment_id TEXT PRIMARY KEY REFERENCES sa_assignments(id),
    run_id TEXT NOT NULL UNIQUE REFERENCES sa_runs(id), fence INTEGER NOT NULL,
    execution_id TEXT NOT NULL UNIQUE, cursor INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL, next_at INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sa_remote_execution_due ON sa_remote_execution_state(next_at,assignment_id);
    CREATE UNIQUE INDEX IF NOT EXISTS sa_remote_execution_session ON sa_remote_execution_state(json_extract(payload,'$.sessionId'));
    CREATE INDEX IF NOT EXISTS sa_remote_assignment_observation ON sa_assignments(state,lease_until,id)
      WHERE json_extract(payload,'$.executor')='remote';
    CREATE TABLE IF NOT EXISTS sa_remote_execution_commands(
    request_id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES sa_assignments(id), fence INTEGER NOT NULL,
    operation TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
    state TEXT NOT NULL, receipt TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sa_remote_command_assignment ON sa_remote_execution_commands(assignment_id,state,created_at,request_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS sa_remote_command_order ON sa_remote_execution_commands(assignment_id);
    CREATE UNIQUE INDEX IF NOT EXISTS sa_remote_command_submit ON sa_remote_execution_commands(assignment_id) WHERE operation='submit';`);
  const remoteByAssignment = db.prepare('SELECT * FROM sa_remote_execution_state WHERE assignment_id=?');
  const row = assignmentId => remoteByAssignment.get(assignmentId);
  const value = item => item && { ...JSON.parse(item.payload), assignmentId: item.assignment_id,
    runId: item.run_id, executionId: item.execution_id, fence: item.fence, cursor: item.cursor,
    phase: item.phase, nextAt: item.next_at, createdAt: item.created_at, updatedAt: item.updated_at };
  const command = item => item && { requestId: item.request_id, assignmentId: item.assignment_id, fence: item.fence,
    operation: item.operation, payload: JSON.parse(item.payload), state: item.state,
    receipt: item.receipt ? JSON.parse(item.receipt) : null, createdAt: item.created_at, updatedAt: item.updated_at };
  const owned = (assignmentId, owner, fence, now) => {
    const assignment = ownedAssignment(assignmentId, owner, fence, now);
    if (JSON.parse(assignment.payload).executor !== 'remote') throw fail('REMOTE_EXECUTION_CONFLICT', 'Assignment does not use a remote executor');
    return assignment;
  };
  const save = (assignmentId, { owner, fence, patch, now }) => {
    const at = validTime(now), assignment = owned(assignmentId, owner, fence, now);
    if (!object(patch)) throw new TypeError('Remote execution requires a fact patch');
    const previous = value(row(assignmentId));
    const next = { ...previous, ...structuredClone(patch) };
    if (keys.some(key => !identity(next[key])) || previous && keys.some(key => next[key] !== previous[key]))
      throw fail('REMOTE_EXECUTION_CONFLICT', 'Remote execution identity is immutable');
    const run = db.prepare('SELECT * FROM sa_runs WHERE id=? AND assignment_id=? AND fence=?').get(next.runId, assignmentId, fence);
    const execution = JSON.parse(assignment.payload).execution;
    if (!run || run.owner !== owner || JSON.parse(run.payload).sessionId !== next.sessionId
      || !execution || ['deviceId', 'hostId', 'authorizationId'].some(key => execution[key] !== next[key])
      || previous && previous.fence !== fence)
      throw fail('REMOTE_EXECUTION_CONFLICT', 'Remote binding must match its frozen Assignment and Run');
    next.phase ??= 'prepared'; next.cursor ??= 0; next.nextAt ??= 0;
    if (!phases.has(next.phase) || !Number.isSafeInteger(next.cursor) || next.cursor < (previous?.cursor ?? 0)
      || !Number.isSafeInteger(next.nextAt) || next.nextAt < 0
      || previous && terminal.has(previous.phase) && previous.phase !== next.phase)
      throw fail('REMOTE_OBSERVATION_CONFLICT', 'Remote execution observation is stale or invalid');
    for (const key of ['assignmentId', 'fence', 'cursor', 'phase', 'nextAt', 'createdAt', 'updatedAt']) delete next[key];
    db.prepare(`INSERT INTO sa_remote_execution_state(assignment_id,run_id,fence,execution_id,cursor,phase,next_at,payload,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(assignment_id) DO UPDATE SET cursor=excluded.cursor,phase=excluded.phase,
      next_at=excluded.next_at,payload=excluded.payload,updated_at=excluded.updated_at`)
      .run(assignmentId, next.runId, fence, next.executionId, patch.cursor ?? previous?.cursor ?? 0,
        patch.phase ?? previous?.phase ?? 'prepared', patch.nextAt ?? previous?.nextAt ?? 0, JSON.stringify(next), at, at);
    return value(row(assignmentId));
  };
  migrateRemoteExecutionOwnership({ db, tx });
  return {
    remoteExecution: assignmentId => value(row(assignmentId)),
    remoteArchiveDevices() {
      return db.prepare(`SELECT DISTINCT json_extract(payload,'$.deviceId') AS deviceId,
        json_extract(payload,'$.hostId') AS hostId,json_extract(payload,'$.authorizationId') AS authorizationId,
        json_extract(payload,'$.protocolVersion') AS protocolVersion FROM sa_remote_execution_state`).all();
    },
    detachRemoteStopInTransaction(assignment, now) {
      const remote = value(row(assignment.id));
      if (!remote || remote.fence !== assignment.fence) return false;
      const at = validTime(now);
      if (!terminal.has(remote.phase)) {
        const prior = db.prepare("SELECT request_id FROM sa_remote_execution_commands WHERE assignment_id=? AND fence=? AND operation='cancel' ORDER BY rowid DESC LIMIT 1")
          .get(assignment.id, assignment.fence);
        if (!prior) {
          const requestId = digest([remote.executionId, 'cancel', 'stop-and-archive']);
          const payload = { requestId };
          db.prepare("INSERT INTO sa_remote_execution_commands VALUES (?,?,?,?,?,?,'pending',NULL,?,?)")
            .run(requestId, assignment.id, assignment.fence, 'cancel', digest([assignment.id, assignment.fence, 'cancel', payload]), JSON.stringify(payload), at, at);
        }
        db.prepare("UPDATE sa_remote_execution_state SET phase='cancelled',next_at=?,updated_at=? WHERE assignment_id=?").run(now, at, assignment.id);
      }
      db.prepare("UPDATE sa_runs SET state='cancelled',updated_at=? WHERE id=? AND fence=? AND state NOT IN ('completed','failed','cancelled')")
        .run(at, remote.runId, assignment.fence);
      return true;
    },
    pendingDetachedRemoteStops({ now, limit }) {
      return db.prepare(`SELECT c.* FROM sa_remote_execution_commands c
        JOIN sa_assignments a ON a.id=c.assignment_id AND a.fence=c.fence
        JOIN sa_remote_execution_state e ON e.assignment_id=a.id AND e.fence=a.fence
        WHERE c.operation='cancel' AND c.state='pending' AND a.state='cancelled' AND e.phase='cancelled'
          AND json_extract(a.payload,'$.remoteStopDetached')=1 AND e.next_at<=?
        ORDER BY e.next_at,c.request_id LIMIT ?`).all(now, limitOf(limit)).map(command);
    },
    finishDetachedRemoteStop(entry, { now, nextAt, receipt } = {}) {
      const at = validTime(now);
      return tx(() => {
        const prior = db.prepare("SELECT * FROM sa_remote_execution_commands WHERE request_id=? AND assignment_id=? AND fence=? AND operation='cancel' AND state='pending'")
          .get(entry.requestId, entry.assignmentId, entry.fence);
        if (!prior) return;
        if (receipt) db.prepare("UPDATE sa_remote_execution_commands SET state='receipted',receipt=?,updated_at=? WHERE request_id=?")
          .run(JSON.stringify(receipt), at, entry.requestId);
        else db.prepare('UPDATE sa_remote_execution_state SET next_at=?,updated_at=? WHERE assignment_id=? AND fence=?')
          .run(nextAt, at, entry.assignmentId, entry.fence);
      });
    },
    remoteExecutionBySession(sessionId) {
      if (!identity(sessionId)) throw new TypeError('Invalid remote session identity');
      return value(db.prepare("SELECT * FROM sa_remote_execution_state WHERE json_extract(payload,'$.sessionId')=?").get(sessionId));
    },
    recordRemoteExecution(assignmentId, { owner, fence, patch, now = Date.now() } = {}) {
      return tx(() => save(assignmentId, { owner, fence, patch, now }));
    },
    remoteExecutionCandidates({ now = Date.now(), limit = 20 } = {}) {
      validTime(now);
      return db.prepare(`SELECT e.assignment_id FROM sa_assignments a INDEXED BY sa_remote_assignment_observation
        JOIN sa_remote_execution_state e ON e.assignment_id=a.id
        WHERE json_extract(a.payload,'$.executor')='remote' AND a.state IN ('claimed','uncertain') AND e.next_at<=?
        AND e.fence=a.fence AND (a.state='uncertain' OR (a.state='claimed' AND a.lease_until<=?))
        ORDER BY e.next_at,e.assignment_id LIMIT ?`).all(now, now, limitOf(limit, 20)).map(item => {
          const assignment = api.getAssignment(item.assignment_id), remote = value(row(item.assignment_id));
          return { assignment, remote, run: api.runs(assignment.id).find(run => run.id === remote.runId) };
        });
    },
    claimRemoteAssignment(assignmentId, { owner, fence, leaseMs = 60000, now = Date.now() } = {}) {
      if (!identity(owner) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new TypeError('Invalid remote observation lease');
      const at = validTime(now);
      return tx(() => {
        const remote = value(row(assignmentId)), assignment = db.prepare('SELECT * FROM sa_assignments WHERE id=?').get(assignmentId);
        if (!remote || !assignment || remote.fence !== fence || assignment.fence !== fence
          || !['claimed', 'uncertain'].includes(assignment.state)
          || assignment.state === 'claimed' && assignment.lease_until > now)
          throw fail('FENCING_CONFLICT', 'Remote execution already has a current observer');
        db.prepare("UPDATE sa_assignments SET state='claimed',owner=?,lease_until=?,updated_at=? WHERE id=?")
          .run(owner, now + leaseMs, at, assignmentId);
        db.prepare('UPDATE sa_runs SET owner=?,updated_at=? WHERE id=? AND fence=?').run(owner, at, remote.runId, fence);
        return api.getAssignment(assignmentId);
      });
    },
    /** Extends the lease its current observer still holds. A lapsed or lost lease is never revived here. */
    renewRemoteObservation(assignmentId, { owner, fence, leaseMs = 60000, now = Date.now() } = {}) {
      if (!identity(owner) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new TypeError('Invalid remote observation lease');
      const at = validTime(now);
      return tx(() => {
        owned(assignmentId, owner, fence, now);
        db.prepare('UPDATE sa_assignments SET lease_until=?,updated_at=? WHERE id=? AND lease_until<?').run(now + leaseMs, at, assignmentId, now + leaseMs);
        return api.getAssignment(assignmentId);
      });
    },
    /** One observed page is one transaction: the store calls made inside join it and commit or roll back together. */
    observeRemotePage(apply) { return tx(apply); },
    parkRemoteAssignment(assignmentId, { owner, fence, phase, nextAt, now = Date.now() } = {}) {
      return tx(() => {
        const previous = value(row(assignmentId));
        if (!previous) throw fail('REMOTE_EXECUTION_CONFLICT', 'Remote execution binding is missing');
        save(assignmentId, { owner, fence, patch: { ...(phase ? { phase } : {}), nextAt: nextAt ?? now }, now });
        db.prepare("UPDATE sa_assignments SET state='uncertain',owner=NULL,lease_until=NULL,updated_at=? WHERE id=?")
          .run(validTime(now), assignmentId);
        return api.getAssignment(assignmentId);
      });
    },
    /** Only an authenticated observation of the exact original execution may restore a Run. */
    observeRemoteRun(assignmentId, { owner, fence, executionId, sessionId, cursor, state, evidence, now = Date.now() } = {}) {
      return tx(() => {
        owned(assignmentId, owner, fence, now);
        const remote = value(row(assignmentId)), at = validTime(now);
        if (!remote || remote.executionId !== executionId || remote.sessionId !== sessionId
          || !Number.isSafeInteger(cursor) || cursor < remote.cursor || !phases.has(state)
          || !object(evidence)) throw fail('REMOTE_OBSERVATION_CONFLICT', 'Observation must identify the original execution and monotonic cursor');
        const run = db.prepare('SELECT * FROM sa_runs WHERE id=?').get(remote.runId);
        const payload = JSON.parse(run.payload);
        const nextState = state === 'paused' || state === 'waiting' ? 'verifying' : state;
        const continuation = ['paused', 'waiting'].includes(remote.phase) && state === 'running'
          && cursor > (remote.observedCursor ?? remote.cursor);
        const order = { prepared: 0, submitted: 1, running: 2, verifying: 3, completed: 4, failed: 4, cancelled: 4 };
        if (run.owner !== owner || run.fence !== fence || terminal.has(run.state) && nextState !== run.state
          || run.state !== 'uncertain' && nextState !== 'uncertain' && order[nextState] < order[run.state] && !continuation)
          throw fail('RUN_TRANSITION', 'Authenticated observation cannot rewind an execution');
        save(assignmentId, { owner, fence, patch: { phase: state, cursor, observedCursor: cursor, observedAt: at, observed: structuredClone(evidence) }, now });
        db.prepare('UPDATE sa_runs SET state=?,payload=?,updated_at=? WHERE id=?')
          .run(nextState, JSON.stringify({ ...payload, evidence: structuredClone(evidence) }), at, remote.runId);
        return api.runs(assignmentId).find(item => item.id === remote.runId);
      });
    },
    recordRemoteCommand(assignmentId, { owner, fence, requestId, operation, payload = {}, now = Date.now() } = {}) {
      if (!identity(requestId) || !['submit', 'input', 'pause', 'resume', 'cancel'].includes(operation) || !object(payload))
        throw new TypeError('Invalid remote execution command');
      return tx(() => {
        owned(assignmentId, owner, fence, now);
        if (!row(assignmentId)) throw fail('REMOTE_EXECUTION_CONFLICT', 'Remote execution binding is missing');
        const fingerprint = digest([assignmentId, fence, operation, payload]);
        const previous = db.prepare('SELECT * FROM sa_remote_execution_commands WHERE request_id=?').get(requestId);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw fail('IDEMPOTENCY_CONFLICT', 'Remote request identity describes different work');
          return command(previous);
        }
        if (operation === 'submit' && db.prepare("SELECT 1 FROM sa_remote_execution_commands WHERE assignment_id=? AND operation='submit'").get(assignmentId))
          throw fail('REMOTE_SUBMIT_CONFLICT', 'A remote Assignment has exactly one immutable submit command');
        const at = validTime(now);
        db.prepare(`INSERT INTO sa_remote_execution_commands(request_id,assignment_id,fence,operation,fingerprint,payload,state,created_at,updated_at)
          VALUES (?,?,?,?,?,?,'pending',?,?)`).run(requestId, assignmentId, fence, operation, fingerprint, JSON.stringify(payload), at, at);
        return command(db.prepare('SELECT * FROM sa_remote_execution_commands WHERE request_id=?').get(requestId));
      });
    },
    finishRemoteCommand(assignmentId, { owner, fence, requestId, receipt, now = Date.now() } = {}) {
      if (!identity(requestId) || !object(receipt)) throw new TypeError('Remote command requires a durable receipt');
      return tx(() => {
        owned(assignmentId, owner, fence, now);
        const previous = db.prepare('SELECT * FROM sa_remote_execution_commands WHERE request_id=?').get(requestId);
        if (!previous || previous.assignment_id !== assignmentId || previous.fence !== fence)
          throw fail('REMOTE_COMMAND_CONFLICT', 'Command does not belong to this execution');
        if (previous.receipt) {
          if (canonical(JSON.parse(previous.receipt)) !== canonical(receipt))
            throw fail('IDEMPOTENCY_CONFLICT', 'Remote command receipt is immutable');
          return command(previous);
        }
        db.prepare("UPDATE sa_remote_execution_commands SET state='receipted',receipt=?,updated_at=? WHERE request_id=?")
          .run(JSON.stringify(receipt), validTime(now), requestId);
        return command(db.prepare('SELECT * FROM sa_remote_execution_commands WHERE request_id=?').get(requestId));
      });
    },
    acknowledgeRemoteRevision(assignmentId, { owner, fence, runId, executionId, requestId,
      instructionRevision, boundaryId, now = Date.now() } = {}) {
      if (!identity(requestId) || !identity(boundaryId) || !Number.isSafeInteger(instructionRevision) || instructionRevision < 1)
        throw new TypeError('Remote revision acknowledgement requires an exact version and command');
      return tx(() => {
        const assignment = owned(assignmentId, owner, fence, now), remote = value(row(assignmentId));
        const receipt = command(db.prepare('SELECT * FROM sa_remote_execution_commands WHERE request_id=?').get(requestId));
        const payload = JSON.parse(assignment.payload);
        const submitRevision = receipt?.operation === 'submit' && payload.redispatchOfAssignmentId
          && receipt.payload.requirements?.instructionRevision === instructionRevision;
        const inputRevision = receipt?.operation === 'input'
          && receipt.state === 'receipted' && receipt.payload.instructionRevision === instructionRevision
          && receipt.receipt?.instructionRevision === instructionRevision;
        if (!remote || remote.runId !== runId || remote.executionId !== executionId
          || !receipt || receipt.assignmentId !== assignmentId || receipt.fence !== fence
          || (!submitRevision && !inputRevision))
          throw fail('REMOTE_REVISION_CONFLICT', 'Only the exact version acknowledged by the remote executor may be applied');
        const old = db.prepare('SELECT * FROM sa_task_boundaries WHERE assignment_id=? AND boundary_id=?').get(assignmentId, boundaryId);
        if (old) {
          const prior = JSON.parse(old.snapshot);
          if (old.run_id !== runId || prior.instructionRevision !== instructionRevision)
            throw fail('REMOTE_REVISION_CONFLICT', 'Remote execution boundary already has a different version');
          return prior;
        }
        const task = api.getTask(assignment.task_id);
        const saved = db.prepare('SELECT snapshot FROM sa_task_revisions WHERE task_id=? AND revision=?')
          .get(task.id, instructionRevision);
        const source = saved ? JSON.parse(saved.snapshot) : instructionRevision === task.instructionRevision ? task : null;
        if (!source) throw fail('REVISION_SNAPSHOT_MISSING', 'Remote acknowledged requirements snapshot is missing');
        const snapshot = { instructionRevision, authorizationVersion: source.authorizationVersion ?? source.mandate.authorizationVersion ?? 1,
          target: source.target, acceptance: source.acceptance, mandate: structuredClone(source.mandate),
          context: structuredClone(source.context || []), toolScope: structuredClone(source.toolScope ?? source.mandate.scope?.toolNames ?? source.mandate.toolScope ?? null) };
        const previousSnapshot = payload.appliedSnapshot;
        const wholeTask = payload.wholeTaskScope ?? (!payload.text?.trim() || payload.text === (previousSnapshot?.target ?? api.appliedTaskSnapshot(assignmentId).target));
        snapshot.executionScope = wholeTask ? snapshot.target : payload.text;
        const at = validTime(now);
        if ((payload.instructionRevision ?? 1) <= instructionRevision) {
          Object.assign(payload, { instructionRevision, authorizationVersion: snapshot.authorizationVersion,
            wholeTaskScope: wholeTask, text: snapshot.executionScope, acceptance: snapshot.acceptance, appliedSnapshot: snapshot });
          db.prepare('UPDATE sa_assignments SET payload=?,updated_at=? WHERE id=?').run(JSON.stringify(payload), at, assignmentId);
          const run = db.prepare('SELECT payload FROM sa_runs WHERE id=?').get(runId);
          db.prepare('UPDATE sa_runs SET payload=?,updated_at=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(run.payload),
            appliedSnapshot: snapshot, instructionRevision, authorizationVersion: snapshot.authorizationVersion }), at, runId);
        }
        db.prepare('INSERT INTO sa_task_boundaries VALUES (?,?,?,?,?)').run(assignmentId, boundaryId, runId, JSON.stringify(snapshot), at);
        const application = JSON.stringify({ assignmentId, owner, fence, runId, sessionId: remote.sessionId,
          executionId, requestId, boundaryId, instructionRevision, at });
        db.prepare(`UPDATE sa_task_inputs SET state='applied',application=? WHERE task_id=? AND state='pending'
          AND kind IN ('revision','authorization') AND instruction_revision<=?`).run(application, task.id, instructionRevision);
        return snapshot;
      });
    },
    remoteCommand(assignmentId, requestId) {
      if (!identity(assignmentId) || !identity(requestId)) throw new TypeError('Remote command requires exact identities');
      return command(db.prepare('SELECT * FROM sa_remote_execution_commands WHERE request_id=? AND assignment_id=?').get(requestId, assignmentId));
    },
    remoteSubmitCommand(assignmentId) {
      return command(db.prepare("SELECT * FROM sa_remote_execution_commands WHERE assignment_id=? AND operation='submit' LIMIT 1").get(assignmentId));
    },
    remoteControlCommand(assignmentId) {
      return command(db.prepare("SELECT * FROM sa_remote_execution_commands WHERE assignment_id=? AND operation IN ('pause','resume','cancel') ORDER BY rowid DESC LIMIT 1").get(assignmentId));
    },
    remoteCommands(assignmentId, { state, operation, newestFirst = false, limit = 100 } = {}) {
      if (state !== undefined && !['pending', 'receipted'].includes(state)) throw new TypeError('Invalid remote command state');
      if (operation !== undefined && !['submit', 'input', 'pause', 'resume', 'cancel'].includes(operation)) throw new TypeError('Invalid remote command operation');
      return db.prepare(`SELECT * FROM sa_remote_execution_commands WHERE assignment_id=?${state ? ' AND state=?' : ''}${operation ? ' AND operation=?' : ''}
        ORDER BY rowid ${newestFirst ? 'DESC' : 'ASC'} LIMIT ?`)
        .all(assignmentId, ...(state ? [state] : []), ...(operation ? [operation] : []), limitOf(limit)).map(command);
    },
  };
}

/** Reuse the existing display journal and post-commit listeners, without exporting command bodies. */
export function initializeRemoteExecutionFacts(db) {
  for (const table of ['sa_remote_execution_state', 'sa_remote_execution_commands']) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = operation === 'DELETE' ? 'OLD' : 'NEW';
      const remote = table === 'sa_remote_execution_state' ? row
        : `(SELECT run_id FROM sa_remote_execution_state WHERE assignment_id=${row}.assignment_id)`;
      const run = table === 'sa_remote_execution_state' ? `${remote}.run_id` : remote;
      db.exec(`CREATE TRIGGER IF NOT EXISTS sa_execution_fact_${table}_${operation.toLowerCase()}
        AFTER ${operation} ON ${table}
        BEGIN INSERT INTO sa_execution_facts(task_id,assignment_id,run_id,fence,instruction_revision,session_id,source_seq,kind,observed_at,data)
        SELECT a.task_id,${row}.assignment_id,${run},${row}.fence,
          COALESCE(json_extract(r.payload,'$.instructionRevision'),json_extract(a.payload,'$.instructionRevision'),1),
          json_extract(r.payload,'$.sessionId'),NULL,'remote-execution',strftime('%Y-%m-%dT%H:%M:%fZ','now'),json_object('operation','${operation.toLowerCase()}')
        FROM sa_assignments a JOIN sa_runs r ON r.id=${run} WHERE a.id=${row}.assignment_id; END;`);
    }
  }
}
