import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantStore } from '../src/store.mjs';
import { readAdmissionRules } from '../src/admission-rules.mjs';
import { readAssessmentPolicy, authorizeAssessment } from '../src/assessment-policy.mjs';
import { ingestAssistantEvent } from '../src/intake.mjs';
import { createAssessmentRunner } from '../src/assessment-runner.mjs';
import { createOrchestrationRuntime } from '../src/orchestration-runtime.mjs';

test('written rules require a nonempty exact heading and ignore fenced examples', () => {
  assert.deepEqual(readAdmissionRules('```md\n## rule: fake\nnot authority\n```\n## rule: Real:ID\nRead only\n### Details\nKeep evidence\n## other\nnot part of rule\n## rule: empty'), [{ id: 'Real:ID', instruction: 'Read only\n### Details\nKeep evidence' }]);
  assert.throws(() => readAdmissionRules('## rule: same\nfirst\n## rule: same\nsecond'), /Duplicate/);
});

for (const scenario of ['auto', 'manual', 'unknown-rule', 'ignore', 'revoked', 'revoked-during-run']) test(`machine intake through Router and runtime (${scenario})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-rule-admission-'));
  let store = await createAssistantStore({ dataDirectory: directory }), runner, runtime;
  t.after(async () => { await runtime?.stop(); await runner?.stop(); store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.updateConfig({ models: [{ providerId: 'provider', modelId: 'opaque/model' }] });
  const document = await store.documents.read('AGENTS.md');
  await store.documents.update('AGENTS.md', { expectedHash: document.hash, content: '## rule: ci-check\nInspect failed CI and report evidence; do not deploy.', source: { kind: 'test' } });
  store.connections.update({ enabled: true, appId: 'app', appSecretRef: 'env:SECRET', ownerOpenIds: ['owner'], chatIds: ['chat'], machineOpenIds: ['ci'], admissionMode: scenario === 'manual' ? 'manual' : 'auto', enabledRuleIds: ['ci-check'] }, { revision: 0 });
  const readPolicy = () => readAssessmentPolicy(store);
  const policy = await readPolicy();
  const event = { channel: 'feishu', kind: 'group', text: 'CI failed', sourceKey: 'ci-event', threadId: 'thread', mentioned: true, actor: { id: 'ci', kind: 'machine' }, source: { channel: 'feishu', sourceType: 'group', connectionId: 'feishu', conversationId: 'chat', appId: 'app', chatId: 'chat', messageId: 'ci-message' } };
  const gatePolicy = { version: policy.version, machineIds: ['ci'], ownerIds: ['owner'], threadIds: ['chat'] };
  ingestAssistantEvent(store.orchestration, event, gatePolicy);
  assert.equal(ingestAssistantEvent(store.orchestration, event, gatePolicy).duplicate, true);
  runner = createAssessmentRunner({ database: store.orchestration, readPolicy, authorize: authorizeAssessment, assess: async ({ candidates, rules }) => {
    assert.match(rules, /Inspect failed CI/);
    return candidates.map(row => ({ candidateId: row.candidateId, outcome: scenario === 'ignore' ? 'ignore' : 'accept', target: 'Inspect CI', acceptance: 'Evidence', reason: 'Written rule', ruleIds: [scenario === 'unknown-rule' ? 'missing' : 'ci-check'] }));
  } });
  await runner.tick(); await runner.stop();
  const tickets = store.orchestration.listTickets();
  if (['manual', 'unknown-rule', 'ignore'].includes(scenario)) {
    assert.equal(tickets.length, 0);
    assert.equal(store.orchestration.getDecision(store.orchestration.candidates()[0].id).outcome, scenario === 'ignore' ? 'ignore' : 'notExplicit');
    return;
  }
  assert.equal(tickets.length, 1);
  assert.deepEqual(tickets[0].mandate.ruleIds, ['ci-check']);
  if (scenario === 'revoked') {
    store.connections.update({ admissionMode: 'manual' }, { revision: 1 });
    store.close(); store = await createAssistantStore({ dataDirectory: directory });
  }
  let executions = 0, sends = 0;
  runtime = createOrchestrationRuntime({ ctx: {}, store, execute: async (_assignment, context) => { executions++; if (scenario === 'revoked-during-run') { store.connections.update({ enabledRuleIds: [] }, { revision: 1 }); await context.renew(); } return { summary: 'CI inspected', outcome: 'completed', selfCheck: { summary: 'Checked CI evidence and current requirements' }, evidenceRefs: ['test:evidence'] }; }, feishu: { send: async request => { sends++; assert.equal(request.source.messageId, 'ci-message'); return { status: 'accepted', messageId: 'reply' }; } } });
  for (let i = 0; i < 40; i++) { await runtime.tick(); if (sends || scenario === 'revoked') break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(executions, scenario === 'revoked' ? 0 : 1);
  assert.equal(sends, scenario.startsWith('revoked') ? 0 : 1);
  if (scenario === 'revoked-during-run') assert.equal(store.orchestration.assignments(tickets[0].id)[0].state, 'uncertain');
  assert.equal(store.orchestration.listTickets().length, 1);
});
