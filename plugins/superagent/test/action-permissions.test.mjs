import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActionPermissionStore, exactActionOrigin } from '../src/action-permissions.mjs';
import { createExternalActionRegistry, createExternalActionService, createActionPermissionApi, createExternalActionHost, registerChannelExternalActions } from '../src/external-actions.mjs';

const actor = { profileId: 'profile', id: 'desktop-owner', label: '主人' };
const context = () => ({ profileId: 'profile', actorId: actor.id, ticketId: 'ticket', assignmentId: 'assignment', runId: 'run', authorizationVersion: 'a1', policyVersion: 'p1', principal: { kind: 'owner' } });
const exec = () => ({ signal: new AbortController().signal, callId: 'call', agent: {} });
const open = t => { const store = createActionPermissionStore({ filename: ':memory:', profileId: 'profile' }); t.after(() => store.close()); return store; };
const prepared = { origin: 'https://example.test', target: { recipient: 'person-1' }, content: { text: '完整正文' }, submission: { to: 'person-1', text: '完整正文' } };

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
  registry.register({ id: 'send', category: 'external-send', prepare: async () => prepared, submit: async action => { sends++; assert.equal(Object.isFrozen(action.content), true); return { status: 'accepted', receiptId: 'receipt' }; } });
  const options = { store, registry, getContext: async () => context(), requestApproval: async ({ action }) => { asks++; assert.deepEqual(action.content, prepared.content); assert.equal(action.submission, undefined); return 'allowed-once'; } };
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
  registry.register({ id: 'send', category: 'external-send', prepare: () => prepared, submit: () => sends++ });
  const action = await service.prepare({ adapterId: 'send', input: { authorized: true }, requestId: 'send' }, exec());
  assert.equal((await service.submit({ actionId: action.id }, exec())).state, 'denied'); assert.equal(sends, 0);
});

test('regular site action reuses grant but final revoke and current Mandate stop submission', async t => {
  const store = open(t), registry = createExternalActionRegistry(); let sends = 0, revoked = false;
  const grant = store.grantSite({ requestId: 'grant', origin: prepared.origin, categories: ['login'], expiresAt: new Date(Date.now() + 60000).toISOString() }, actor);
  registry.register({ id: 'login', category: 'login', prepare: () => prepared, validate: () => { store.revoke({ requestId: 'revoke', id: grant.id }, actor); revoked = true; }, submit: () => sends++ });
  const service = createExternalActionService({ store, registry, getContext: async () => context(), requestApproval: async () => assert.fail('valid grant repeats approval') });
  const action = await service.prepare({ adapterId: 'login', input: {}, requestId: 'login' }, exec());
  await assert.rejects(service.submit({ actionId: action.id }, exec()), { code: 'ACTION_GRANT_REVOKED' });
  assert.equal(revoked, true); assert.equal(sends, 0);
});

test('authority narrowing while approval awaits blocks commit; thrown/unknown effects never auto replay', async t => {
  const store = open(t), registry = createExternalActionRegistry(); let authority = 'a1', sends = 0;
  registry.register({ id: 'send', category: 'external-send', prepare: () => prepared, submit: () => { sends++; throw new Error('opaque private response'); } });
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
  let sends = 0, asks = 0, status = 'open', revision = 1;
  const mandate = { policyVersion: 'p1', actorId: 'desktop-owner', admission: 'desktop-approved-delegation', controlledActions: 'require-current-policy-and-harness-approval', source: { channel: 'desktop', sessionId: 'router', messageId: 'instruction' } };
  const database = {
    getTicket: () => ({ id: 'ticket', status, mandate }),
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
  createExternalActionHost({ ctx: {}, store, registry }).installWorker(scope, agent, {
    database, assignment: { id: 'assignment', ticketId: 'ticket', owner: 'worker', fence: 1 }, run: { id: 'run', sessionId: 'session' }, readPolicy: async () => ({ desktopVersion: 'p1' }), authorizeAction: async () => ({ allowed: true }),
  });
  const tool = tools.get('assistant_external_action'), execution = { agent, name: tool.name, signal: new AbortController().signal, callId: 'call', authorized: true };
  const first = await tool.execute({ operation: 'prepare', adapterId: 'channel:test:send', input: { targetTriggerId: 'real-trigger', text: '完整正文' }, requestId: 'first' }, execution);
  assert.equal((await tool.execute({ operation: 'submit', actionId: first.id }, execution)).state, 'completed');
  assert.equal(sends, 1); assert.equal(asks, 1);
  const next = await tool.execute({ operation: 'prepare', adapterId: 'channel:test:send', input: { targetTriggerId: 'real-trigger', text: '完整正文' }, requestId: 'next' }, execution);
  revision++;
  await assert.rejects(tool.execute({ operation: 'submit', actionId: next.id }, execution), { code: 'ACTION_CONTENT_CHANGED' });
  status = 'pausing';
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
  registry.register({ id: 'send', category: 'external-send', prepare: () => prepared, submit: () => assert.fail('crash replay') });
  const service = createExternalActionService({ store, registry, getContext: async () => context(), requestApproval: async () => assert.fail('reapprove unknown effect') });
  assert.equal((await service.submit({ actionId: action.id }, exec())).requiresReconciliation, true);
});
