import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createExecutionSummaryInput, redactExecutionText } from '../src/execution-summary-input.mjs';
import { installExecutionSummaryStore } from '../src/execution-summary-store.mjs';
import { createExecutionSummaries } from '../src/execution-summary.mjs';
import { createExecutionAuxiliaryRequester } from '../src/execution-summary-request.mjs';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function clock() {
  let now = 0, next = 0; const timers = new Map();
  return { now: () => now, schedule: (fn, delay) => { timers.set(++next, { fn, at: now + delay }); return next; }, cancel: id => timers.delete(id),
    async advance(ms) { now += ms; for (let i = 0; i < 100; i++) { const due = [...timers].find(([, row]) => row.at <= now); if (!due) break; timers.delete(due[0]); due[1].fn(); await flush(); } await flush(); },
  };
}
function harness(extra = {}) {
  const db = new DatabaseSync(':memory:'), c = clock(), listeners = new Set();
  let watermark = 1, status = 'running', revision = 1, runId = 'run-1', executionControl = {};
  const entries = [{ seq: 1, kind: 'turn/start', ticketId: 'ticket', runId, instructionRevision: revision, data: { evidenceRefs: [{ sessionId: 'session', seq: 1 }] } }];
  const store = { ...installExecutionSummaryStore({ db }), getTicket: () => ({ id: 'ticket', target: '修复登录错误 password=hush', acceptance: '测试通过 api_key=private', status, executionControl, instructionRevision: revision }) };
  const facts = { ready: Promise.resolve(), currentCursor: () => watermark, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    page: ({ after, through }) => ({ cursor: through, entries: entries.filter(row => row.seq > after && row.seq <= through) }),
    evidence: () => ({ cursor: watermark, currentCursor: watermark, entries, runtime: { run: { id: runId } },
      projections: [{ ticketId: 'ticket', runId, instructionRevision: revision, complete: true, state: { status, activity: 'working', tools: { calls: 5, results: 4, errors: 0 } } }] }),
  };
  const requests = [];
  const runner = createExecutionSummaries({ executionFacts: facts, store, ...c, config: { mergeMs: 4, maxWaitMs: 12, minIntervalMs: 1, globalMinIntervalMs: 0, ...extra.config },
    requestText: async request => { requests.push(request); return { text: '{"text":"正在定位登录错误，尚待验证","evidenceRefs":[]}' }; }, ...extra });
  return { db, store, facts, requests, runner, c, async event(kind = 'tool/result', changes = {}) {
    ({ status = status, revision = revision, runId = runId, executionControl = executionControl } = changes); watermark++;
    entries.push({ seq: watermark, kind, ticketId: 'ticket', runId, instructionRevision: revision, data: { evidenceRefs: [{ sessionId: 'session', seq: watermark }] } });
    for (const fn of listeners) fn(); await flush();
  }, async close() { await runner.dispose(); db.close(); } };
}

test('model input is a bounded whitelist, including redaction of goal and acceptance', () => {
  const input = createExecutionSummaryInput({ ticketId: 't', runId: 'r', instructionRevision: 2, watermark: 7,
    target: '修复 api_key=TOPSECRET Bearer MYTOKEN https://user:pass@example.test/x?token=secret', acceptance: ['password=HIDDEN 通过'],
    facts: { entries: [{ seq: 7, kind: 'tool/result', ticketId: 't', runId: 'r', instructionRevision: 2,
      data: { output: 'RAW_TOOL_OUTPUT', reasoning: 'PRIVATE_REASONING', args: { secret: 'RAW_TOOL_ARGUMENT' }, evidenceRefs: [{ sessionId: 's', seq: 9 }] } }],
    projections: [{ ticketId: 't', runId: 'r', instructionRevision: 2, complete: true, state: { tools: { calls: 5 } } }] } }, { maxInputCharacters: 2048 });
  assert.doesNotMatch(JSON.stringify(input), /TOPSECRET|MYTOKEN|HIDDEN|user:pass|token=secret|RAW_TOOL|PRIVATE_REASONING/);
  assert.deepEqual(input.evidenceRefs, ['s:9']);
  assert.equal(input.outputObservation, 'unknown');
  assert.equal(input.countsScope, 'session');
  assert.ok(JSON.stringify(input).length <= 2048);
  assert.equal(redactExecutionText('密码：abc'), '密码：[秘密已隐藏]');
});

test('protected artifact observations retain counts and references without paths, hashes or tool payloads', () => {
  const observation = sequence => ({ ticketId: 't', runId: 'r', instructionRevision: 2, fence: 3, seq: sequence + 1,
    kind: 'artifact-observation', data: { sequence, directory: 'C:\\private\\raw-workspace', hash: 'a'.repeat(64), output: 'PRIVATE_OUTPUT',
      startedAt: new Date(sequence * 1000).toISOString(), completedAt: new Date(sequence * 1000 + 900).toISOString(),
      coverage: { kind: 'protected-workspace-files', complete: true, truncated: false, exclusionsVersion: 1 },
      comparison: { beforeFiles: 2, afterFiles: 2, added: 0, deleted: 0, modified: 0, unchanged: 2, netChanged: false } } });
  const original = { ticketId: 't', runId: 'r', instructionRevision: 2, watermark: 10, target: '修改 C:\\private\\file.txt 完成',
    facts: { observedAt: new Date(3000).toISOString(), runtime: { assignment: { fence: 3 }, artifactCoverage: {
      known: true, complete: true, lastSequence: 1 } }, entries: [observation(0), observation(1)], projections: [] } };
  const safe = createExecutionSummaryInput(original);
  assert.equal(safe.outputObservation.coverage.externalEffects, 'not-observed');
  assert.equal(safe.outputObservation.comparison.netChanged, false);
  assert.deepEqual(safe.evidenceRefs, ['execution:1', 'execution:2']);
  assert.doesNotMatch(JSON.stringify(safe), /raw-workspace|private|PRIVATE_OUTPUT|aaaaa/);
  const remote = createExecutionSummaryInput({ ...safe.binding, observedAt: original.facts.observedAt, modelEvidence: safe });
  assert.deepEqual(remote.outputObservation, safe.outputObservation);
  for (const change of [
    value => { value.facts.runtime.artifactCoverage.pending = 1; },
    value => { value.facts.runtime.artifactCoverage.failed = 1; },
    value => { value.facts.runtime.artifactCoverage.restored = true; },
    value => { value.facts.runtime.artifactCoverage.lastSequence = 2; },
    value => { value.facts.entries[1].data.sequence = 3; },
    value => { value.facts.entries[1].fence = 2; },
    value => { value.facts.entries[1].instructionRevision = 1; },
    value => { value.facts.observedAt = new Date(200_000).toISOString(); },
  ]) {
    const value = structuredClone(original); change(value);
    assert.equal(createExecutionSummaryInput(value).outputObservation, 'unknown');
  }
});

test('summary store rejects old runs/revisions/phases/watermarks and preserves audit safely', () => {
  const db = new DatabaseSync(':memory:'), store = installExecutionSummaryStore({ db });
  const b = { ticketId: 't', runId: 'r', instructionRevision: 2, watermark: 8, phase: 'running:none' };
  store.observeExecutionSummary({ ...b, text: '处理中' });
  assert.equal(store.publishExecutionSummary({ ...b, text: '已观察到活动', source: 'model' }).published, true);
  assert.equal(store.publishExecutionSummary({ ...b, watermark: 7, text: '旧摘要' }).published, false);
  store.observeExecutionSummary({ ...b, watermark: 9, phase: 'waiting:paused:none', text: '已暂停' });
  assert.equal(store.publishExecutionSummary({ ...b, text: '迟到摘要' }).published, false);
  store.observeExecutionSummary({ ...b, watermark: 10, instructionRevision: 3, runId: 'r2', text: '新要求' });
  assert.equal(store.publishExecutionSummary({ ...b, watermark: 10, text: '旧运行' }).published, false);
  store.recordAuxiliaryActivity({ ...b, kind: 'summary', status: 'degraded', raw: 'PRIVATE', error: 'PRIVATE', routing: { body: 'PRIVATE' }, code: 'TIMEOUT' });
  assert.doesNotMatch(JSON.stringify(store.auxiliaryActivities()), /PRIVATE/);
  db.close();
});

test('events show deterministic state immediately, coalesce and publish one shared summary', async () => {
  const h = harness(); await h.runner.ready;
  assert.equal(h.runner.current('ticket').source, 'deterministic');
  await h.event(); await h.event(); await h.c.advance(4);
  assert.equal(h.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(h.requests[0].input), /hush|private/);
  assert.equal(h.runner.current('ticket').text, '正在定位登录错误，尚待验证');
  assert.deepEqual(h.store.auxiliaryActivities().entries.map(row => row.status), ['started', 'completed']);
  await h.close();
});

test('continuous events cannot starve max-wait publication and each ticket stays singleflight', async () => {
  const deferred = []; let calls = 0;
  const h = harness({ requestText: () => { calls++; return new Promise(resolve => deferred.push(resolve)); } }); await h.runner.ready;
  for (let i = 0; i < 4; i++) { await h.c.advance(3); await h.event(); }
  assert.equal(calls, 1);
  await h.event(); await h.c.advance(20); assert.equal(calls, 1);
  deferred.shift()({ text: '{"text":"正在核对处理情况","evidenceRefs":[]}' }); await flush();
  assert.equal(h.runner.current('ticket').source, 'model');
  await h.c.advance(1); assert.equal(calls, 2);
  deferred.shift()({ text: '{"text":"继续核对处理情况","evidenceRefs":[]}' }); await flush(); await h.close();
});

test('late model text cannot overwrite a new revision or paused state', async () => {
  let resolve;
  const h = harness({ requestText: () => new Promise(done => { resolve = done; }) }); await h.runner.ready; await h.c.advance(4);
  await h.event('requirements', { revision: 2, status: 'waiting', executionControl: { paused: true } });
  resolve({ text: '{"text":"正在处理旧要求","evidenceRefs":[]}' }); await flush();
  assert.equal(h.runner.current('ticket').text, '任务已暂停，等待恢复');
  assert.equal(h.store.auxiliaryActivities().entries.at(-1).status, 'stale');
  await h.close();
});

test('pause control rejects a late summary while Ticket status and revision stay unchanged', async () => {
  let resolve;
  const h = harness({ requestText: () => new Promise(done => { resolve = done; }) }); await h.runner.ready;
  await h.event('requirements', { status: 'waiting' }); await h.c.advance(4);
  await h.event('requirements', { executionControl: { paused: true } });
  resolve({ text: '{"text":"正在处理旧要求","evidenceRefs":[]}' }); await flush();
  assert.equal(h.runner.current('ticket').text, '任务已暂停，等待恢复');
  assert.equal(h.store.auxiliaryActivities().entries.at(-1).status, 'stale');
  await h.close();
});

test('missing auxiliary role degrades visibly without issuing Router requests', async () => {
  let calls = 0;
  const requestText = createExecutionAuxiliaryRequester({ getConfig: async () => ({ models: [{ providerId: 'router', modelId: 'opaque' }] }), llm: { async *stream() { calls++; } } });
  const h = harness({ requestText }); await h.runner.ready; await h.c.advance(4);
  assert.equal(calls, 0);
  assert.equal(h.runner.current('ticket').source, 'deterministic');
  assert.equal(h.runner.current('ticket').degraded, true);
  assert.equal(h.store.auxiliaryActivities().entries.at(-1).code, 'AUXILIARY_UNCONFIGURED');
  await h.close();
});

test('summary-only journal events do not recursively invoke the model', async () => {
  const h = harness(); await h.runner.ready; await h.c.advance(4); await h.event('summary'); await h.c.advance(100);
  assert.equal(h.requests.length, 1);
  assert.equal(h.store.executionSummaryCursor(), 2);
  await h.close();
});

test('pending coalesced work survives runtime restart after the consumed event cursor', async () => {
  const h = harness(); await h.runner.ready;
  assert.equal(h.store.executionSummaryCursor(), 1);
  await h.runner.dispose();
  assert.equal(h.store.pendingExecutionSummaries().length, 1);
  let calls = 0;
  const runner = createExecutionSummaries({ executionFacts: h.facts, store: h.store, ...h.c, config: { mergeMs: 4 },
    requestText: async () => { calls++; return { text: '{"text":"已恢复核对执行情况","evidenceRefs":[]}' }; } });
  await runner.ready; await h.c.advance(4);
  assert.equal(calls, 1);
  assert.equal(h.store.pendingExecutionSummaries().length, 0);
  await runner.dispose(); await h.close();
});

test('global concurrency and spacing bound independent tickets without dropping their work', async () => {
  const db = new DatabaseSync(':memory:'), c = clock(), pending = [], tickets = ['a', 'b', 'c'];
  const store = { ...installExecutionSummaryStore({ db }), getTicket: id => ({ id, target: '检查情况', status: 'running', instructionRevision: 1 }) };
  const facts = { ready: Promise.resolve(), currentCursor: () => 3, subscribe: () => () => {},
    page: () => ({ cursor: 3, entries: tickets.map(ticketId => ({ ticketId, kind: 'turn/start' })) }),
    evidence: ({ ticketId }) => ({ currentCursor: 3, entries: [], runtime: { run: { id: ticketId } } }),
  };
  const runner = createExecutionSummaries({ executionFacts: facts, store, ...c, config: { mergeMs: 1, globalConcurrency: 2, globalMinIntervalMs: 2 },
    requestText: () => new Promise(resolve => pending.push(resolve)) });
  await runner.ready; await c.advance(1); assert.equal(pending.length, 1);
  await c.advance(2); assert.equal(pending.length, 2);
  await c.advance(10); assert.equal(pending.length, 2);
  pending[0]({ text: '{"text":"正在核对情况","evidenceRefs":[]}' }); await flush(); await c.advance(1);
  assert.equal(pending.length, 3);
  pending[1]({ text: '{"text":"正在核对情况","evidenceRefs":[]}' });
  pending[2]({ text: '{"text":"正在核对情况","evidenceRefs":[]}' }); await flush();
  await runner.dispose(); db.close();
});

test('a stalled adapter is timed out and a prior valid sentence remains visible with degradation', async () => {
  let stall = false;
  const h = harness({ config: { mergeMs: 4, maxWaitMs: 12, minIntervalMs: 1, globalMinIntervalMs: 0, timeoutMs: 5 },
    requestText: () => stall ? new Promise(() => {}) : Promise.resolve({ text: '{"text":"正在定位登录错误","evidenceRefs":[]}' }) });
  await h.runner.ready; await h.c.advance(4); stall = true;
  await h.event(); await h.c.advance(4); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(h.runner.current('ticket').text, '正在定位登录错误');
  assert.equal(h.runner.current('ticket').degraded, true);
  assert.equal(h.store.auxiliaryActivities().entries.at(-1).code, 'TIMEOUT');
  await h.close();
});

test('a failed or stalled fact page yields to the event loop, retries with backoff and stops cleanly', async () => {
  for (const stalled of [false, true]) {
    const db = new DatabaseSync(':memory:'), c = clock(), errors = [];
    let calls = 0;
    const store = installExecutionSummaryStore({ db });
    const facts = { ready: Promise.resolve(), subscribe: () => () => {}, currentCursor: () => 1,
      page: () => { calls++; if (calls === 1) { if (stalled) return { cursor: 0, entries: [] }; throw new Error('temporary read failure'); } return { cursor: 1, entries: [] }; } };
    const runner = createExecutionSummaries({ executionFacts: facts, store, ...c, onError: error => errors.push(error) });
    await runner.ready;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1); assert.equal(errors.length, 1);
    await c.advance(249); assert.equal(calls, 1);
    await c.advance(1); assert.equal(calls, 2); assert.equal(store.executionSummaryCursor(), 1);
    await runner.dispose(); db.close();
  }
  const db = new DatabaseSync(':memory:'), c = clock(); let calls = 0;
  const runner = createExecutionSummaries({ executionFacts: { ready: Promise.resolve(), subscribe: () => () => {}, currentCursor: () => 1,
    page: () => { calls++; throw new Error('offline'); } }, store: installExecutionSummaryStore({ db }), ...c });
  await runner.ready; await runner.dispose(); await c.advance(5000);
  assert.equal(calls, 1); db.close();
});
