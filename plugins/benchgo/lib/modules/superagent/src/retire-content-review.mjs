/** One-way retirement. Preserve historical results/evidence; never execute old reviews. */
export function retireContentReview({ db, tx }) {
  db.exec('CREATE TABLE IF NOT EXISTS sa_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  if (db.prepare('SELECT 1 FROM sa_migrations WHERE id=?').get('worker-direct-delivery-v1')) return;
  tx(() => {
    const at = new Date().toISOString();
    for (const row of db.prepare('SELECT * FROM sa_assignments').all()) {
      const payload = JSON.parse(row.payload);
      if (!payload.reviewRepair && !payload.reviewContinuation && !payload.reviewProgress && !payload.verificationOnly) continue;
      const active = ['claimed', 'uncertain'].includes(row.state);
      for (const key of ['reviewRepair', 'reviewContinuation', 'reviewProgress', 'verificationOnly']) delete payload[key];
      payload.retiredExecution = { code: 'LEGACY_CONTENT_REVIEW_RETIRED', at };
      db.prepare('UPDATE sa_assignments SET state=?,payload=?,owner=NULL,lease_until=NULL,updated_at=? WHERE id=?')
        .run(active ? 'uncertain' : 'cancelled', JSON.stringify(payload), at, row.id);
      db.prepare("UPDATE sa_tickets SET status='waiting',continuation_wait=?,updated_at=? WHERE id=? AND status NOT IN ('completed','failed','cancelled','closed')")
        .run(JSON.stringify({ code: 'LEGACY_CONTENT_REVIEW_RETIRED' }), at, row.ticket_id);
    }
    // Old publication decisions cannot become a new Worker result or restart a review.
    db.prepare(`UPDATE sa_outbox SET state='cancelled',owner=NULL,lease_until=NULL,last_error='legacy-content-review-retired',updated_at=?
      WHERE state IN ('queued','claimed') AND (json_extract(payload,'$.type')='ticket.result'
        AND COALESCE(json_extract(payload,'$.publication.origin'),'')!='worker'
        OR id IN (SELECT outbox_id FROM sa_attentions WHERE json_extract(question_key,'$[3]')='review'))`).run(at);
    for (const row of db.prepare("SELECT t.* FROM sa_tickets t WHERE t.status NOT IN ('cancelled','closed') AND EXISTS (SELECT 1 FROM sa_results r WHERE r.ticket_id=t.id AND r.version=t.result_version AND json_type(r.payload,'$.review')='object')").all()) {
      const sent = db.prepare("SELECT 1 FROM sa_outbox WHERE ticket_id=? AND state='sent' AND json_extract(payload,'$.type')='ticket.result' AND json_extract(payload,'$.resultVersion')=?").get(row.id, row.result_version);
      if (sent && ['completed', 'failed'].includes(row.status)) continue;
      db.prepare("UPDATE sa_tickets SET status='waiting',continuation_wait=?,updated_at=? WHERE id=?")
        .run(JSON.stringify({ code: 'LEGACY_CONTENT_REVIEW_RETIRED', sourceResultVersion: row.result_version }), at, row.id);
    }
    const columns = db.prepare('PRAGMA table_info(sa_tickets)').all();
    if (columns.some(row => row.name === 'review_retry')) db.exec('ALTER TABLE sa_tickets DROP COLUMN review_retry');
    db.prepare('INSERT INTO sa_migrations VALUES (?,?)').run('worker-direct-delivery-v1', at);
  });
}
