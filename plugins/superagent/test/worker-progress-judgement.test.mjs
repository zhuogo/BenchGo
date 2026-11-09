import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerProgressJudge } from '../src/worker-progress-judgement.mjs';

const facts = (watermark = 10, extra = {}) => ({
  ticketId: 'ticket', runId: 'run', instructionRevision: 1, watermark, observationStartedAt: 0,
  anomalies: ['repeated-activity'], target: '整理材料', acceptance: ['保存结果'],
  facts: { observedAt: new Date(200_000).toISOString(), runtime: { assignment: { fence: 1 }, artifactCoverage: {
    known: true, complete: true, lastSequence: watermark } },
  projections: [{ ticketId: 'ticket', runId: 'run', instructionRevision: 1, complete: true,
    state: { status: 'running', activity: 'working', tools: { calls: watermark, results: watermark, errors: 0 } } }],
  entries: [{ ticketId: 'ticket', runId: 'run', instructionRevision: 1, seq: watermark, kind: 'tool/result',
    data: { evidenceRefs: [{ sessionId: 'session', seq: watermark }] } },
    ...[0, 1].map(index => ({ ticketId: 'ticket', runId: 'run', instructionRevision: 1, fence: 1,
      seq: watermark - 2 + index, kind: 'artifact-observation', data: { sequence: watermark - 1 + index,
        startedAt: new Date(index ? 199_000 : 0).toISOString(), completedAt: new Date(index ? 200_000 : 1000).toISOString(),
        coverage: { kind: 'protected-workspace-files', complete: true, truncated: false, exclusionsVersion: 1 },
        comparison: { beforeFiles: 1, afterFiles: 1, added: 0, modified: 0, deleted: 0, unchanged: 1, netChanged: false } } }))] }, ...extra,
});
const decision = (request, classification = 'no-progress') => ({ text: JSON.stringify({ classification,
  outputRelevance: 'relevant', reason: '覆盖文件无净变化',
  evidenceRefs: request.input.evidenceRefs.filter(ref => ref.startsWith('execution:')).slice(-1), uncertainty: 'medium' }) });
const judge = extra => createWorkerProgressJudge({ now: () => 200_000, config: { minIntervalMs: 0 }, requestText: async request => decision(request), ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('anomalies, a known observation window and legal wait exemption gate the model', async () => {
  let calls = 0;
  const service = judge({ requestText: async request => { calls++; return decision(request); } });
  assert.equal((await service.evaluate(facts(10, { anomalies: [] }))).code, 'NO_ANOMALIES');
  assert.equal((await service.evaluate(facts(10, { anomalies: ['invented-anomaly'] }))).code, 'NO_ANOMALIES');
  assert.equal((await service.evaluate(facts(11, { observationStartedAt: undefined }))).code, 'OBSERVATION_UNKNOWN');
  assert.equal((await service.evaluate(facts(12, { observationStartedAt: 190_000 }))).code, 'OBSERVATION_WINDOW');
  for (const [index, waiting] of [
    { kind: 'user', active: true }, { kind: 'approval', active: true },
    { kind: 'background-job', active: true, until: 210_000 }, { kind: 'long-operation', active: true, until: 210_000 },
  ].entries()) {
    const result = await service.evaluate(facts(13 + index, { waiting }));
    assert.equal(result.code, 'LEGAL_WAIT'); assert.equal(result.classification, 'waiting');
  }
  assert.equal(calls, 0);
  assert.equal((await service.evaluate(facts(20, { waiting: { kind: 'long-operation', active: true, until: 190_000 } }))).status, 'judged');
  assert.equal((await service.evaluate(facts(21, { waiting: { kind: 'background-job', active: true } }))).status, 'judged');
  assert.equal(calls, 2);
});

test('two distinct, increasing observations make only a suspected signal eligible', async () => {
  const service = judge();
  const first = await service.evaluate(facts());
  assert.equal(first.status, 'judged'); assert.equal(first.hits, 1); assert.equal(first.signalEligible, false);
  assert.equal(first.uncertainty, 'medium'); assert.match(first.reason, /^疑似：/);
  const duplicate = await service.evaluate(facts());
  assert.equal(duplicate.code, 'EVIDENCE_UNCHANGED'); assert.equal(duplicate.signalEligible, false);
  const next = await service.evaluate(facts(11));
  assert.equal(next.hits, 2); assert.equal(next.signalEligible, true); assert.equal(next.evidenceWatermark, 11);
  const late = await service.evaluate(facts(9));
  assert.equal(late.code, 'STALE_EVIDENCE'); assert.equal(late.signalEligible, false);
});

test('a global cursor increase cannot count unchanged ticket evidence twice', async () => {
  let calls = 0;
  const service = judge({ requestText: async request => { calls++; return decision(request); } });
  await service.evaluate(facts());
  const result = await service.evaluate({ ...facts(), watermark: 20 });
  assert.equal(result.code, 'EVIDENCE_UNCHANGED'); assert.equal(calls, 1);
});

test('activity, unknown coverage, stale observations and unrelated outputs cannot substantiate no-progress', async () => {
  for (const change of [
    value => { value.facts.runtime.artifactCoverage.pending = 1; },
    value => { value.facts.runtime.artifactCoverage.failed = 1; },
    value => { value.facts.runtime.artifactCoverage.known = false; },
    value => { value.facts.observedAt = new Date(500_000).toISOString(); },
    value => { value.facts.entries = value.facts.entries.filter(row => row.kind !== 'artifact-observation'); },
  ]) {
    const value = facts(); change(value);
    const service = judge({ requestText: async request => ({ text: JSON.stringify({ classification: 'no-progress', outputRelevance: 'relevant',
      reason: '全任务没有产出', evidenceRefs: request.input.evidenceRefs.slice(0, 1), uncertainty: 'low' }) }) });
    const result = await service.evaluate(value);
    assert.equal(result.classification, 'insufficient-evidence'); assert.equal(result.signalEligible, false);
  }
  for (const outputRelevance of ['irrelevant', 'unknown', undefined]) {
    const result = await judge({ requestText: async request => ({ text: JSON.stringify({ ...JSON.parse(decision(request).text), outputRelevance }) }) }).evaluate(facts());
    assert.equal(result.classification, 'insufficient-evidence'); assert.equal(result.signalEligible, false);
  }
});

test('new activity cannot count the same completed file observation twice', async () => {
  let calls = 0;
  const service = judge({ requestText: async request => { calls++; return decision(request); } });
  await service.evaluate(facts());
  const next = facts(); next.watermark++;
  next.facts.projections[0].state.tools.calls++;
  assert.equal((await service.evaluate(next)).code, 'EVIDENCE_UNCHANGED'); assert.equal(calls, 1);
});

test('normal observations, changed classification, and a new execution reset consecutive hits', async () => {
  let classification = 'no-progress';
  const service = judge({ requestText: async request => decision(request, classification) });
  await service.evaluate(facts(10));
  classification = 'insufficient-evidence';
  assert.equal((await service.evaluate(facts(11))).hits, 0);
  classification = 'no-progress';
  assert.equal((await service.evaluate(facts(12))).hits, 1);
  classification = 'off-target';
  assert.equal((await service.evaluate(facts(13))).hits, 1);
  await service.evaluate(facts(14, { waiting: { kind: 'user', active: true } }));
  assert.equal((await service.evaluate(facts(15))).hits, 1);
  const revised = facts(16, { instructionRevision: 2 });
  revised.facts.projections[0].instructionRevision = 2;
  for (const row of revised.facts.entries) row.instructionRevision = 2;
  assert.equal((await service.evaluate(revised)).hits, 1);
});

test('latest persisted tracking restores frequency, hits and evidence deduplication', async () => {
  const records = [];
  const auditStore = { recordAuxiliaryActivity: record => records.push(structuredClone(record)),
    latestAuxiliaryActivity: binding => records.findLast(row => row.ticketId === binding.ticketId && row.runId === binding.runId && row.instructionRevision === binding.instructionRevision) };
  await judge({ auditStore }).evaluate(facts());
  const restored = judge({ auditStore });
  assert.equal((await restored.evaluate({ ...facts(), watermark: 11 })).code, 'EVIDENCE_UNCHANGED');
  const result = await restored.evaluate(facts(12));
  assert.equal(result.hits, 2); assert.equal(result.signalEligible, true);
  assert.ok(records.some(row => row.status === 'running'));
  assert.match(records.at(-1).tracking.lastEvidenceFingerprint, /^[a-f0-9]{64}$/);
  const limited = judge({ auditStore, config: { minIntervalMs: 1000 } });
  assert.equal((await limited.evaluate(facts(13))).code, 'RATE_LIMIT');
});

test('absent or failing models degrade without announcing normality or a Worker failure', async () => {
  for (const requestText of [undefined, async () => { throw new Error('private provider password=leak'); }]) {
    const records = [];
    const service = judge({ requestText, auditStore: { recordAuxiliaryActivity: record => records.push(record) } });
    const result = await service.evaluate(facts());
    assert.equal(result.status, 'degraded'); assert.equal(result.classification, 'insufficient-evidence');
    assert.equal(result.signalEligible, false); assert.doesNotMatch(JSON.stringify(records), /leak|private provider/);
    assert.equal(records.at(-1).status, 'degraded');
  }
});

test('judgements cannot invent references, omit suspicious evidence or return a reasoning field', async () => {
  for (const output of [
    { classification: 'no-progress', reason: '猜测', evidenceRefs: ['invented:1'], uncertainty: 'low' },
    { classification: 'no-progress', reason: '猜测', evidenceRefs: [], uncertainty: 'low' },
    { classification: 'off-target', reason: '猜测', evidenceRefs: ['session:10'], uncertainty: 'low', reasoning: 'private' },
    { classification: 'fault', reason: '确定故障', evidenceRefs: ['session:10'], uncertainty: 'low' },
  ]) {
    const service = judge({ requestText: async () => ({ text: JSON.stringify(output) }) });
    const result = await service.evaluate(facts());
    assert.equal(result.status, 'degraded'); assert.equal(result.code, 'INVALID_JUDGEMENT'); assert.equal(result.signalEligible, false);
  }
});

test('model input and persisted reason exclude raw tool data, secret requirements and arbitrary anomaly prose', async () => {
  let request;
  const records = [];
  const service = judge({ requestText: async value => { request = value; return { text: JSON.stringify({ classification: 'no-progress',
    reason: 'password=output-secret 暂无可核验进展', evidenceRefs: value.input.evidenceRefs, uncertainty: 'low' }) }; },
  auditStore: { recordAuxiliaryActivity: value => records.push(value) } });
  const input = facts(10, { target: '整理 password=target-secret', acceptance: ['token=acceptance-secret'],
    previousSummary: 'authorization=previous-secret', anomalies: ['repeated-activity', 'password=anomaly-secret'] });
  Object.assign(input.facts.entries[0].data, { arguments: { password: 'arg-secret' }, output: 'output-raw-secret', reasoning: 'reasoning-secret' });
  await service.evaluate(input);
  assert.doesNotMatch(JSON.stringify(request.input), /target-secret|acceptance-secret|previous-secret|anomaly-secret|arg-secret|output-raw-secret|reasoning-secret/);
  assert.deepEqual(request.input.observation.anomalies, ['repeated-activity']);
  assert.match(request.instructions, /untrusted reference data/);
  assert.doesNotMatch(JSON.stringify(records), /output-secret/);
});

test('per-ticket single flight invalidates an older result when new facts arrive', async () => {
  const gate = deferred(), started = deferred();
  let calls = 0;
  const service = judge({ requestText: async request => { calls++; started.resolve(); await gate.promise; return decision(request); } });
  const older = service.evaluate(facts(10)); await started.promise;
  assert.equal((await service.evaluate(facts(11))).code, 'CHECK_IN_FLIGHT');
  gate.resolve();
  const result = await older;
  assert.equal(result.code, 'STALE_EVIDENCE'); assert.equal(result.signalEligible, false); assert.equal(calls, 1);
  assert.equal((await service.evaluate(facts(11))).hits, 1);
});

test('global concurrency and per-ticket frequency are bounded without accumulating a queue', async () => {
  const gate = deferred(), started = deferred();
  const service = judge({ config: { globalConcurrency: 1, minIntervalMs: 1000 },
    requestText: async request => { started.resolve(); await gate.promise; return decision(request); } });
  const pending = service.evaluate(facts()); await started.promise;
  const second = facts(11, { ticketId: 'second' });
  assert.equal((await service.evaluate(second)).code, 'GLOBAL_LIMIT');
  gate.resolve(); await pending;
  assert.equal((await service.evaluate(facts(12))).code, 'RATE_LIMIT');
});

test('an adapter ignoring AbortSignal is bounded by timeout and releases its slot', async () => {
  let hanging = true;
  const service = judge({ config: { timeoutMs: 15, globalConcurrency: 1, minIntervalMs: 0 },
    requestText: request => hanging ? new Promise(() => {}) : Promise.resolve(decision(request)) });
  const result = await service.evaluate(facts());
  assert.equal(result.status, 'degraded'); assert.equal(result.code, 'TIMEOUT'); assert.equal(result.signalEligible, false);
  hanging = false;
  assert.equal((await service.evaluate(facts(11))).status, 'judged');
});

test('external cancellation and disposal never turn into suspected progress failures', async () => {
  for (const dispose of [false, true]) {
    const started = deferred(), controller = new AbortController();
    const service = judge({ requestText: () => { started.resolve(); return new Promise(() => {}); } });
    const pending = service.evaluate(facts(10, { signal: controller.signal })); await started.promise;
    if (dispose) service.dispose(); else controller.abort();
    const result = await pending;
    assert.equal(result.code, 'ABORTED'); assert.equal(result.signalEligible, false);
  }
});

test('unwritable audit prevents model dispatch and never authorizes a signal', async () => {
  let calls = 0;
  const service = judge({ requestText: async request => { calls++; return decision(request); },
    auditStore: { recordAuxiliaryActivity: () => { throw new Error('db unavailable'); } } });
  const result = await service.evaluate(facts());
  assert.equal(result.code, 'AUDIT_UNAVAILABLE'); assert.equal(calls, 0); assert.equal(result.signalEligible, false);
});

test('a failed result audit breaks the consecutive hit sequence', async () => {
  let fail = true;
  const service = judge({ auditStore: { recordAuxiliaryActivity: record => {
    if (fail && record.status === 'judged') { fail = false; throw new Error('write failed'); }
  } } });
  assert.equal((await service.evaluate(facts(10))).code, 'AUDIT_UNAVAILABLE');
  assert.equal((await service.evaluate(facts(11))).hits, 1);
});

test('invalid binding cannot call the model, and oversized input fails closed', async () => {
  let calls = 0;
  const service = judge({ config: { maxInputCharacters: 1024, minIntervalMs: 0 }, requestText: async request => { calls++; return decision(request); } });
  assert.equal((await service.evaluate(facts(10, { instructionRevision: 0 }))).code, 'INVALID_BINDING');
  const input = facts(10, { ticketId: 'x'.repeat(512), runId: 'y'.repeat(512) });
  assert.equal((await service.evaluate(input)).code, 'INPUT_LIMIT'); assert.equal(calls, 0);
});

test('malformed or oversized safe evidence degrades and persists without rejecting the hook', async () => {
  const records = [];
  const service = judge({ config: { maxInputCharacters: 1024, minIntervalMs: 0 },
    auditStore: { recordAuxiliaryActivity: value => records.push(value) } });
  const bad = facts(10, { facts: { projections: [null] } });
  assert.equal((await service.evaluate(bad)).code, 'INVALID_EVIDENCE');
  assert.equal(records.at(-1).status, 'degraded');
  const oversized = facts(11, { ticketId: 't'.repeat(512), runId: 'r'.repeat(512) });
  assert.equal((await service.evaluate(oversized)).code, 'INPUT_LIMIT');
  assert.equal(records.at(-1).code, 'INPUT_LIMIT');
});

test('a legal wait arriving during the model request invalidates its result at the same watermark', async () => {
  const gate = deferred(), started = deferred();
  const service = judge({ requestText: async request => { started.resolve(); await gate.promise; return decision(request); } });
  const pending = service.evaluate(facts()); await started.promise;
  await service.evaluate(facts(10, { waiting: { kind: 'approval', active: true } }));
  gate.resolve();
  assert.equal((await pending).code, 'STALE_EVIDENCE');
});

test('new facts arriving during asynchronous audit prevent an old eligible signal from escaping', async () => {
  const gate = deferred(), recording = deferred();
  const service = judge({ auditStore: { recordAuxiliaryActivity: async record => {
    if (record.result.signalEligible) { recording.resolve(); await gate.promise; }
  } } });
  await service.evaluate(facts(10));
  const pending = service.evaluate(facts(11)); await recording.promise;
  await service.evaluate(facts(12));
  gate.resolve();
  assert.equal((await pending).code, 'STALE_EVIDENCE');
  assert.equal((await service.evaluate(facts(12))).hits, 1);
});
