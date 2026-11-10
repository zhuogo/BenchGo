/** Historical business states are converted once; execution evidence is immutable. */
export function migrateTicketStates({ db, tx }) {
  if (!db.prepare('PRAGMA table_info(sa_tickets)').all().some(row => row.name === 'execution_control')) db.exec("ALTER TABLE sa_tickets ADD COLUMN execution_control TEXT NOT NULL DEFAULT '{}'");
  db.exec('CREATE TABLE IF NOT EXISTS sa_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  if (db.prepare('SELECT 1 FROM sa_migrations WHERE id=?').get('ticket-three-states-v1')) return;
  tx(() => {
    for (const row of db.prepare('SELECT * FROM sa_tickets').all()) {
      const control = JSON.parse(row.execution_control || '{}');
      let status = row.status === 'completed' ? 'completed' : 'waiting';
      if (['open', 'assigned', 'running'].includes(row.status)) status = db.prepare("SELECT 1 FROM sa_assignments WHERE ticket_id=? AND state='claimed'").get(row.id) ? 'running' : 'waiting';
      if (row.status === 'pausing') control.pauseRequested = true;
      if (row.status === 'paused') control.paused = true;
      if (row.status === 'cancelling') control.stopRequested = true;
      if (['cancelled', 'closed'].includes(row.status)) control.stopped = true;
      let wait = row.continuation_wait;
      if (!['open', 'assigned', 'running', 'waiting', 'completed', 'pausing', 'paused', 'cancelling', 'cancelled', 'closed', 'failed'].includes(row.status)) wait ||= JSON.stringify({ code: 'LEGACY_STATE_UNVERIFIED', reason: '历史执行状态需要核实后继续', sourceResultVersion: row.result_version });
      if (row.status === 'failed') {
        const saved = db.prepare('SELECT payload FROM sa_results WHERE ticket_id=? AND version=?').get(row.id, row.result_version);
        const result = saved ? JSON.parse(saved.payload) : {};
        wait = JSON.stringify({ code: 'EXECUTION_FAILED', sourceResultVersion: row.result_version,
          reason: String(result.failure?.cause || result.summary || '执行未完成，等待调整条件').slice(0, 600),
          resumeConditions: String(result.failure?.resumeConditions || '请明确补充继续要求').slice(0, 600) });
        db.prepare("UPDATE sa_subscriptions SET state='active' WHERE ticket_id=?").run(row.id);
      }
      db.prepare('UPDATE sa_tickets SET status=?,execution_control=?,continuation_wait=? WHERE id=?').run(status, JSON.stringify(control), wait, row.id);
    }
    db.prepare('INSERT INTO sa_migrations VALUES (?,?)').run('ticket-three-states-v1', new Date().toISOString());
  });
}
