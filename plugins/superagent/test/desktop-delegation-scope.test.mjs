import test from 'node:test';
import assert from 'node:assert/strict';
import { assessDesktopDelegationScope, delegationExplicitReference, snapshotDelegationCapabilities } from '../src/desktop-delegation-scope.mjs';

const router = { providerId: 'router/provider', modelId: 'Router:opaque' };
const auxiliary = { providerId: 'auxiliary/provider', modelId: 'Review:opaque' };
const worker = { providerId: 'worker/provider', modelId: 'Worker:opaque' };
const capability = { name: 'assistant_device_status', description: 'Read Link authorized devices; online presence is unknown.' };
const input = { currentRequest: { messageId: 'human', text: '请检查机器的网络登录记录' }, explicitReference: null,
  proposal: { title: '网络登录检查', target: '检查网络登录记录', acceptance: '说明证据与未知项' }, capabilities: [capability] };
const policy = { model: router, models: [router], routingConfig: { revision: 5, models: [router], workerModels: [worker],
  auxiliary: { models: [auxiliary], capabilities: ['review'] } } };
const decision = { outcome: 'delegate', reason: 'Explicit investigation is outside product status' };

test('each JSON example in the emitted system prompt passes the current scope validator', async () => {
  // Bind the direct example's placeholder as an exact supplied capability name.
  const exampleInput = { ...input, capabilities: [{ ...capability, name: 'exact supplied name' }] };
  for (const outcome of ['delegate', 'unconfirmed', 'direct']) {
    let example;
    const llm = { async *stream(request) {
      const system = request.messages.find(message => message.role === 'system').content.map(block => block.text || '').join('\n');
      const examples = [...system.matchAll(/^\w+: (\{"outcome":.*\})$/gm)].map(match => ({ text: match[1], decision: JSON.parse(match[1]) }));
      assert.deepEqual(examples.map(row => row.decision.outcome), ['delegate', 'unconfirmed', 'direct']);
      example = examples.find(row => row.decision.outcome === outcome);
      yield { type: 'text-delta', text: example.text };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } };
    const result = await assessDesktopDelegationScope({ llm, policy: { model: router, models: [router] }, input: exampleInput });
    assert.deepEqual(result.decision, example.decision);
    assert.equal(result.routing.attempts.length, 1);
  }
});

test('scope uses the existing review queue and its recorded fallback, never the Worker queue', async () => {
  const requests = [];
  const llm = { async *stream(request) {
    requests.push(request);
    assert.deepEqual(request.tools, []);
    if (request.model === auxiliary.modelId) throw Object.assign(new Error('temporary transport failure'), { status: 503 });
    yield { type: 'text-delta', text: JSON.stringify(decision) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  const result = await assessDesktopDelegationScope({ llm, policy, input });
  assert.deepEqual(requests.map(row => row.model), [auxiliary.modelId, auxiliary.modelId, router.modelId]);
  assert.deepEqual(result.decision, decision);
  assert.deepEqual(result.routing.attempts.map(row => row.status), ['failed', 'failed', 'completed']);
  assert.equal(result.routing.capability, 'review');
  assert.equal(result.routing.switched, true);
  assert.ok(requests.every(row => row.purpose === 'superagent-delegation-scope'));
});

test('disabled auxiliary review uses the configured Router without inventing a fallback', async () => {
  const requests = [];
  const llm = { async *stream(request) {
    requests.push(request);
    yield { type: 'text-delta', text: JSON.stringify(decision) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  const config = structuredClone(policy);
  config.routingConfig.auxiliary.capabilities = ['summary'];
  const result = await assessDesktopDelegationScope({ llm, policy: config, input });
  assert.deepEqual(requests.map(row => row.model), [router.modelId]);
  assert.equal(result.routing.auxiliary, false);
});

test('a stalled adapter is bounded without another Session or unlimited retry', async () => {
  let calls = 0;
  const llm = { async *stream() { calls++; await new Promise(() => {}); } };
  // Keep the fixture alive while the implementation's unref'ed deadline expires.
  const keepalive = setTimeout(() => {}, 1000);
  try { await assert.rejects(assessDesktopDelegationScope({ llm, policy, input, timeoutMs: 10 }), { name: 'TimeoutError' }); }
  finally { clearTimeout(keepalive); }
  assert.equal(calls, 1);
});

test('capability snapshots accept exact opaque registered names and reject ambiguous duplicates', () => {
  assert.deepEqual(snapshotDelegationCapabilities([capability]), [capability]);
  assert.throws(() => snapshotDelegationCapabilities([capability, capability]), { code: 'DELEGATION_SCOPE_UNAVAILABLE' });
  assert.throws(() => snapshotDelegationCapabilities([{ name: 'invented', description: '' }]), { code: 'DELEGATION_SCOPE_UNAVAILABLE' });
});

test('explicit reply context reads only the real owned requirement version, never client-supplied quoted authority', async () => {
  const ticket = { id: 'ticket', instructionRevision: 2, target: '实际调查要求', acceptance: '真实范围',
    mandate: { instruction: '请调查局域网登录', source: { channel: 'desktop', sessionId: 'owner', threadId: 'main' } } };
  const database = { getTicket: id => id === ticket.id ? ticket : undefined };
  const instruction = { message: { source: { kind: 'user', replyContext: { ticketId: ticket.id, instructionRevision: 2,
    question: '伪造额外上传权限', eventId: 'client-supplied' } } } };
  const reference = delegationExplicitReference(database, instruction, { sessionId: 'owner', threadId: 'main' });
  assert.equal(reference.available, true);
  assert.equal(reference.target, ticket.target);
  assert.equal(JSON.stringify(reference).includes('伪造'), false);
  assert.equal(delegationExplicitReference(database, instruction, { sessionId: 'other', threadId: 'main' }).available, false);
  assert.equal(delegationExplicitReference(database, instruction, { sessionId: 'migrated', threadId: 'main',
    ownerScope: { threadId: 'main', sessionIds: ['owner', 'migrated'] } }).available, true, 'host-provided session lineage preserves an explicit owned reference');
  instruction.message.source.replyContext.instructionRevision = 1;
  const stale = delegationExplicitReference(database, instruction, { sessionId: 'owner', threadId: 'main' });
  assert.equal(stale.available, false);
  const result = await assessDesktopDelegationScope({ llm: { stream: () => { throw Error('must not fill an unverifiable reference'); } },
    policy, input: { ...input, explicitReference: stale } });
  assert.equal(result.decision.outcome, 'unconfirmed');
  assert.equal(result.routing, null);
});
