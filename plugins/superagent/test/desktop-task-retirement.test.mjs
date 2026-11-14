import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createDesktopDelegationService } from '../src/desktop-delegation-service.mjs';

const retiredTable = 'sa_desktop_scope_checks';

test('a new desktop store exposes only direct admission and never creates the retired review table', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-review-retirement-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = createAssistantOrchestrationStore({ directory });
  for (const name of ['desktopTriggerTask', 'desktopScopeCheck', 'desktopScopeAttempts', 'recordDesktopScopeCheck']) {
    assert.equal(database[name], undefined);
  }
  assert.equal(typeof database.acceptDesktop, 'function');
  database.close();
  const sql = new DatabaseSync(join(directory, 'assistant.db'));
  try {
    assert.equal(sql.prepare('SELECT count(*) AS count FROM sqlite_master WHERE type=? AND name=?').get('table', retiredTable).count, 0);
  } finally { sql.close(); }
});

test('a persisted review refusal is inert after restart and its evidence remains unchanged', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-review-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let database = createAssistantOrchestrationStore({ directory });
  const sessionId = 'owner-session', messageId = 'retry-message', requestId = 'retry-request';
  const original = '再来一次呗';
  const source = { channel: 'desktop', sessionId, messageId, threadId: 'main' };
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const { trigger } = database.ingest({ dedupeKey: `desktop-message:${digest([sessionId, messageId])}`,
    thread: { id: `desktop:${sessionId}`, source: { type: 'desktop', id: sessionId } },
    source, actor: { kind: 'human', id: 'desktop-owner' }, content: original, mode: 'direct' });
  database.close();

  const filename = join(directory, 'assistant.db');
  const legacy = new DatabaseSync(filename);
  let expected;
  try {
    legacy.exec(`CREATE TABLE ${retiredTable}(
      request_key TEXT NOT NULL, binding_hash TEXT NOT NULL, request_hash TEXT NOT NULL,
      trigger_id TEXT NOT NULL REFERENCES sa_triggers(id), attempt INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(request_key,binding_hash,attempt))`);
    legacy.prepare(`INSERT INTO ${retiredTable} VALUES (?,?,?,?,?,?,?)`).run(JSON.stringify([sessionId, requestId]),
      'historical-binding', 'historical-request', trigger.id, 1,
      JSON.stringify({ decision: { outcome: 'unconfirmed', reason: '历史复审未确认上下文' }, failureCode: 'TIMEOUT' }),
      '2026-11-11T00:00:00.000Z');
    expected = legacy.prepare(`SELECT * FROM ${retiredTable}`).all();
  } finally { legacy.close(); }

  database = createAssistantOrchestrationStore({ directory });
  try {
    const events = [{ type: 'turn/start' }, { type: 'user/message', data: {
      id: messageId, source: { kind: 'user' }, content: [{ type: 'text', text: original }],
    } }];
    const agent = { id: sessionId, status: 'running', session: { header: {}, snapshotEvents: () => events } };
    let modelRequests = 0;
    const ctx = {
      agents: { get: () => agent, currentInitiator: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) },
      llm: { resolveModelInfo: async (provider, id) => ({ provider, id }), stream() {
        modelRequests++; throw Error('Direct admission must not request any model review');
      } },
    };
    const policy = { desktopVersion: 'current-policy', projects: [], workerModels: [{ providerId: 'literal-provider', modelId: 'literal-model' }] };
    const service = createDesktopDelegationService({ ctx, database, readPolicy: async () => policy });
    const input = { requestId, title: '香港服务器巡检', text: '重新检查香港服务器的负载与磁盘状态', acceptance: '报告真实只读检查结果' };
    const task = await service.delegate(input, { agent }, { ownerAgent: agent, threadId: 'main' });
    assert.equal(task.mandate.instruction, original);
    assert.equal(task.mandate.scopeCheck, undefined);
    assert.equal(task.mandate.controlledActions, 'require-current-policy-and-harness-approval');
    assert.equal((await service.delegate(input, { agent }, { ownerAgent: agent, threadId: 'main' })).id, task.id);
    assert.equal(database.listTasks().length, 1);
    assert.equal(database.assignments(task.id).length, 1);
    assert.equal(modelRequests, 0);
  } finally { database.close(); }

  const reopened = new DatabaseSync(filename);
  try { assert.deepEqual(reopened.prepare(`SELECT * FROM ${retiredTable}`).all(), expected); }
  finally { reopened.close(); }
});
