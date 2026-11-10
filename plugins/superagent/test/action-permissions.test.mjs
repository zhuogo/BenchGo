import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActionPermissionStore, exactActionOrigin } from '../src/action-permissions.mjs';
import { createExternalActionRegistry, createExternalActionService, createActionPermissionApi, createExternalActionHost, registerChannelExternalActions } from '../src/external-actions.mjs';
import { prepareChannelExternalSend } from '../src/channel-policy.mjs';
import { executionEffects } from '../src/execution-effects.mjs';

const actor = { profileId: 'profile', id: 'desktop-owner', label: '主人' };
const context = () => ({ profileId: 'profile', actorId: actor.id, ticketId: 'ticket', assignmentId: 'assignment', runId: 'run', authorizationVersion: 'a1', policyVersion: 'p1', principal: { kind: 'owner' } });
const exec = () => ({ signal: new AbortController().signal, callId: 'call', agent: {} });
const open = t => { const store = createActionPermissionStore({ filename: ':memory:', profileId: 'profile' }); t.after(() => store.close()); return store; };
const prepared = { origin: 'https://example.test', target: { recipient: 'person-1' }, content: { text: '完整正文' }, submission: { to: 'person-1', text: '完整正文' } };
const inputSchema = { type: 'object', properties: {}, additionalProperties: true };

test('site grants persist by exact origin, real actor and profile, expire and revoke idempotently', t => {
  const directory = mkdtempSync(join(tmpdir(), 'benchgo-action-')); let now = Date.now();
  let store = createActionPermissionStore({ directory, profileId: 'profile', now: () => now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const input = { requestId: 'grant', origin: 'https://example.test:443', categories: ['login'], expiresAt: new Date(now + 60000).toISOString() };
  const grant = store.grantSite(input, actor);
  assert.equal(store.grantSite(input, actor).id, grant.id);
  assert.equal(grant.origin, 'https://example.test');
  assert.equal(store.matchSite({ origin: 'https://sub.example.test', category: 'login' }, actor), null);
  assert.equal(store.matchSite({ origin: 'http://example.test', category: 'login' }, actor), null);
  assert.equal(store.matchSite({ origin: 'https://example.test:444', category: 'login' }, actor), null);
  assert.equal(store.matchSite({ origin: 'https://example.test', category: 'private-upload' }, actor), null);
  assert.equal(store.matchSite({ origin: 'https://example.test', category: 'login' }, { ...actor, id: 'channel-user' }), null);
  assert.throws(() => store.list({ ...actor, profileId: 'other' }), { code: 'ACTION_PROFILE_MISMATCH' });
  store.close(); store = createActionPermissionStore({ directory, profileId: 'profile', now: () => now });
  assert.equal(store.matchSite({ origin: grant.origin, category: 'login' }, actor).id, grant.id);
  now += 60001;
  assert.equal(store.matchSite({ origin: grant.origin, category: 'login' }, actor), null);
  store.revoke({ id: grant.id, requestId: 'revoke' }, actor); store.revoke({ id: grant.id, requestId: 'revoke' }, actor);
  assert.equal(store.list(actor).audit.filter(row => row.phase === 'grant-revoked').length, 1);
});

test('persistent grants reject high risk, wildcard, path and reused changed requests', t => {
  const store = open(t), input = { requestId: 'grant', origin: 'https://example.test', categories: ['login'], expiresAt: new Date(Date.now() + 60000).toISOString() };
  for (const category of ['payment', 'password-change', 'account-delete', 'external-send', '*']) assert.throws(() => store.grantSite({ ...input, categories: [category] }, actor), { code: 'ACTION_GRANT_INVALID' });
  for (const origin of ['https://*.example.test', 'https://example.test/path', 'https://user:password@example.test', 'https://example.test?token=x']) assert.throws(() => exactActionOrigin(origin), { code: 'ACTION_ORIGIN_INVALID' });
  store.grantSite(input, actor);
  assert.throws(() => store.grantSite({ ...input, categories: ['private-upload'] }, actor), { code: 'ACTION_IDEMPOTENCY_CONFLICT' });
});

test('frozen action binds final content, actor, Mandate, run and once-only consumption', t => {
  const store = open(t), input = { requestId: 'send', adapterId: 'send', category: 'external-send', ...prepared };
  const action = store.prepare(input, context());
  assert.equal(store.prepare(input, context()).id, action.id);
  assert.throws(() => store.prepare({ ...input, content: { text: 'changed' } }, context()), { code: 'ACTION_IDEMPOTENCY_CONFLICT' });
  assert.throws(() => store.decide(action.id, true, { ...context(), authorizationVersion: 'a2' }, actor), { code: 'ACTION_BINDING_CHANGED' });
  assert.throws(() => store.decide(action.id, true, context(), { ...actor, id: 'other' }), { code: 'ACTION_ACTOR_MISMATCH' });
  store.decide(action.id, true, context(), actor); store.decide(action.id, true, context(), actor);
  store.consume(action.id, context());
  assert.throws(() => store.consume(action.id, context()), { code: 'ACTION_ONCE_REQUIRED' });
  store.settle(action.id, { uncertain: true });
  assert.equal(store.get(action.id).state, 'uncertain');
  assert.equal(store.list(actor).audit.filter(row => row.phase === 'approved').length, 1);
  assert.equal(JSON.stringify(store.list(actor).audit).includes('完整正文'), false);
});

test('registered high-risk submit requests official once approval and concurrent/restart retries cannot duplicate', async t => {
  const store = open(t), registry = createExternalActionRegistry(); let sends = 0, asks = 0;
  registry.register({ id: 'send', category: 'external-send', inputSchema, prepare: async () => prepared, submit: async action => { sends++; assert.equal(Object.isFrozen(action.content), true); return { status: 'accepted', receiptId: 'receipt' }; } });
  const options = { store, registry, getContext: async () => context(), requestApproval: async ({ action, reason }) => {
    asks++; assert.deepEqual(action.content, prepared.content); assert.equal(action.submission, undefined);
    assert.deepEqual(JSON.parse(reason.slice(reason.indexOf('\n') + 1)), { actionId: action.id, category: action.category, origin: action.origin, target: action.target, content: action.content });
    return 'allowed-once';
  } };
  let service = createExternalActionService(options);
  const action = await service.prepare({ adapterId: 'send', input: {}, requestId: 'send' }, exec());
  const results = await Promise.all([service.submit({ actionId: action.id }, exec()), service.submit({ actionId: action.id }, exec())]);
  assert.equal(results[0].state, 'completed'); assert.equal(sends, 1); assert.equal(asks, 1);
  service = createExternalActionService(options);
  assert.equal((await service.submit({ actionId: action.id }, exec())).state, 'completed'); assert.equal(sends, 1);
});

test('no registered payment means handoff; fake authorized/always approval never grants a high-risk action', async t => {
  const store = open(t), registry = createExternalActionRegistry(); let sends = 0;
  const service = createExternalActionService({ store, registry, getContext: async () => context(), requestApproval: async () => 'allowed-always' });
  assert.equal((await service.prepare({ adapterId: 'payment', input: { authorized: true }, requestId: 'pay' }, exec())).state, 'handoff');
  registry.register({ id: 'send', category: 'external-send', inputSchema, prepare: () => prepared, submit: () => sends++ });
  const action = await service.prepare({ adapterId: 'send', input: { authorized: true }, requestId: 'send' }, exec());
  assert.equal((await service.submit({ actionId: action.id }, exec())).state, 'denied'); assert.equal(sends, 0);
});

test('regular site action reuses grant but final revoke and current Mandate stop submission', async t => {
  const store = open(t), registry = createExternalActionRegistry(); let sends = 0, revoked = false;
  const grant = store.grantSite({ requestId: 'grant', origin: prepared.origin, categories: ['login'], expiresAt: new Date(Date.now() + 60000).toISOString() }, actor);
  registry.register({ id: 'login', category: 'login', inputSchema, prepare: () => prepared, validate: () => { store.revoke({ requestId: 'revoke', id: grant.id }, actor); revoked = true; }, submit: () => sends++ });
  const service = createExternalActionService({ store, registry, getContext: async () => context(), requestApproval: async () => assert.fail('valid grant repeats approval') });
  const action = await service.prepare({ adapterId: 'login', input: {}, requestId: 'login' }, exec());
  await assert.rejects(service.submit({ actionId: action.id }, exec()), { code: 'ACTION_GRANT_REVOKED' });
  assert.equal(revoked, true); assert.equal(sends, 0);
});

test('authority narrowing while approval awaits blocks commit; thrown/unknown effects never auto replay', async t => {
  const store = open(t), registry = createExternalActionRegistry(); let authority = 'a1', sends = 0;
  registry.register({ id: 'send', category: 'external-send', inputSchema, prepare: () => prepared, submit: () => { sends++; throw new Error('opaque private response'); } });
  let service = createExternalActionService({ store, registry, getContext: async () => ({ ...context(), authorizationVersion: authority }), requestApproval: async () => { authority = 'a2'; return 'allowed-once'; } });
  const action = await service.prepare({ adapterId: 'send', input: {}, requestId: 'first' }, exec());
  await assert.rejects(service.submit({ actionId: action.id }, exec()), { code: 'ACTION_BINDING_CHANGED' }); assert.equal(sends, 0);
  service = createExternalActionService({ store, registry, getContext: async () => ({ ...context(), authorizationVersion: authority }), requestApproval: async () => 'allowed-once' });
  const next = await service.prepare({ adapterId: 'send', input: {}, requestId: 'next' }, exec());
  assert.equal((await service.submit({ actionId: next.id }, exec())).state, 'uncertain');
  assert.equal((await service.submit({ actionId: next.id }, exec())).requiresReconciliation, true); assert.equal(sends, 1);
  assert.equal(JSON.stringify(store.list(actor)).includes('opaque private response'), false);
});

test('management API takes only authenticated host identity, not payload identity', async t => {
  const store = open(t), api = createActionPermissionApi({ store, resolveActor: async peer => peer?.principal?.kind === 'owner' ? actor : null });
  await assert.rejects(api({ action: 'actionPermissions', human: true, actor }, {}), { code: 'ACTION_OWNER_REQUIRED' });
  const grant = await api({ action: 'actionPermissionCreate', origin: prepared.origin, categories: ['login'], expiresAt: new Date(Date.now() + 60000).toISOString(), requestId: 'grant', actor: { id: 'fake' } }, { principal: { kind: 'owner' } });
  assert.equal(grant.actor.id, actor.id);
});

test('scoped host tool combines actual Worker, current mandate, official card and trusted channel target', async t => {
  const store = open(t), registry = createExternalActionRegistry(), agent = { id: 'session', session: { id: 'session' } }, tools = new Map();
  let sends = 0, asks = 0, status = 'running', executionControl = {}, revision = 1;
  const reminders = [], warnings = [];
  const mandate = { policyVersion: 'p1', actorId: 'desktop-owner', admission: 'desktop-approved-delegation', controlledActions: 'require-current-policy-and-harness-approval', source: { channel: 'desktop', sessionId: 'router', messageId: 'instruction' } };
  const database = {
    getTicket: () => ({ id: 'ticket', status, executionControl, mandate }),
    getAssignment: () => ({ state: 'claimed', owner: 'worker', fence: 1 }),
    runs: () => [{ id: 'run', owner: 'worker', fence: 1, sessionId: 'session', state: 'running' }],
    renewAssignment: (_id, input) => ({ allowed: input.validateMandate(mandate) }),
  };
  const adapter = {
    capabilities: { externalActions: ['external-send'] },
    prepareExternalSend: (input, { principal }) => { assert.equal(principal.kind, 'owner'); return { origin: null, target: { channel: 'test', conversationId: 'real', revision }, content: { text: input.text }, submission: { input, source: { channel: 'test', conversationId: 'real', revision }, text: input.text } }; },
    send: input => { sends++; assert.equal(input.source.conversationId, 'real'); return { status: 'accepted', messageId: 'message' }; },
  };
  registerChannelExternalActions(registry, { channelIds: ['test'], getAdapter: () => adapter });
  const scope = { tools: { register: tool => tools.set(tool.name, tool) }, get: () => ({ request: async request => { asks++; assert.equal(request.agent, agent); assert.equal(request.toolName, 'assistant_external_action'); assert.match(request.reason, /完整正文/); return 'allowed-once'; } }) };
  createExternalActionHost({ ctx: { logger: { warn: value => warnings.push(value) } }, store, registry, onApprovalPending: input => {
    assert.ok(asks > reminders.length, 'the official approval request starts before a reminder callback');
    reminders.push(input); throw Object.assign(new Error('PRIVATE REMINDER FAILURE'), { code: 'TEST_REMINDER_FAILED' });
  } }).installWorker(scope, agent, {
    database, assignment: { id: 'assignment', ticketId: 'ticket', owner: 'worker', fence: 1 }, run: { id: 'run', sessionId: 'session' }, readPolicy: async () => ({ desktopVersion: 'p1' }), authorizeAction: async () => ({ allowed: true }),
  });
  const tool = tools.get('assistant_external_action'), execution = { agent, name: tool.name, signal: new AbortController().signal, callId: 'call', authorized: true };
  const first = await tool.execute({ operation: 'prepare', adapterId: 'channel:test:send', input: { targetTriggerId: 'real-trigger', text: '完整正文' }, requestId: 'first' }, execution);
  assert.equal((await tool.execute({ operation: 'submit', actionId: first.id }, execution)).state, 'completed');
  assert.equal(sends, 1); assert.equal(asks, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reminders, [{ assignmentId: 'assignment', runId: 'run', sessionId: 'session', callId: 'call', actionId: first.id }]);
  assert.equal(warnings.length, 1, 'a failed async reminder never changes the approval or submission result');
  assert.doesNotMatch(warnings[0], /PRIVATE REMINDER FAILURE/);
  const next = await tool.execute({ operation: 'prepare', adapterId: 'channel:test:send', input: { targetTriggerId: 'real-trigger', text: '完整正文' }, requestId: 'next' }, execution);
  revision++;
  await assert.rejects(tool.execute({ operation: 'submit', actionId: next.id }, execution), { code: 'ACTION_CONTENT_CHANGED' });
  status = 'waiting'; executionControl = { pauseRequested: true };
  await assert.rejects(tool.execute({ operation: 'submit', actionId: next.id }, execution), { code: 'WORKER_TICKET_INACTIVE' });
  assert.equal(sends, 1);
  await assert.rejects(tool.execute({ operation: 'catalog' }, { ...execution, agent: { ...agent } }), { code: 'ACTION_AGENT_MISMATCH' });
});

test('channel registration requires an explicit external-send declaration, never a send function alone', async t => {
  const store = open(t), registry = createExternalActionRegistry();
  const adapter = { prepareExternalSend: () => prepared, send: () => assert.fail('undeclared external send') };
  registerChannelExternalActions(registry, { channelIds: ['undeclared'], getAdapter: () => adapter });
  assert.deepEqual(registry.catalog(), []);
  registerChannelExternalActions(registry, { channelIds: ['pull'], getAdapter: () => ({ ...adapter, capabilities: { externalActions: [] } }) });
  assert.deepEqual(registry.catalog(), []);
  const service = createExternalActionService({ store, registry, getContext: async () => context(), requestApproval: async () => assert.fail('undeclared adapter approval') });
  assert.equal((await service.prepare({ adapterId: 'channel:undeclared:send', input: {}, requestId: 'undeclared' }, exec())).state, 'handoff');
  const dispose = registerChannelExternalActions(registry, { channelIds: ['declared'], getAdapter: () => adapter, getCapabilities: () => ({ externalActions: ['external-send'] }) });
  assert.deepEqual(registry.catalog().map(row => row.id), ['channel:declared:send']);
  dispose(); assert.deepEqual(registry.catalog(), []);
});

test('a crash after durable submission cannot restore approved permission or replay the request', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'benchgo-action-restart-'));
  let store = createActionPermissionStore({ directory, profileId: 'profile' });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const input = { requestId: 'frozen', adapterId: 'send', category: 'external-send', ...prepared };
  const action = store.prepare(input, context());
  store.decide(action.id, true, context(), actor); store.consume(action.id, context());
  store.close(); store = createActionPermissionStore({ directory, profileId: 'profile' });
  assert.equal(store.prepare(input, context()).state, 'submitted');
  assert.throws(() => store.consume(action.id, context()), { code: 'ACTION_ONCE_REQUIRED' });
  const registry = createExternalActionRegistry();
  registry.register({ id: 'send', category: 'external-send', inputSchema, prepare: () => prepared, submit: () => assert.fail('crash replay') });
  const service = createExternalActionService({ store, registry, getContext: async () => context(), requestApproval: async () => assert.fail('reapprove unknown effect') });
  assert.equal((await service.submit({ actionId: action.id }, exec())).requiresReconciliation, true);
});

test('registered action catalog publishes an immutable input contract and rejects missing contracts', () => {
  const registry = createExternalActionRegistry();
  const adapter = { id: 'send', category: 'external-send', prepare: () => prepared, submit: () => assert.fail('catalog must not submit') };
  assert.throws(() => registry.register(adapter), /inputSchema/);
  const schema = { type: 'object', properties: { recipient: { type: 'string' } }, required: ['recipient'], additionalProperties: false };
  registry.register({ ...adapter, inputSchema: schema });
  schema.required.push('invented');
  const first = registry.catalog()[0];
  assert.deepEqual(first.inputSchema.required, ['recipient']);
  first.inputSchema.properties.recipient.type = 'number';
  assert.equal(registry.catalog()[0].inputSchema.properties.recipient.type, 'string');
});

test('a channel action can be prepared from catalog contract alone, with actionable errors before side effects', async t => {
  const store = open(t), registry = createExternalActionRegistry();
  const source = { channel: 'test', sourceType: 'direct', conversationId: 'chat', chatId: 'chat', appId: 'bot', connectionId: 'test', connectionRevision: 1 };
  let reads = 0;
  const adapter = {
    capabilities: { externalActions: ['external-send'] },
    prepareExternalSend: (input, options) => prepareChannelExternalSend(() => ({ revision: 1, config: { enabled: true, appId: 'bot' } }), id => { reads++; return id === 'trigger:trusted-trigger' ? { source } : null; }, 'test', input, options),
    send: () => assert.fail('prepare/catalog must never send'),
  };
  registerChannelExternalActions(registry, { channelIds: ['test'], getAdapter: () => adapter });
  const service = createExternalActionService({ store, registry, getContext: async () => context(), requestApproval: () => assert.fail('prepare must never approve') });
  const entry = service.catalog().adapters[0];
  assert.deepEqual(entry.inputSchema.required, ['targetTriggerId', 'text']);
  assert.equal(entry.inputSchema.additionalProperties, false);
  for (const input of [{ sourceRef: 'trusted-trigger', content: '正文' }, { targetTriggerId: 'trusted-trigger', text: '正文', source: source }, { targetTriggerId: '', text: '正文' }, { targetTriggerId: 'trusted-trigger', text: ' ' }]) {
    await assert.rejects(service.prepare({ adapterId: entry.id, requestId: 'invalid', input }, exec()), error => error.code === 'ACTION_INPUT_INVALID' && /targetTriggerId/.test(error.message) && /text/.test(error.message));
  }
  assert.equal(reads, 0);
  assert.equal(store.list(actor).audit.length, 0);
  await assert.rejects(service.prepare({ adapterId: entry.id, requestId: 'missing-prefix', input: { targetTriggerId: 'trusted-trigger', text: '完整正文' } }, exec()),
    error => error.code === 'ACTION_TARGET_NOT_FOUND' && /完整原始 ID/.test(error.message) && /不由保险库登记/.test(error.message));
  assert.equal(store.list(actor).audit.length, 0, 'a missing target creates no action or approval');
  const values = { targetTriggerId: 'trigger:trusted-trigger', text: '完整正文' };
  const input = Object.fromEntries(entry.inputSchema.required.map(key => [key, values[key]]));
  const action = await service.prepare({ adapterId: entry.id, requestId: 'valid', input }, exec());
  assert.equal(action.state, 'pending');
  assert.equal(action.content.text, '完整正文');
  assert.equal(action.target.conversationId, 'chat');
  assert.equal(reads, 2);
});

test('the real action service uncertain receipt blocks result delivery despite successful tool transport', async t => {
  const store = open(t), registry = createExternalActionRegistry();
  registry.register({ id: 'send', category: 'external-send', inputSchema, prepare: () => prepared,
    submit: async () => { throw new Error('provider disconnected after submission'); } });
  const service = createExternalActionService({ store, registry, getContext: async () => context(), requestApproval: async () => 'allowed-once' });
  const action = await service.prepare({ adapterId: 'send', input: {}, requestId: 'unknown-receipt' }, exec());
  const returned = await service.submit({ actionId: action.id }, exec());
  assert.equal(returned.state, 'uncertain');
  assert.deepEqual(executionEffects({ events: [
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'submit', name: 'assistant_external_action', arguments: JSON.stringify({ operation: 'submit', actionId: action.id }) }] } } },
    { type: 'tool/result', data: { message: { toolCallId: 'submit', isError: false, content: [{ type: 'text', text: JSON.stringify(returned) }] } } },
  ] }), { effectsVerified: false, unknownCallIds: ['submit'] });
});

test('aborting an approval wait cannot consume the action or submit even if a late approval returns', async t => {
  const store = open(t), registry = createExternalActionRegistry(), controller = new AbortController();
  registry.register({ id: 'send', category: 'external-send', inputSchema, prepare: () => prepared, submit: () => assert.fail('stopped worker must never send') });
  const service = createExternalActionService({ store, registry, getContext: async () => context(), requestApproval: async () => { controller.abort(); return 'allowed-once'; } });
  const execution = { ...exec(), signal: controller.signal };
  const action = await service.prepare({ adapterId: 'send', requestId: 'stopped', input: {} }, execution);
  await assert.rejects(service.submit({ actionId: action.id }, execution), { name: 'AbortError' });
  assert.equal(store.get(action.id).state, 'pending');
  assert.equal(store.list(actor).audit.some(row => ['approved', 'submitted', 'completed'].includes(row.phase)), false);
});
