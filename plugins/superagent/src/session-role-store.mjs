const fail = (message) => Object.assign(new Error(message), { code: 'SESSION_ROLE_OWNERSHIP' });
const identityKeys = ['role', 'threadId', 'ticketId', 'assignmentId', 'runId', 'parentSessionId'];

/** Host-authenticated ownership and observed configuration, never transcript authority. */
export function installSessionRoleStore({ db, tx, api }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_session_roles(
    session_id TEXT PRIMARY KEY, identity TEXT NOT NULL, expected TEXT NOT NULL,
    status TEXT NOT NULL, actual TEXT, reason TEXT, updated_at TEXT NOT NULL)`);
  const read = sessionId => {
    const row = db.prepare('SELECT * FROM sa_session_roles WHERE session_id=?').get(sessionId);
    return row ? { sessionId, ...JSON.parse(row.identity), expected: JSON.parse(row.expected), status: row.status,
      actual: row.actual ? JSON.parse(row.actual) : null, reason: row.reason ? JSON.parse(row.reason) : null,
      updatedAt: row.updated_at } : null;
  };
  return {
    getSessionRole: read,
    bindSessionRole(input) {
      return tx(() => {
        if (!input.sessionId || !['router', 'worker', 'child-worker'].includes(input.role)) throw fail('Invalid owned session role');
        if (input.role === 'router') {
          if (!input.threadId || input.runId || input.parentSessionId) throw fail('Invalid Router ownership');
        } else {
          const assignment = api.getAssignment(input.assignmentId), run = assignment && api.runs(assignment.id).find(row => row.id === input.runId);
          if (!run || assignment.ticketId !== input.ticketId) throw fail('Worker Run ownership is unavailable');
          if (input.role === 'worker' && run.sessionId !== input.sessionId) throw fail('Worker session differs from its Run');
          if (input.role === 'child-worker') {
            const parent = read(input.parentSessionId);
            if (!parent || parent.role !== 'worker' || parent.runId !== input.runId || parent.sessionId !== run.sessionId) throw fail('Child has no persisted direct Worker parent');
          }
        }
        const identity = Object.fromEntries(identityKeys.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
        const prior = read(input.sessionId);
        if (prior) {
          if (identityKeys.some(key => prior[key] !== identity[key])) throw fail('Session ownership cannot be reassigned');
          return prior;
        }
        db.prepare('INSERT INTO sa_session_roles VALUES (?,?,?,?,?,?,?)').run(input.sessionId, JSON.stringify(identity), JSON.stringify(input.expected), 'pending', null, null, new Date().toISOString());
        return read(input.sessionId);
      });
    },
    recordSessionRole(sessionId, { status, actual, reason = null }) {
      if (!read(sessionId) || !['ready', 'blocked'].includes(status)) throw fail('Unknown owned session or observation status');
      db.prepare('UPDATE sa_session_roles SET status=?,actual=?,reason=?,updated_at=? WHERE session_id=?')
        .run(status, actual ? JSON.stringify(actual) : null, reason ? JSON.stringify(reason) : null, new Date().toISOString(), sessionId);
      return read(sessionId);
    },
  };
}
