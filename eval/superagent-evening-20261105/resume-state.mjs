import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export async function inspectRetainedState(directory, scenario) {
  const expected = scenario.pauseBefore || scenario.beforeAnswer;
  assert.ok(expected?.ticketId && scenario.threadId && scenario.routerSessionId, 'Original ticket and conversation identity missing');
  const run = expected.run || (expected.runs?.length === 1 && expected.runs[0]);
  assert.ok(run?.id && run.assignmentId && run.sessionId, 'Unique original Run identity missing');
  assert.deepEqual(expected.assignmentIds, [run.assignmentId], 'Original Assignment identity is ambiguous');
  const db = new DatabaseSync(join(directory, 'user/.benchgo/assistant/assistant.db'), { readOnly: true });
  try {
    const tickets = db.prepare('SELECT id,thread_id,status,instruction_revision,mandate FROM sa_tickets').all();
    assert.equal(tickets.length, 1, 'Expected exactly one retained Ticket');
    assert.equal(tickets[0].id, expected.ticketId);
    assert.equal(tickets[0].thread_id, `desktop:${scenario.routerSessionId}`);
    const source = JSON.parse(tickets[0].mandate).source;
    assert.equal(source?.channel, 'desktop');
    assert.equal(source.sessionId, scenario.routerSessionId);
    assert.equal(source.threadId, scenario.threadId);
    assert.equal(tickets[0].instruction_revision, expected.instructionRevision);
    assert.equal(tickets[0].status, 'paused', 'Only explicitly paused Tickets can be resumed');
    const assignments = db.prepare('SELECT id FROM sa_assignments WHERE ticket_id=?').all(expected.ticketId);
    assert.deepEqual(assignments.map(row => row.id), [run.assignmentId]);
    const runs = db.prepare('SELECT id,assignment_id,payload FROM sa_runs WHERE assignment_id=?').all(run.assignmentId);
    assert.equal(runs.length, 1, 'Expected exactly one original Run');
    assert.equal(runs[0].id, run.id);
    assert.equal(JSON.parse(runs[0].payload).sessionId, run.sessionId);
    const files = await readdir(join(directory, 'user/.dsh/sessions'), { recursive: true });
    for (const id of [run.sessionId, scenario.routerSessionId]) {
      assert.match(id, /^[a-f0-9-]{36}$/u);
      assert.ok(files.some(path => basename(dirname(path)) === id && /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/u.test(basename(path))), 'Original session file missing');
    }
    await readFile(join(directory, 'user/.dsh/profiles/web/cordis.patch.yml'));
    return { ticketId: expected.ticketId, threadId: scenario.threadId, routerSessionId: scenario.routerSessionId,
      assignmentId: run.assignmentId, runId: run.id, sessionId: run.sessionId, instructionRevision: expected.instructionRevision };
  } finally { db.close(); }
}
