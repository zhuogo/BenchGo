import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createExecutionSummaryInput, redactExecutionText } from '../src/execution-summary-input.mjs';
import { installExecutionSummaryStore } from '../src/execution-summary-store.mjs';
import { createExecutionSummaries } from '../src/execution-summary.mjs';
import { createExecutionAuxiliaryRequester } from '../src/execution-summary-request.mjs';
import { readExecutionProgressReports } from '../src/execution-summary-source.mjs';

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
  const reports = [];
  const entries = [{ seq: 1, kind: 'turn/start', taskId: 'task', runId, instructionRevision: revision, data: { evidenceRefs: [{ sessionId: 'session', seq: 1 }] } }];
  const store = { ...installExecutionSummaryStore({ db }), getTask: () => ({ id: 'task', target: '修复登录错误 password=hush', acceptance: '测试通过 api_key=private', status, executionControl, instructionRevision: revision }) };
  const facts = { ready: Promise.resolve(), currentCursor: () => watermark, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    page: ({ after, through }) => ({ cursor: through, entries: entries.filter(row => row.seq > after && row.seq <= through) }),
    evidence: () => ({ cursor: watermark, currentCursor: watermark, entries, runtime: { run: { id: runId } },
      projections: [{ taskId: 'task', runId, instructionRevision: revision, sessionId: 'session', cursor: watermark, complete: true, state: { status, activity: 'working', tools: { calls: 5, results: 4, errors: 0 } } }] }),
  };
  const requests = [];
  const runner = createExecutionSummaries({ executionFacts: facts, store, ...c, config: { mergeMs: 4, maxWaitMs: 12, minIntervalMs: 1, globalMinIntervalMs: 0, ...extra.config },
    sessionQuery: { readSurface: async () => ({ session: { id: 'session' }, inheritedEventCount: 0, events: reports }) },
    requestText: async request => { requests.push(request); return { text: JSON.stringify({ text: '正在定位登录错误，尚待验证', evidenceRefs: request.input.progressReports.slice(-1).map(row => row.evidenceRef) }) }; }, ...extra });
  return { db, store, facts, requests, runner, c, async event(kind = 'tool/result', changes = {}) {
    ({ status = status, revision = revision, runId = runId, executionControl = executionControl } = changes); watermark++;
    entries.push({ seq: watermark, kind, taskId: 'task', runId, instructionRevision: revision, data: { evidenceRefs: [{ sessionId: 'session', seq: watermark }] } });
    if (kind === 'assistant/message') reports.push({ seq: watermark, type: kind, time: watermark,
      data: { message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: changes.text || '已定位登录失败来自失效会话，正在修复' }] } } });
    for (const fn of listeners) fn(); await flush();
  }, async close() { await runner.dispose(); db.close(); } };
}

test('model input is a bounded whitelist, including redaction of goal and acceptance', () => {
  const input = createExecutionSummaryInput({ taskId: 't', runId: 'r', instructionRevision: 2, watermark: 7,
    target: '修复 api_key=TOPSECRET Bearer MYTOKEN https://user:pass@example.test/x?token=secret', acceptance: ['password=HIDDEN 通过'],
    facts: { entries: [{ seq: 7, kind: 'tool/result', taskId: 't', runId: 'r', instructionRevision: 2,
      data: { output: 'RAW_TOOL_OUTPUT', reasoning: 'PRIVATE_REASONING', args: { secret: 'RAW_TOOL_ARGUMENT' }, evidenceRefs: [{ sessionId: 's', seq: 9 }] } }],
    projections: [{ taskId: 't', runId: 'r', instructionRevision: 2, complete: true, state: { tools: { calls: 5 } } }] } }, { maxInputCharacters: 2048 });
  assert.doesNotMatch(JSON.stringify(input), /TOPSECRET|MYTOKEN|HIDDEN|user:pass|token=secret|RAW_TOOL|PRIVATE_REASONING/);
  assert.deepEqual(input.evidenceRefs, ['s:9']);
  assert.equal('outputObservation' in input, false);
  assert.equal(input.countsScope, 'session');
  assert.ok(JSON.stringify(input).length <= 2048);
  assert.equal(redactExecutionText('密码：abc'), '密码：[秘密已隐藏]');
  const bounded = createExecutionSummaryInput({ taskId: 't', runId: 'r', instructionRevision: 1, watermark: 20,
    target: '检查服务'.repeat(200), acceptance: Array(8).fill('逐项验收'.repeat(80)),
    progressReports: Array.from({ length: 8 }, (_, index) => ({ evidenceRef: `s:${index + 1}`, text: '正在检查服务'.repeat(250) })),
    facts: { projections: [{ taskId: 't', runId: 'r', instructionRevision: 1, sessionId: 's', cursor: 20 }] } }, { maxInputCharacters: 2048 });
  assert.ok(JSON.stringify(bounded).length <= 2048);
  assert.ok(bounded.progressReports.length > 0);
  for (const report of bounded.progressReports) assert.ok(bounded.evidenceRefs.includes(report.evidenceRef));
});

test('summary store rejects old runs/revisions/phases/watermarks and preserves audit safely', () => {
  const db = new DatabaseSync(':memory:'), store = installExecutionSummaryStore({ db });
  const b = { taskId: 't', runId: 'r', instructionRevision: 2, watermark: 8, phase: 'running:none' };
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

test('events refresh deterministic state without scheduling auxiliary requests', async () => {
  const h = harness(); await h.runner.ready;
  for (let i = 0; i < 20; i++) await h.event();
  await h.c.advance(60000);
  assert.equal(h.requests.length, 0);
  assert.equal(h.runner.current('task').source, 'deterministic');
  assert.equal(h.store.auxiliaryActivities().entries.length, 0);
  assert.equal(h.store.pendingExecutionSummaries().length, 0);
  await h.close();
});

test('fresh public progress automatically coalesces while startup and read-only observations stay quiet', async () => {
  const h = harness(); await h.runner.ready; await h.c.advance(60000);
  assert.equal(h.requests.length, 0);
  for (let i = 0; i < 20; i++) await h.event('assistant/message');
  await h.c.advance(4);
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].input.progressReports.at(-1).text, /失效会话/);
  assert.equal(h.runner.current('task').source, 'model');
  assert.equal(h.runner.current('task').history.length, 1);
  const prior = h.runner.current('task').text;
  await h.event('tool/result'); await h.runner.observe('task'); await h.c.advance(60000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.runner.current('task').text, prior);
  await h.event('turn/end'); await h.c.advance(4);
  assert.equal(h.requests.length, 1, 'unchanged report set is not summarized again');
  await h.close();
});

test('automatic summaries respect the per-task interval and keep the latest pending report', async () => {
  const h = harness({ config: { mergeMs: 4, minIntervalMs: 100, globalMinIntervalMs: 0 } }); await h.runner.ready;
  await h.event('assistant/message'); await h.c.advance(4); assert.equal(h.requests.length, 1);
  await h.event('assistant/message', { text: '已修复登录问题，正在回归测试' }); await h.c.advance(99);
  assert.equal(h.requests.length, 1); await h.c.advance(1); assert.equal(h.requests.length, 2);
  assert.match(h.requests[1].input.progressReports.at(-1).text, /回归测试/);
  assert.equal(h.runner.current('task').history.length, 1, 'identical summaries do not fill the timeline');
  await h.close();
});

test('official public surface reports exclude inherited, interrupted, nested and non-text content', async () => {
  const base = { taskId: 't', runId: 'r', instructionRevision: 1 };
  const message = (seq, content, data = {}) => ({ seq, time: seq, type: 'assistant/message',
    data: { message: { role: 'assistant', source: { kind: 'model' }, content }, ...data } });
  let reads = 0;
  const reports = await readExecutionProgressReports({ ...base, facts: { projections: [{ ...base, sessionId: 's', cursor: 9 }] },
    sessionQuery: { readSurface: async () => { reads++; return { session: { id: 's' }, inheritedEventCount: 2, events: [
      message(1, [{ type: 'text', text: 'INHERITED_PRIVATE' }]),
      message(2, [{ type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'tool-call', arguments: 'PRIVATE_ARGS' },
        { type: 'text', text: '已连接香港服务器 password=PRIVATE_PASSWORD，正在检查磁盘' }]),
      { seq: 3, type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }] } } },
      message(4, [{ type: 'text', text: 'PRIVATE_INTERRUPTED' }], { interrupted: true }),
      message(5, [{ type: 'text', text: 'PRIVATE_NESTED' }], { parentCallId: 'tool' }),
      message(10, [{ type: 'text', text: 'PRIVATE_FUTURE' }]),
    ] }; } } });
  assert.equal(reads, 1); assert.equal(reports.length, 1);
  assert.equal(reports[0].evidenceRef, 's:2'); assert.match(reports[0].text, /香港服务器/);
  assert.doesNotMatch(JSON.stringify(reports), /PRIVATE/);
  const input = createExecutionSummaryInput({ ...base, watermark: 9, progressReports: reports,
    facts: { projections: [{ ...base, sessionId: 's', cursor: 9, state: { activity: '正在执行命令' } }] } });
  assert.equal(input.activity, '正在执行命令'); assert.equal(input.progressReports.length, 1);
  assert.deepEqual(input.evidenceRefs, ['s:2']);
});

test('a busy fact window keeps the references of every supplied public progress report', () => {
  const binding = { taskId: 't', runId: 'r', instructionRevision: 1 };
  const input = createExecutionSummaryInput({ ...binding, watermark: 80,
    progressReports: [{ text: '已连接服务器，正在读取资源占用', evidenceRef: 's:1' }],
    facts: { projections: [{ ...binding, sessionId: 's', cursor: 80 }], entries: Array.from({ length: 80 }, (_, index) => ({
      ...binding, seq: index + 1, kind: 'tool/result', data: { evidenceRefs: [{ sessionId: 's', seq: index + 1 }] },
    })) } });
  assert.equal(input.progressReports.length, 1);
  assert.ok(input.evidenceRefs.includes('s:1'));
  assert.ok(input.evidenceRefs.length <= 24);
});

test('a stuck official surface read releases its summary slot on cancellation', async () => {
  const h = harness({ sessionQuery: { readSurface: () => new Promise(() => {}) } });
  await h.runner.ready; await h.event('assistant/message'); await h.c.advance(4);
  await h.close();
  assert.equal(h.requests.length, 0);
});

test('same-phase updates keep an in-flight result useful without overwriting newer phases', async () => {
  let resolve;
  const h = harness({ requestText: () => new Promise(done => { resolve = done; }) });
  await h.runner.ready; await h.event('assistant/message'); await h.c.advance(4);
  await h.event('tool/result');
  resolve({ text: '{"text":"已定位登录错误，正在修复","evidenceRefs":["session:2"]}' }); await flush();
  assert.equal(h.runner.current('task').source, 'model');
  assert.equal(h.runner.current('task').summaryWatermark, 2);
  assert.equal(h.runner.current('task').watermark, 3);
  await h.close();
});

test('summary history is bounded, redacted and reset when its run changes', () => {
  const db = new DatabaseSync(':memory:'), store = installExecutionSummaryStore({ db });
  const b = { taskId: 't', runId: 'r', instructionRevision: 1, phase: 'running:active:none' };
  for (let watermark = 1; watermark <= 70; watermark++) {
    store.observeExecutionSummary({ ...b, watermark, text: '正在处理' });
    store.publishExecutionSummary({ ...b, watermark, text: `进度 ${watermark} password=HIDDEN`, source: 'model', generatedAt: watermark, evidenceRefs: [`s:${watermark}`] });
  }
  const row = store.executionSummary('t');
  assert.equal(row.history.length, 64); assert.equal(row.historyTruncated, true);
  assert.equal(row.history.at(-1).watermark, 70); assert.deepEqual(row.history.at(-1).evidenceRefs, ['s:70']);
  assert.doesNotMatch(JSON.stringify(row), /HIDDEN/);
  store.observeExecutionSummary({ ...b, runId: 'r2', watermark: 71, text: '继续处理' });
  assert.deepEqual(store.executionSummary('t').history, []); assert.equal(store.executionSummary('t').historyTruncated, false);
  db.close();
});

test('an explicit request coalesces and model failure preserves the visible state', async () => {
  let calls = 0;
  const h = harness({ requestText: async () => { calls++; throw new Error('offline'); } });
  await h.runner.ready;
  await h.runner.request('task'); await h.runner.request('task'); await h.c.advance(4);
  assert.equal(calls, 1);
  assert.equal(h.runner.current('task').source, 'deterministic');
  assert.equal(h.runner.current('task').degraded, true);
  await h.event(); await h.c.advance(60000);
  assert.equal(calls, 1);
  await h.close();
});

test('explicit model text cannot overwrite a newer paused revision', async () => {
  let resolve;
  const h = harness({ requestText: () => new Promise(done => { resolve = done; }) });
  await h.runner.ready; await h.runner.request('task'); await h.c.advance(4);
  await h.event('requirements', { revision: 2, status: 'waiting', executionControl: { paused: true } });
  const text = h.runner.current('task').text;
  resolve({ text: '{"text":"old","evidenceRefs":[]}' }); await flush();
  assert.equal(h.runner.current('task').text, text);
  assert.equal(h.store.auxiliaryActivities().entries.at(-1).status, 'stale');
  await h.close();
});

test('restart does not replay an earlier optional model request', async () => {
  const h = harness(); await h.runner.ready; await h.runner.request('task'); await h.runner.dispose();
  let calls = 0;
  const runner = createExecutionSummaries({ executionFacts: h.facts, store: h.store, ...h.c,
    requestText: async () => { calls++; return { text: '{"text":"unused","evidenceRefs":[]}' }; } });
  await runner.ready; await h.c.advance(60000);
  assert.equal(calls, 0);
  await runner.dispose(); await h.close();
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
