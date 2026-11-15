const migrationKey = 'remote-execution-ownership-v1';

/** Retire target-owned business admission once, preserving all original evidence. */
export function migrateRemoteExecutionOwnership({ db, tx }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_remote_execution_migrations(
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);`);
  if (db.prepare('SELECT 1 FROM task_meta WHERE key=?').get(migrationKey)) return;
  tx(() => {
    const at = new Date().toISOString();
    const legacy = db.prepare('SELECT value FROM task_meta WHERE key=?').get('remote-executions');
    if (legacy) {
      db.prepare('INSERT OR IGNORE INTO sa_remote_execution_migrations VALUES (?,?,?,?)')
        .run('legacy-origin-references', 'origin-references', legacy.value, at);
      db.prepare('DELETE FROM task_meta WHERE key=?').run('remote-executions');
    }
    const tasks = db.prepare(`SELECT * FROM sa_tasks WHERE json_extract(mandate,'$.source.channel')='link'
      AND json_extract(mandate,'$.admission')='link-device-delegation'`).all();
    for (const task of tasks) {
      const assignments = db.prepare('SELECT * FROM sa_assignments WHERE task_id=?').all(task.id);
      const runs = db.prepare('SELECT r.* FROM sa_runs r JOIN sa_assignments a ON a.id=r.assignment_id WHERE a.task_id=?').all(task.id);
      const tables = {};
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sa_%'").all()) {
        const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map(row => row.name);
        if (columns.includes('task_id')) tables[name] = db.prepare(`SELECT * FROM "${name}" WHERE task_id=?`).all(task.id);
      }
      db.prepare('INSERT OR IGNORE INTO sa_remote_execution_migrations VALUES (?,?,?,?)')
        .run(`legacy-target:${task.id}`, 'target-task', JSON.stringify({ task, assignments, runs, tables }), at);
      // Unknown work is quarantined, never queued or silently declared stopped.
      db.prepare("UPDATE sa_assignments SET state='blocked',owner=NULL,lease_until=NULL,updated_at=? WHERE task_id=? AND state NOT IN ('completed','failed','cancelled')")
        .run(at, task.id);
      db.prepare("UPDATE sa_runs SET state='uncertain',updated_at=? WHERE assignment_id IN (SELECT id FROM sa_assignments WHERE task_id=?) AND state NOT IN ('completed','failed','cancelled')")
        .run(at, task.id);
      // Old outbound notices must not publish from the executor after ownership
      // retirement. Their original immutable payloads remain in the archive.
      db.prepare("UPDATE sa_outbox SET state='sent',owner=NULL,lease_until=NULL,sent_at=?,updated_at=? WHERE task_id=? AND state!='sent'")
        .run(at, at, task.id);
      for (const row of db.prepare('SELECT version,payload FROM sa_results WHERE task_id=?').all(task.id)) {
        const result = JSON.parse(row.payload);
        if (result.notification?.state === 'pending') db.prepare('UPDATE sa_results SET payload=? WHERE task_id=? AND version=?')
          .run(JSON.stringify({ ...result, notification: { ...result.notification, state: 'suppressed', reason: 'ownership-migration' } }), task.id, row.version);
      }
      if (task.status !== 'completed') db.prepare("UPDATE sa_tasks SET status='waiting',continuation_wait=?,updated_at=? WHERE id=?")
        .run(JSON.stringify({ stage: 'migration', code: 'REMOTE_OWNERSHIP_REQUIRES_VERIFICATION', reason: '旧版跨设备任务等待发起宿主核实迁移，不会自动重派或续跑' }), at, task.id);
    }
    db.prepare('INSERT INTO task_meta(key,value) VALUES (?,?)').run(migrationKey, JSON.stringify({ version: 1, at }));
  });
}
