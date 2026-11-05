import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createAssistantOrchestrationStore } from '../plugins/superagent/src/orchestration-store.mjs';
import { createAssessmentRunner } from '../plugins/superagent/src/assessment-runner.mjs';
import { assessCandidates } from '../plugins/superagent/src/assessment.mjs';

const database = createAssistantOrchestrationStore({ filename: ':memory:' });
const calls = [], requests = [];
let release, began;
const blocked = new Promise(resolve => { release = resolve; });
const started = new Promise(resolve => { began = resolve; });
const model = { providerId: 'main-provider', modelId: 'main-opaque' };
const auxiliary = { models: [{ providerId: 'aux-provider', modelId: 'aux-opaque' }], capabilities: ['review'] };
for (const threadId of ['slow-thread', 'other-thread']) database.ingest({
  dedupeKey: threadId, thread: { id: threadId, source: { type: 'feishu', id: threadId } },
  source: {}, actor: { id: 'owner', kind: 'human' }, content: 'Independent work',
  gate: { allowed: true, strength: 'explicit' }, policyVersion: 'p',
});
const runner = createAssessmentRunner({ database,
  readPolicy: async () => ({ version: 'p', model, models: [model], routingConfig: { auxiliary }, rules: '' }),
  authorize: async () => ({ allowed: true }),
  assess: async input => {
    calls.push({ threadId: input.candidates[0].trigger.threadId, model: input.model, auxiliaryForwarded: !!input.routingConfig?.auxiliary });
    if (calls.length === 1) { began(); await blocked; }
    return assessCandidates({ ...input, llm: { stream: async function* (request) {
      requests.push({ provider: request.provider, model: request.model, tools: request.tools.map(tool => tool.name) });
      yield { type: 'text-delta', text: JSON.stringify({ decisions: input.candidates.map(candidate => ({ candidateId: candidate.candidateId, outcome: 'ignore', reason: 'audit only' })) }) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } } });
  },
});
try {
  const pending = runner.tick();
  await started;
  await new Promise(resolve => setImmediate(resolve));
  const callsWhileFirstBlocked = calls.length;
  release(); await pending;
  assert.equal(callsWhileFirstBlocked, 2);
  assert.equal(calls.length, 2);
  assert(calls.every(call => call.auxiliaryForwarded));
  assert(requests.every(request => request.model === 'aux-opaque' && request.provider === 'aux-provider' && request.tools.includes('read_assessment_source')));
  const result = { at: new Date().toISOString(), scope: 'Real host runner + in-memory store; injected assessment probe, no provider requests or production changes.',
    findings: [
      { id: 'ALIGN-01', fixed: true, description: 'The second thread starts while the first assessment is blocked.', callsWhileFirstBlocked },
      { id: 'ALIGN-02', fixed: true, description: 'Admission requests use the configured auxiliary model and retain the bounded source reader.' },
    ], calls, requests };
  await writeFile(new URL('./superagent-20261103/dsh-pitfalls-fixed.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { release(); await runner.stop(); database.close(); }
