import test from 'node:test';
import assert from 'node:assert/strict';

test('direct answers and questions require current explicit human channel authority', () => {
  const config = { enabled: true, appId: 'app', ownerOpenIds: ['owner'], chatIds: ['chat'] };
  const input = { policy: { connection: config }, candidate: { gate: { allowed: true, strength: 'explicit' } }, trigger: { actor: { id: 'owner', kind: 'human' }, source: { channel: 'feishu', appId: 'app', chatId: 'chat' } } };
  for (const outcome of ['answer', 'ask']) {
    const request = { ...input, decision: { outcome } };
    assert.equal(authorizeAssessment(request).allowed, true);
    assert.equal(authorizeAssessment({ ...request, decision: { outcome, ticketId: 'ticket' } }).allowed, false);
    assert.equal(authorizeAssessment({ ...request, candidate: { gate: { allowed: true, strength: 'inferred' } } }).allowed, false);
    assert.equal(authorizeAssessment({ ...request, candidate: { gate: { allowed: false, strength: 'explicit' } } }).allowed, false);
    assert.equal(authorizeAssessment({ ...request, trigger: { ...input.trigger, actor: { id: 'owner', kind: 'machine' } } }).allowed, false);
    assert.equal(authorizeAssessment({ ...request, policy: { connection: { ...config, enabled: false } } }).allowed, false);
    assert.equal(authorizeAssessment({ ...request, trigger: { ...input.trigger, source: { ...input.trigger.source, chatId: 'other' } } }).allowed, false);
  }
});

test('platform members receive task authority only within enabled Feishu scope', () => {
  const config = { enabled: true, appId: 'app', ownerOpenIds: [], chatIds: [], accessMode: 'platform', directMessages: true, groups: [{ chatId: 'group', mode: 'mentions' }], otherGroups: 'disabled' };
  const policy = { version: 'v1', connection: config, projects: [] };
  const source = { channel: 'feishu', appId: 'app', chatId: 'group', chatType: 'group' };
  const input = { policy, candidate: { gate: { allowed: true, strength: 'explicit' } }, trigger: { actor: { id: 'member', kind: 'human' }, source, content: 'Summarize' }, decision: { outcome: 'accept' } };
  const result = authorizeAssessment(input);
  assert.equal(result.allowed, true);
  assert.equal(result.mandate.admission, 'platform-request');
  assert.equal(result.mandate.actorKind, 'human');
  const mandate = { ...result.mandate, policyVersion: 'v1' };
  assert.equal(validateTicketMandate(mandate, { policy }), true);
  assert.equal(validateTicketMandate(mandate, { policy: { ...policy, connection: { ...config, accessMode: 'owners' } } }), false);
  assert.equal(validateTicketMandate(mandate, { policy: { ...policy, connection: { ...config, groups: [] } } }), false);
  assert.equal(authorizeAssessment({ ...input, trigger: { ...input.trigger, actor: { id: 'member', kind: 'machine' } } }).allowed, false);
  const decision = { outcome: 'stop', ticketId: 'ticket' };
  assert.equal(authorizeAssessment({ ...input, decision, ticket: { mandate: { ...mandate, actorId: 'someone-else' } } }).allowed, false);
  assert.equal(authorizeAssessment({ ...input, decision, ticket: { mandate } }).allowed, true);
});
import { readAssessmentPolicy, authorizeAssessment, validateTicketMandate } from '../src/assessment-policy.mjs';

test('assessment keeps Router and Worker role queues separate and resolves Worker inheritance', async () => {
  const router = { providerId: 'Router/@', modelId: 'Exact: Router/1' };
  const worker = { providerId: 'Worker/@', modelId: 'Exact: Worker/2' };
  const auxiliary = { models: [{ providerId: 'Aux/@', modelId: 'Exact: Aux/3' }], capabilities: ['review'] };
  let config = { revision: 1, models: [router], workerModels: [worker], auxiliary };
  const store = { getConfig: async () => config, connections: { read: () => ({ revision: 1, config: {} }) }, documents: { read: async () => ({ hash: 'rules', content: '' }) } };
  const policy = await readAssessmentPolicy(store);
  assert.deepEqual(policy.model, router);
  assert.deepEqual(policy.models, [router]);
  assert.deepEqual(policy.workerModels, [worker]);
  assert.deepEqual(policy.routingConfig, config);
  for (const workerModels of [[], undefined]) {
    config = { ...config, workerModels };
    assert.deepEqual((await readAssessmentPolicy(store)).workerModels, [router]);
  }
});

test('policy binds disk rules and channel revision; revoked ownership cannot open tickets', async () => {
  let revision = 1, configRevision = 1, hash = 'rules-1';
  const connection = { enabled: true, appId: 'app', chatIds: ['chat'], ownerOpenIds: ['owner'] };
  const store = { connections: { read: () => ({ revision, config: connection }) }, getConfig: async () => ({ revision: configRevision, models: [{ providerId: 'opaque-provider', modelId: 'opaque/model' }] }), documents: { read: async () => ({ hash, content: 'current rules' }) } };
  const first = await readAssessmentPolicy(store);
  configRevision++;
  assert.equal((await readAssessmentPolicy(store)).version, first.version, 'ordinary settings edits do not revoke active work');
  hash = 'rules-2';
  assert.notEqual((await readAssessmentPolicy(store)).version, first.version);
  const event = { candidate: { gate: { strength: 'explicit' } }, trigger: { actor: { id: 'owner', kind: 'human' }, source: { appId: 'app', chatId: 'chat' }, content: '检查项目' }, decision: { outcome: 'accept' } };
  assert.equal(authorizeAssessment({ ...event, policy: first }).allowed, true);
  const projectPolicy = { ...first, projects: [{ id: 'project/opaque', path: '/project' }] };
  assert.equal(authorizeAssessment({ ...event, policy: projectPolicy, decision: { outcome: 'accept', projectId: 'unknown' } }).allowed, false);
  const accepted = authorizeAssessment({ ...event, policy: projectPolicy, decision: { outcome: 'accept', projectId: 'project/opaque' } });
  const mandate = { ...accepted.mandate, policyVersion: first.version };
  assert.equal(validateTicketMandate(mandate, { policy: projectPolicy }), true);
  assert.equal(validateTicketMandate(mandate, { policy: { ...projectPolicy, projects: [{ id: 'project/opaque', path: '/replacement' }] } }), false);
  connection.ownerOpenIds = []; revision++;
  const revoked = await readAssessmentPolicy(store);
  assert.equal(authorizeAssessment({ ...event, policy: revoked }).allowed, false);
  assert.deepEqual(revoked.model, { providerId: 'opaque-provider', modelId: 'opaque/model' });
});

test('machine admission requires auto mode and every enabled written rule; revocation fences its mandate', async () => {
  let revision = 1;
  const connection = { enabled: true, appId: 'app', chatIds: ['chat'], ownerOpenIds: ['owner'], machineOpenIds: ['ci'], admissionMode: 'auto', enabledRuleIds: ['opaque/rule'] };
  const store = { connections: { read: () => ({ revision, config: structuredClone(connection) }) }, getConfig: async () => ({ models: [] }), documents: { read: async () => ({ hash: 'rules', content: '## rule: opaque/rule\nInspect failures only' }) } };
  const policy = await readAssessmentPolicy(store);
  assert.match(policy.rules, /Inspect failures only/);
  const input = { policy, candidate: { gate: { allowed: true, strength: 'inferred' } }, trigger: { actor: { id: 'ci', kind: 'machine' }, source: { channel: 'feishu', appId: 'app', chatId: 'chat' }, content: 'Failure report' }, decision: { outcome: 'accept', ruleIds: ['opaque/rule'] } };
  const permission = authorizeAssessment(input);
  assert.equal(permission.allowed, true);
  const mandate = { ...permission.mandate, policyVersion: policy.version };
  assert.equal(mandate.admission, 'enabled-rules');
  assert.equal(validateTicketMandate(mandate, { policy }), true);
  for (const ruleIds of [[], ['unknown'], ['opaque/rule', 'unknown'], ['opaque/rule', 'opaque/rule']]) assert.equal(authorizeAssessment({ ...input, decision: { outcome: 'accept', ruleIds } }).allowed, false);
  for (const outcome of ['attach', 'stop']) assert.equal(authorizeAssessment({ ...input, decision: { outcome, ruleIds: ['opaque/rule'], ticketId: 'owner-ticket' } }).allowed, false);
  assert.equal(authorizeAssessment({ ...input, decision: { outcome: 'ignore' } }).allowed, true);
  assert.equal(authorizeAssessment({ ...input, candidate: { gate: { strength: 'explicit' } } }).allowed, false, 'machine mention cannot grant explicit authority');
  assert.equal(authorizeAssessment({ ...input, policy: { ...policy, mode: 'manual' } }).allowed, false);
  assert.equal(validateTicketMandate(mandate, { policy: { ...policy, mode: 'manual' } }), false);
  assert.equal(validateTicketMandate(mandate, { policy: { ...policy, enabledRuleIds: [] } }), false);
  assert.equal(validateTicketMandate(mandate, { policy: { ...policy, connection: { ...policy.connection, machineOpenIds: [] } } }), false);
  connection.enabledRuleIds = []; revision++;
  const revoked = await readAssessmentPolicy(store);
  assert.notEqual(revoked.version, policy.version);
  assert.equal(validateTicketMandate(mandate, { policy: revoked }), false);
  assert.equal(authorizeAssessment({ ...input, policy: revoked }).allowed, false);
});


test('all channel mandates bind trusted owners, source revision and current allowlist', async () => {
  const config = { enabled: true, ownerIds: ['owner'], chatIds: ['chat'], admissionMode: 'manual', enabledRuleIds: [] };
  const connections = [{ channel: 'feishu', revision: 0, config: { enabled: false, ownerOpenIds: [], chatIds: [] } }, { channel: 'telegram', revision: 3, config }];
  const store = { connections: { read: () => connections[0], list: () => structuredClone(connections) }, getConfig: async () => ({ models: [] }), documents: { read: async () => ({ hash: 'rules', content: '' }) } };
  const policy = await readAssessmentPolicy(store);
  const input = { policy, candidate: { gate: { allowed: true, strength: 'explicit' } }, trigger: { actor: { id: 'owner', kind: 'human' }, source: { channel: 'telegram', accountId: 'bot', chatId: 'chat', connectionRevision: 3 }, content: 'Work' }, decision: { outcome: 'accept' } };
  const permission = authorizeAssessment(input);
  assert.equal(permission.allowed, true);
  const mandate = { ...permission.mandate, policyVersion: policy.version };
  assert.equal(validateTicketMandate(mandate, { policy }), true);
  assert.equal(authorizeAssessment({ ...input, trigger: { ...input.trigger, actor: { id: 'stranger', kind: 'human', owner: true } } }).allowed, false);
  assert.equal(authorizeAssessment({ ...input, trigger: { ...input.trigger, source: { ...input.trigger.source, connectionRevision: 2 } } }).allowed, false);
  connections[1].revision++;
  config.ownerIds = [];
  assert.equal(validateTicketMandate(mandate, { policy: await readAssessmentPolicy(store) }), false);
});
