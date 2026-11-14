import { SUPERAGENT_ROLE_PROFILE } from './session-role-assembly.mjs';

const fail = (message) => Object.assign(new Error(message), { code: 'SESSION_ROLE_OWNERSHIP' });
const identityKeys = ['role', 'threadId', 'taskId', 'assignmentId', 'runId', 'parentSessionId'];

/** Host-authenticated ownership and observed configuration, never transcript authority. */
export function installSessionRoleStore({ db, tx, api }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_session_roles(
    session_id TEXT PRIMARY KEY, identity TEXT NOT NULL, expected TEXT NOT NULL,
    status TEXT NOT NULL, actual TEXT, reason TEXT, updated_at TEXT NOT NULL)`);
  // A changed contract invalidates observations, including sessions not resumed yet.
  tx(() => {
    const expected = JSON.stringify(SUPERAGENT_ROLE_PROFILE);
    const reset = db.prepare("UPDATE sa_session_roles SET expected=?,status='pending',actual=NULL,reason=NULL,updated_at=? WHERE session_id=?");
    for (const row of db.prepare("SELECT session_id,expected FROM sa_session_roles WHERE json_extract(identity,'$.role') IN ('router','worker')").all()) {
      if (JSON.stringify(JSON.parse(row.expected)) !== expected) reset.run(expected, new Date().toISOString(), row.session_id);
    }
  });
  const read = sessionId => {
    const row = db.prepare('SELECT * FROM sa_session_roles WHERE session_id=?').get(sessionId);
    return row ? { sessionId, ...JSON.parse(row.identity), expected: JSON.parse(row.expected), status: row.status,
      actual: row.actual ? JSON.parse(row.actual) : null, reason: row.reason ? JSON.parse(row.reason) : null,
      updatedAt: row.updated_at } : null;
  };
  return {
    getSessionRole: read,
    listSessionRoles: () => db.prepare('SELECT session_id,identity FROM sa_session_roles ORDER BY rowid').all()
      .map(row => ({ sessionId: row.session_id, ...JSON.parse(row.identity) })),
    bindSessionRole(input) {
      return tx(() => {
        if (!input.sessionId || !['router', 'worker', 'child-worker'].includes(input.role)) throw fail('Invalid owned session role');
        if (input.role === 'router') {
          if (!input.threadId || input.runId || input.parentSessionId) throw fail('Invalid Router ownership');
        } else {
          const assignment = api.getAssignment(input.assignmentId), run = assignment && api.runs(assignment.id).find(row => row.id === input.runId);
          if (!run || assignment.taskId !== input.taskId) throw fail('Worker Run ownership is unavailable');
          if (input.role === 'worker' && run.sessionId !== input.sessionId) throw fail('Worker session differs from its Run');
          if (input.role === 'child-worker') {
            const parent = read(input.parentSessionId);
            if (!parent || !['worker', 'child-worker'].includes(parent.role) || parent.runId !== input.runId
              || parent.assignmentId !== input.assignmentId || parent.taskId !== input.taskId) throw fail('Child has no persisted Worker ancestry');
          }
        }
        const identity = Object.fromEntries(identityKeys.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
        const prior = read(input.sessionId);
        if (prior) {
          if (identityKeys.some(key => prior[key] !== identity[key])) throw fail('Session ownership cannot be reassigned');
          if (JSON.stringify(prior.expected) !== JSON.stringify(input.expected)) {
            db.prepare("UPDATE sa_session_roles SET expected=?,status='pending',actual=NULL,reason=NULL,updated_at=? WHERE session_id=?")
              .run(JSON.stringify(input.expected), new Date().toISOString(), input.sessionId);
            return read(input.sessionId);
          }
          return prior;
        }
        db.prepare('INSERT INTO sa_session_roles VALUES (?,?,?,?,?,?,?)').run(input.sessionId, JSON.stringify(identity), JSON.stringify(input.expected), 'pending', null, null, new Date().toISOString());
        return read(input.sessionId);
      });
    },
    recordSessionRole(sessionId, { status, actual, reason = null }) {
      const prior = read(sessionId);
      if (!prior || !['ready', 'blocked'].includes(status)) throw fail('Unknown owned session or observation status');
      if (prior.status === status && JSON.stringify(prior.actual) === JSON.stringify(actual || null)
        && JSON.stringify(prior.reason) === JSON.stringify(reason)) return prior;
      db.prepare('UPDATE sa_session_roles SET status=?,actual=?,reason=?,updated_at=? WHERE session_id=?')
        .run(status, actual ? JSON.stringify(actual) : null, reason ? JSON.stringify(reason) : null, new Date().toISOString(), sessionId);
      return read(sessionId);
    },
  };
}
