import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { createTaskManagement } from '../src/task-management.mjs';
import { createDesktopTaskAccess } from '../src/desktop-task-access.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-task-read-pages-'));
  const database = createAssistantOrchestrationStore({ directory });
  const runtime = createAssistantRuntimeStore({ directory });
  const sql = new DatabaseSync(join(directory, 'assistant.db'));
  t.after(async () => { sql.close(); runtime.close(); database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'tasks', source: { type: 'desktop', id: 'owner' } });
  const management = createTaskManagement({ database: runtime, orchestration: database });
  const access = createDesktopTaskAccess(database, management);
  const task = (id, values = {}) => database.createTask({ id, threadId: 'tasks', target: `要求 ${id}`, acceptance: '',
    mandate: { source: { channel: 'desktop', sessionId: 'owner', threadId: 'main' } }, ...values });
  return { database, sql, access, management, task };
}

test('literal keywords, source, creation bounds and ownership intersect before pagination', async t => {
  const f = await fixture(t);
  const make = (id, channel, sessionId, createdAt, target, extra = {}) => f.task(id, { target, createdAt,
    mandate: { source: { channel, sessionId, threadId: 'main', token: 'must-not-leak' }, ...extra } });
  make('older', 'desktop', 'owner', '2026-11-01T00:00:00Z', 'deployment 50%_ready');
  make('selected-a', 'desktop', 'owner', '2026-11-02T00:00:00Z', 'deployment 50%_ready');
  make('wrong-channel', 'feishu', 'owner', '2026-11-02T01:00:00Z', 'deployment 50%_ready');
  make('wrong-owner', 'desktop', 'other', '2026-11-02T02:00:00Z', 'deployment 50%_ready');
  make('wrong-keyword', 'desktop', 'owner', '2026-11-02T03:00:00Z', 'deployment 50Zready');
  make('selected-b', 'desktop', 'owner', '2026-11-02T04:00:00Z', 'deployment 50%_ready');
  make('exclusive-end', 'desktop', 'owner', '2026-11-03T00:00:00Z', 'deployment 50%_ready');
  const filter = { query: '50%_READY', channel: 'desktop', sessionId: 'owner',
    createdAfter: '2026-11-02T08:00:00+08:00', createdBefore: '2026-11-03T00:00:00Z', limit: 1 };
  const first = f.access.query('owner', filter);
  const second = f.access.query('owner', { ...filter, offset: first.nextOffset });
  assert.deepEqual([...first.tasks, ...second.tasks].map(row => row.id), ['selected-b', 'selected-a']);
  assert.equal(second.nextOffset, null);
  assert.deepEqual(first.tasks[0].source, { channel: 'desktop', sessionId: 'owner', threadId: 'main' });
  assert.equal(JSON.stringify(first).includes('must-not-leak'), false);
  assert.deepEqual(f.access.query('owner', { ...filter, sessionId: 'other' }).tasks, []);
  for (const invalid of [{ query: ' ' }, { createdAfter: 'yesterday' }, { createdBefore: '2026-11-02' }, { createdAfter: '2026-02-30T00:00:00Z' },
    { createdAfter: '2026-11-03T00:00:00Z', createdBefore: '2026-11-02T00:00:00Z' }]) assert.throws(() => f.access.query('owner', invalid));
});

test('keyword lookup includes current renamed display title and full requirement/acceptance', async t => {
  const f = await fixture(t);
  f.task('renamed', { target: '原始部署要求', acceptance: '验收使用 Opaque/Model:ID' });
  f.management.update({ kind: 'task', id: 'renamed', operation: 'rename', title: '发布检查', version: 0 });
  assert.deepEqual(f.access.query('owner', { query: '发布检查', limit: 1 }).tasks.map(row => row.id), ['renamed']);
  assert.equal(f.access.query('owner', { query: '原始部署' }).tasks[0].id, 'renamed');
  assert.equal(f.access.query('owner', { query: 'Opaque/Model:ID' }).tasks[0].id, 'renamed');
});

test('overview is bounded and explicit record sections page in SQL without calling full-history readers', async t => {
  const f = await fixture(t);
  f.task('long', { target: '要求'.repeat(9000), acceptance: '验收'.repeat(9000) });
  const payloads = [];
  for (let version = 1; version <= 25; version++) {
    const payload = { taskId: 'long', version, instructionRevision: 1, summary: `结果 ${version}：${'正文'.repeat(8000)}` };
    payloads.push(payload);
    f.sql.prepare('INSERT INTO sa_results(task_id,version,payload,created_at) VALUES (?,?,?,?)')
      .run('long', version, JSON.stringify(payload), '2026-11-01T00:00:00Z');
    f.sql.prepare('INSERT INTO sa_task_revisions(task_id,revision,operation,snapshot,created_at) VALUES (?,?,?,?,?)')
      .run('long', version, 'revise', JSON.stringify({ target: `要求 ${version}`, acceptance: '', mandate: { source: { channel: 'desktop', sessionId: 'owner', threadId: 'main' } } }), '2026-11-01T00:00:00Z');
  }
  for (const name of ['taskRevisions', 'assignments', 'runs', 'results', 'attentions', 'deliveries'])
    f.database[name] = () => { throw Error(`overview/section must not call unbounded ${name}`); };
  const overview = f.access.read('long', 'owner');
  assert.equal(overview.textTruncated, true);
  assert.equal(overview.target.length, 1000);
  assert.equal(overview.results.length, 1);
  assert.equal(overview.results[0].identity, 'result:25');
  assert.equal(overview.results[0].truncated, true);
  assert.equal(overview.revisions.length, 0);
  assert(JSON.stringify(overview).length < 8000);
  const revisions = [];
  let offset = 0;
  do {
    const page = f.access.read('long', 'owner', { section: 'revisions', offset, limit: 4, textLimit: 12000 });
    revisions.push(...page.records.map(row => row.value.instructionRevision));
    offset = page.pagination.nextOffset;
  } while (offset !== null);
  assert.deepEqual(revisions, Array.from({ length: 25 }, (_, i) => 25 - i));
  let page = f.access.read('long', 'owner', { section: 'results', limit: 1, textLimit: 511 });
  const fragments = [page.records[0].text];
  let next = page.records[0].nextRead;
  while (next) {
    page = f.access.read('long', 'owner', next);
    assert.equal(page.records[0].identity, 'result:25');
    fragments.push(page.records[0].text);
    next = page.records[0].nextRead;
  }
  assert.deepEqual(JSON.parse(fragments.join('')), payloads.at(-1));
  const requirements = f.access.read('long', 'owner', { section: 'requirements', limit: 1, textLimit: 12000 });
  assert.equal(requirements.records[0].identity, overview.sections.find(row => row.section === 'requirements').recordId);
  assert.equal(requirements.records[0].truncated, true);
  f.database.updateTask('long', { target: '要求已经改变' });
  assert.throws(() => f.access.read('long', 'owner', requirements.records[0].nextRead), { code: 'TASK_READ_CONFLICT' });
});

test('fragment continuation uses stable record identity even after a newer result is appended', async t => {
  const f = await fixture(t);
  f.task('one');
  const saved = { version: 1, summary: '稳定正文'.repeat(300) };
  f.sql.prepare('INSERT INTO sa_results VALUES (?,?,?,?)').run('one', 1, JSON.stringify(saved), '2026-11-01T00:00:00Z');
  const first = f.access.read('one', 'owner', { section: 'results', limit: 1, textLimit: 200 });
  f.sql.prepare('INSERT INTO sa_results VALUES (?,?,?,?)').run('one', 2, JSON.stringify({ version: 2, summary: '新的结果' }), '2026-11-02T00:00:00Z');
  const continued = f.access.read('one', 'owner', first.records[0].nextRead);
  assert.equal(continued.records[0].identity, 'result:1');
  assert.equal(continued.records[0].text, JSON.stringify(saved).slice(200, 400));
  f.sql.prepare('UPDATE sa_results SET payload=? WHERE task_id=? AND version=1').run(JSON.stringify({ ...saved, summary: '原记录已更新'.repeat(300) }), 'one');
  assert.throws(() => f.access.read('one', 'owner', first.records[0].nextRead), { code: 'TASK_READ_CONFLICT' });
  assert.throws(() => f.access.read('one', 'other', { section: 'results' }), /当前会话/);
  assert.throws(() => f.access.read('one', 'owner', { textLimit: 12001 }), /textLimit/);
  assert.throws(() => f.access.read('one', 'owner', { section: 'results', textOffset: 1, limit: 1 }), /recordId/);
});

test('assignments, runs, unanswered questions and deliveries share bounded independent evidence pages', async t => {
  const f = await fixture(t); f.task('evidence');
  const assignment = f.database.createAssignment('evidence', { text: '执行要求' });
  const at = '2026-11-01T00:00:00Z';
  f.sql.prepare('INSERT INTO sa_runs(id,assignment_id,fence,owner,state,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('run-evidence', assignment.id, 0, 'worker', 'waiting', JSON.stringify({ sessionId: 'execution', evidence: { summary: '等待当前问题答复' } }), at, at);
  f.sql.prepare('INSERT INTO sa_outbox(id,unique_key,task_id,payload,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('delivery-evidence', 'evidence-question', 'evidence', JSON.stringify({ type: 'question' }), 'queued', at, at);
  const question = { id: 'question-key', question: '请确认正式发布范围', options: [{ label: '仅测试环境' }, { label: '生产环境' }] };
  f.sql.prepare('INSERT INTO sa_attentions(id,assignment_id,task_id,session_id,question_key,question,outbox_id,created_at,instruction_revision) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('attention-evidence', assignment.id, 'evidence', 'execution', JSON.stringify(['execution', 'question-call']), JSON.stringify(question), 'delivery-evidence', at, 1);
  const overview = f.access.read('evidence', 'owner');
  assert.deepEqual(overview.attentions[0].value.question, question);
  for (const [section, identity] of [['assignments', assignment.id], ['runs', 'run-evidence'], ['attentions', 'attention-evidence'], ['deliveries', 'delivery-evidence']]) {
    const page = f.access.read('evidence', 'owner', { section, limit: 1 });
    assert.equal(page.records[0].identity, identity);
    assert.equal(page.records[0].value.id, identity);
    assert.equal(page.pagination.nextOffset, null);
  }
  assert.equal(f.access.read('evidence', 'owner', { section: 'assignments', limit: 1 }).records[0].value.runs, undefined,
    'Runs have a separate page rather than an unbounded nested fetch');
});
