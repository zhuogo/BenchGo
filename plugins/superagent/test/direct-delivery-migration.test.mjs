import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';

for (const delivered of [false, true]) test(`old content Review schema is retired once and history retained (delivered=${delivered})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-review-retirement-'));
  let database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database?.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = database.createTicket({ id: 'ticket', threadId: 'thread', target: 'legacy task', mandate: { source: { channel: 'desktop', sessionId: 'owner' }, actorId: 'desktop-owner' } });
  database.createAssignment(ticket.id, { id: 'legacy' });
  const saved = database.commitResult(ticket.id, { result: { summary: 'historical body', review: { verdict: delivered ? 'passed' : 'wait' }, evidenceRefs: ['session:old'] },
    uniqueKey: 'old-result', outboxPayload: { type: 'ticket.result', ticketId: ticket.id, source: ticket.mandate.source, instructionRevision: 1, resultVersion: 1,
      publication: { action: 'deliver', text: 'old Router publication' }, text: 'old Router publication' } });
  const filename = database.path;
  database.close();
  const raw = new DatabaseSync(filename);
  raw.exec("ALTER TABLE sa_tickets ADD COLUMN review_retry TEXT; DELETE FROM sa_migrations WHERE id='worker-direct-delivery-v1';");
  raw.prepare('UPDATE sa_tickets SET status=?,review_retry=? WHERE id=?').run(delivered ? 'completed' : 'waiting', '{"attempts":5}', ticket.id);
  raw.prepare('UPDATE sa_assignments SET state=?,payload=? WHERE id=?').run('queued', JSON.stringify({ instructionRevision: 1, reviewContinuation: { runId: 'old-run' } }), 'legacy');
  if (delivered) {
    raw.prepare("UPDATE sa_outbox SET state='sent' WHERE id=?").run(saved.outbox.id);
    raw.prepare('INSERT INTO sa_delivery_receipts VALUES (?,?)').run(saved.outbox.id, JSON.stringify({ status: 'accepted', messageId: 'old-confirmed' }));
  } else raw.prepare('INSERT INTO sa_attentions(id,assignment_id,ticket_id,session_id,question_key,question,outbox_id,answer_trigger_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run('old-question', 'legacy', ticket.id, 'old-session',
    JSON.stringify(['old-session', 'review:1', 'question', 'review', 1, 1, 'old-run', 'information']), JSON.stringify({ id: 'question', question: 'old semantic acceptance question' }), saved.outbox.id, null, new Date().toISOString());
  const history = raw.prepare('SELECT payload FROM sa_results WHERE ticket_id=?').get(ticket.id).payload;
  raw.close();
  database = createAssistantOrchestrationStore({ filename });
  assert.equal(database.getTicket(ticket.id).status, delivered ? 'completed' : 'waiting');
  assert.equal(database.getAssignment('legacy').state, 'cancelled');
  assert.equal(database.getAssignment('legacy').reviewContinuation, undefined);
  assert.equal(database.getAssignment('legacy').retiredExecution.code, 'LEGACY_CONTENT_REVIEW_RETIRED');
  assert.deepEqual(database.claimAssignments('new-worker', { validateMandate: () => true }), []);
  assert.equal(database.deliveries(ticket.id)[0].state, delivered ? 'sent' : 'cancelled');
  assert.deepEqual(database.attentions(ticket.id), []);
  for (const method of ['deferReview', 'queueReviewContinuation', 'queueAnsweredReviewContinuation', 'openReviewAttention', 'answeredAttentionForReview']) assert.equal(database[method], undefined);
  const inspection = new DatabaseSync(filename);
  assert.equal(inspection.prepare('SELECT payload FROM sa_results WHERE ticket_id=?').get(ticket.id).payload, history);
  assert(!inspection.prepare('PRAGMA table_info(sa_tickets)').all().some(row => row.name === 'review_retry'));
  inspection.close();
  database.close();
  database = createAssistantOrchestrationStore({ filename });
  assert.equal(database.results(ticket.id).length, 1);
  assert.deepEqual(database.claimAssignments('after-restart', { validateMandate: () => true }), []);
});
