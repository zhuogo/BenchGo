import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { inspectRetainedState } from './resume-state.mjs';

test('recovery requires the same paused ticket, assignment, run and session files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-resume-test-'));
  const sessionId = '11111111-1111-1111-1111-111111111111', routerSessionId = '22222222-2222-2222-2222-222222222222';
  try {
    await mkdir(join(directory, 'user/.benchgo/assistant'), { recursive: true });
    await mkdir(join(directory, 'user/.dsh/sessions'), { recursive: true });
    await mkdir(join(directory, 'user/.dsh/profiles/web'), { recursive: true });
    for (const id of [sessionId, routerSessionId]) {
      await mkdir(join(directory, 'user/.dsh/sessions/--project--', id), { recursive: true });
      await writeFile(join(directory, 'user/.dsh/sessions/--project--', id, 'session.v3.jsonl.zstd'), '');
    }
    await writeFile(join(directory, 'user/.dsh/profiles/web/cordis.patch.yml'), '[]');
    const db = new DatabaseSync(join(directory, 'user/.benchgo/assistant/assistant.db'));
    db.exec("CREATE TABLE sa_tickets(id TEXT,thread_id TEXT,status TEXT,instruction_revision INTEGER,mandate TEXT); CREATE TABLE sa_assignments(id TEXT,ticket_id TEXT); CREATE TABLE sa_runs(id TEXT,assignment_id TEXT,payload TEXT); INSERT INTO sa_assignments VALUES('a','t');");
    db.prepare('INSERT INTO sa_tickets VALUES(?,?,?,?,?)').run('t', `desktop:${routerSessionId}`, 'paused', 1, JSON.stringify({ source: { channel: 'desktop', sessionId: routerSessionId, threadId: 'thread' } }));
    db.prepare('INSERT INTO sa_runs VALUES(?,?,?)').run('r', 'a', JSON.stringify({ sessionId }));
    const scenario = { threadId: 'thread', routerSessionId, pauseBefore: { ticketId: 't', instructionRevision: 1, assignmentIds: ['a'], run: { id: 'r', assignmentId: 'a', sessionId } } };
    assert.equal((await inspectRetainedState(directory, scenario)).runId, 'r');
    db.prepare('UPDATE sa_tickets SET mandate=?').run(JSON.stringify({ source: { channel: 'desktop', sessionId: routerSessionId, threadId: 'other' } }));
    await assert.rejects(inspectRetainedState(directory, scenario));
    db.prepare('UPDATE sa_tickets SET mandate=?').run(JSON.stringify({ source: { channel: 'desktop', sessionId: routerSessionId, threadId: 'thread' } }));
    db.exec("UPDATE sa_tickets SET status='waiting'");
    await assert.rejects(inspectRetainedState(directory, scenario), /paused/);
    db.exec("UPDATE sa_tickets SET status='paused'; INSERT INTO sa_runs VALUES('r2','a','{}')");
    await assert.rejects(inspectRetainedState(directory, scenario), /one original Run/);
    db.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
