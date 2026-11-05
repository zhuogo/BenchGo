import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createAssessmentRunner } from '../src/assessment-runner.mjs';

test('authorized channel admission delivers the same Router reply without another model call', async t => {
  for (const allowed of [true, false]) {
    const database = createAssistantOrchestrationStore({ filename: ':memory:' });
    t.after(() => database.close());
    const source = { channel: 'feishu', appId: 'app', chatId: 'chat', messageId: 'original' };
    const actor = { id: 'owner', kind: 'human' }, replyText = '我来查这几家供应商，按你关心的费用和限制做对比。';
    database.ingest({ dedupeKey: 'request', thread: { id: 'chat', source: { type: 'feishu', id: 'chat' } }, source, actor,
      content: '比较这几家供应商的费用和限制', gate: { allowed: true, strength: 'explicit' }, policyVersion: 'p' });
    let calls = 0;
    const runner = createAssessmentRunner({ database,
      readPolicy: async () => ({ version: 'p', model: {}, rules: '' }),
      authorize: async () => ({ allowed, mandate: { source, actorId: actor.id } }),
      assess: async ({ candidates }) => {
        calls++;
        return [{ candidateId: candidates[0].candidateId, outcome: 'accept', reason: 'Requested comparison',
          target: 'Compare suppliers', acceptance: 'Prices and limits with sources', replyText,
          source: { channel: 'feishu', chatId: 'injected' } }];
      },
    });
    await Promise.all([runner.tick(), runner.tick()]);
    await runner.tick();
    await runner.stop();
    assert.equal(calls, 1);
    const pending = database.pendingOutbox();
    assert.equal(pending.length, allowed ? 1 : 0);
    assert.equal(database.listTickets().length, allowed ? 1 : 0);
    if (allowed) {
      assert.equal(pending[0].payload.text, replyText);
      assert.equal(pending[0].payload.origin, 'router');
      assert.deepEqual(pending[0].payload.source, source);
    }
  }
});

test('runner binds direct reply to the original source only after current authorization', async t => {
  for (const allowed of [true, false]) {
    const store = createAssistantOrchestrationStore({ filename: ':memory:' });
    t.after(() => store.close());
    const source = { channel: 'feishu', appId: 'app', chatId: 'chat', messageId: 'original' };
    const actor = { id: 'owner', kind: 'human' }, gate = { allowed: true, strength: 'explicit' };
    store.ingest({ dedupeKey: 'greeting', thread: { id: 'chat', source: { type: 'feishu', id: 'chat' } }, source, actor, content: '你好', gate, policyVersion: 'p' });
    let committed;
    const database = new Proxy(store, { get(target, key) { return key === 'decide' ? (_id, decision) => { committed = decision; } : target[key]; } });
    const runner = createAssessmentRunner({ database, readPolicy: async () => ({ version: 'p', model: {} }), authorize: async () => ({ allowed }),
      assess: async ({ candidates }) => {
        assert.ok(Number.isFinite(Date.parse(candidates[0].context.freshness.assessedAt)));
        assert.equal(candidates[0].context.freshness.newerSourceMessageExists, false);
        return [{ candidateId: candidates[0].candidateId, outcome: 'answer', reason: 'Greeting', replyText: '你好！', source: { chatId: 'injected' } }];
      },
    });
    await runner.tick();
    await runner.stop();
    assert.equal(committed.outcome, allowed ? 'answer' : 'notExplicit');
    assert.equal(committed.ticket, undefined);
    if (allowed) assert.deepEqual(committed.reply, { text: '你好！', source, actor, gate: store.candidates({ threadId: 'chat' })[0].gate, policyVersion: 'p' });
    else assert.equal(committed.reply, undefined);
  }
});

test('independent threads and later arrivals progress while a slow thread keeps its single batch', { timeout: 3000 }, async t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  const ingest = (threadId, key) => database.ingest({ dedupeKey: key, thread: { id: threadId, source: { type: 'feishu', id: threadId } }, source: {}, actor: {}, content: key, gate: { allowed: true, strength: 'explicit' }, policyVersion: 'p' });
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const release = deferred(), slowEntered = deferred(), goodEntered = deferred(), laterEntered = deferred();
  const calls = [];
  const runner = createAssessmentRunner({ database,
    readPolicy: async () => ({ version: 'p', model: {} }), authorize: async () => ({ allowed: true }),
    assess: async ({ candidates }) => {
      const id = candidates[0].trigger.threadId;
      calls.push(id);
      if (id === 'slow') { slowEntered.resolve(); await release.promise; }
      if (id === 'good') goodEntered.resolve();
      if (id === 'later') laterEntered.resolve();
      return candidates.map(row => ({ candidateId: row.candidateId, outcome: 'ignore', reason: 'discussion' }));
    },
  });
  t.after(() => runner.stop());
  ingest('slow', 'first'); ingest('good', 'good');
  const first = runner.tick();
  await Promise.all([slowEntered.promise, goodEntered.promise]);
  ingest('slow', 'second'); ingest('later', 'later');
  const second = runner.tick();
  await laterEntered.promise;
  assert.deepEqual(calls, ['slow', 'good', 'later']);
  assert.equal(database.candidates({ threadId: 'slow', status: 'queued' }).length, 1);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(database.candidates({ threadId: 'later' })[0].status, 'decided');
  await runner.tick();
  assert.deepEqual(calls, ['slow', 'good', 'later', 'slow']);
  assert.equal(database.candidates({ threadId: 'slow', status: 'queued' }).length, 0);
});

test('assessment includes bounded head and nearby context beyond the first page and preserves original ledger text', async t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  for (let index = 0; index < 220; index++) {
    database.ingest({ dedupeKey: `context-${index}`, thread: { id: 'long-thread', source: { type: 'feishu', id: 'long-chat' } }, source: { messageId: `message-${index}` }, actor: { id: 'owner' }, content: `${index}:` + '长'.repeat(10000), gate: { allowed: index === 210, strength: index === 210 ? 'explicit' : 'ignore' }, policyVersion: 'p' });
  }
  const candidate = database.candidates({ threadId: 'long-thread', status: 'queued' })[0];
  assert.ok(candidate);
  const original = database.getTrigger(candidate.triggerId);
  let inspected = false;
  const runner = createAssessmentRunner({ database,
    readPolicy: async () => ({ version: 'p', model: {} }), authorize: async () => ({ allowed: true }),
    assess: async ({ candidates }) => {
      inspected = true;
      assert.equal(candidates.length, 1);
      const card = candidates[0];
      assert.equal(card.context.total, 220);
      assert.equal(card.context.messages.length, 16);
      assert.equal(card.context.omittedCount, 204);
      assert.deepEqual(card.context.messages.map(row => row.number), [1, 2, 3, 4, 5, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216]);
      assert.equal(card.trigger.truncated, true);
      assert.equal(card.trigger.content.length, 4000);
      assert.equal(card.trigger.fullLength, original.content.length);
      assert.equal(card.trigger.pointer.source.messageId, 'message-210');
      assert.ok(JSON.stringify(candidates).length < 80000);
      return [{ candidateId: card.candidateId, outcome: 'ignore', reason: 'context inspected' }];
    },
  });
  await runner.tick();
  await runner.stop();
  assert.equal(inspected, true);
  assert.equal(database.getTrigger(candidate.triggerId).content, original.content);
});

test('large candidate batches share an excerpt budget and leave excess candidates queued', async t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  for (let index = 0; index < 20; index++) database.ingest({ dedupeKey: `batch-${index}`, thread: { id: 'batch', source: { type: 'feishu', id: 'batch' } }, source: {}, actor: {}, content: 'x'.repeat(20000), gate: { allowed: true, strength: 'explicit' }, policyVersion: 'p' });
  let inspected = false;
  const runner = createAssessmentRunner({ database,
    readPolicy: async () => ({ version: 'p', model: {} }), authorize: async () => ({ allowed: true }),
    assess: async ({ candidates, readSource }) => {
      inspected = true;
      assert.equal(candidates.length, 8);
      const excerpts = candidates.reduce((sum, card) => sum + card.trigger.content.length + card.context.messages.reduce((size, message) => size + (message.content?.length || 0), 0), 0);
      assert.ok(excerpts <= 68000);
      assert.ok(JSON.stringify(candidates).length < 110000);
      assert.equal((await readSource({ triggerId: candidates[0].trigger.id, offset: 16000 })).content.length, 4000);
      return candidates.map(card => ({ candidateId: card.candidateId, outcome: 'ignore', reason: 'read only' }));
    },
  });
  await runner.tick();
  await runner.stop();
  assert.equal(inspected, true);
  assert.equal(database.candidates({ status: 'queued' }).length, 12);
});

test('persisted intake becomes a ticket only with host authorization, duplicate ticks coalesce', async t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  database.ingest({ dedupeKey: 'event', thread: { id: 'thread', source: { type: 'feishu', id: 'chat' } }, source: {}, actor: { id: 'owner' }, content: '检查项目', gate: { allowed: true, strength: 'explicit' }, policyVersion: 'p1' });
  let assessments = 0;
  const runner = createAssessmentRunner({ database,
    readPolicy: async () => ({ version: 'p1', model: {}, rules: '' }),
    authorize: async () => ({ allowed: true, mandate: { scope: ['read'] } }),
    assess: async ({ candidates }) => { assessments++; return candidates.map(row => ({ candidateId: row.candidateId, outcome: 'accept', target: '检查', acceptance: '给出证据', reason: '主人指令', mandate: { scope: ['write'] } })); },
  });
  await Promise.all([runner.tick(), runner.tick()]);
  assert.equal(assessments, 1);
  assert.deepEqual(database.listTickets()[0].mandate.scope, ['read']);
  assert.equal(database.subscriptions().length, 1);
  await runner.tick(); assert.equal(assessments, 1);
  await runner.stop();
});

test('policy changes during authorization prevent ticket creation', async t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  database.ingest({ dedupeKey: 'event', thread: { id: 'thread', source: { type: 'feishu', id: 'chat' } }, source: {}, actor: { id: 'owner' }, content: '检查', gate: { allowed: true, strength: 'explicit' }, policyVersion: 'p1' });
  let version = 'p1';
  const runner = createAssessmentRunner({ database,
    readPolicy: async () => ({ version, model: {}, rules: '' }),
    authorize: async () => { version = 'p2'; return { allowed: true, mandate: {} }; },
    assess: async ({ candidates }) => candidates.map(row => ({ candidateId: row.candidateId, outcome: 'accept', target: '检查', acceptance: '证据', reason: '指令' })),
  });
  await runner.tick();
  assert.equal(database.listTickets().length, 0);
  await runner.stop();
});

test('a failed thread does not starve other threads and shutdown fences ignored cancellation', async t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  for (const id of ['bad', 'good']) database.ingest({ dedupeKey: id, thread: { id, source: { type: 'feishu', id } }, source: {}, actor: {}, content: id, gate: { allowed: true, strength: 'explicit' }, policyVersion: 'p' });
  const runner = createAssessmentRunner({ database,
    readPolicy: async () => ({ version: 'p', model: {} }), authorize: async () => ({ allowed: true }),
    assess: async ({ candidates }) => {
      if (candidates[0].trigger.content === 'bad') throw new Error('provider unavailable');
      return candidates.map(row => ({ candidateId: row.candidateId, outcome: 'ignore', reason: 'discussion' }));
    },
  });
  await assert.rejects(runner.tick(), AggregateError);
  assert.equal(database.candidates({ threadId: 'good' })[0].status, 'decided');
  await runner.stop();
  database.ingest({ dedupeKey: 'stuck', thread: { id: 'stuck', source: { type: 'feishu', id: 'stuck' } }, source: {}, actor: {}, content: 'stuck', gate: { allowed: true }, policyVersion: 'p' });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const stuck = createAssessmentRunner({ database, readPolicy: async () => ({ version: 'p', model: {} }), authorize: async () => ({ allowed: true }), assess: () => { entered(); return new Promise(() => {}); } });
  const ticking = stuck.tick();
  await ready;
  await stuck.stop();
  await assert.rejects(ticking, { name: 'AbortError' });
  assert.equal(database.listTickets().length, 0);
});
