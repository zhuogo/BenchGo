const fail = (code, message) => Object.assign(new Error(message), { code });

/** Owned Worker self-check evidence, independent of the model routing policy. */
export function installWorkerExecutionStore({ db, tx, api }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_worker_self_check_state(
    run_id TEXT PRIMARY KEY REFERENCES sa_runs(id), self_check TEXT, updated_at TEXT NOT NULL)`);
  const state = runId => {
    const row = db.prepare('SELECT self_check FROM sa_worker_self_check_state WHERE run_id=?').get(runId);
    return row ? { selfCheck: row.self_check ? JSON.parse(row.self_check) : null } : null;
  };
  return {
    getWorkerExecutionState: state,
    recordWorkerSelfCheck(input) {
      return tx(() => {
        const assignment = api.getAssignment(input.assignmentId), run = api.runs(input.assignmentId).find(item => item.id === input.runId);
        if (!assignment || assignment.state !== 'claimed' || assignment.owner !== input.owner || assignment.fence !== input.fence || assignment.leaseUntil <= Date.now()
          || !run || run.owner !== input.owner || run.fence !== input.fence || !['prepared', 'submitted', 'running'].includes(run.state)) throw fail('FENCING_CONFLICT', 'Worker self-check owner changed');
        db.prepare(`INSERT INTO sa_worker_self_check_state(run_id,self_check,updated_at) VALUES (?,?,?)
          ON CONFLICT(run_id) DO UPDATE SET self_check=excluded.self_check,updated_at=excluded.updated_at`)
          .run(input.runId, JSON.stringify(input.value), new Date().toISOString());
        return state(input.runId).selfCheck;
      });
    },
  };
}
