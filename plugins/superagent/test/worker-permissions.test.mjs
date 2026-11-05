import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { installWorkerPermissionGate } from '../src/worker-permissions.mjs';

test('desktop tools ignore channel revisions but stop on desktop authority changes', async () => {
  let wrapper, desktopVersion = 'd1', version = 'f1', changeDesktop = false;
  installWorkerPermissionGate({ on(_name, fn) { wrapper = fn; } }, {
    database: { getTicket: () => ({ mandate: { source: { channel: 'desktop' } } }), renewAssignment: (_id, args) => ({ allowed: args.validateMandate() }) },
    assignment: { id: 'assignment', ticketId: 'ticket' },
    readPolicy: async () => ({ desktopVersion, version }),
    authorizeAction: async () => { version += 'changed'; if (changeDesktop) desktopVersion = 'd2'; return { allowed: true }; },
  });
  const execution = { signal: new AbortController().signal };
  assert.equal(await wrapper(execution, () => 'allowed'), 'allowed');
  changeDesktop = true;
  await assert.rejects(wrapper(execution, () => assert.fail('revoked dispatch')), /权限/);
});

test('each worker action checks live authorization; narrowing during approval prevents dispatch', async t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'thread' } });
  const ticket = database.createTicket({ threadId: 'thread', target: 'work', mandate: { scope: ['read'] } });
  database.createAssignment(ticket.id, { executor: 'harness' });
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  let wrapper, version = 'p1', revoke = false, dispatched = 0, checks = 0;
  installWorkerPermissionGate({ on(name, fn) { assert.equal(name, 'tools/execute'); wrapper = fn; } }, {
    database, assignment, readPolicy: async () => ({ version }),
    authorizeAction: async () => { checks++; if (revoke) version = 'p2'; return { allowed: true }; },
  });
  const execution = { signal: new AbortController().signal, name: 'read' };
  const dispatch = async () => { dispatched++; return 'result'; };
  assert.equal(await wrapper(execution, dispatch), 'result');
  revoke = true;
  await assert.rejects(wrapper(execution, dispatch), /权限/);
  assert.equal(checks, 2);
  assert.equal(dispatched, 1);
  assert.equal(database.assignments(ticket.id)[0].state, 'uncertain');
  await assert.rejects(wrapper(execution, dispatch), { code: 'FENCING_CONFLICT' });
  assert.equal(dispatched, 1);
});

test('cancellation while rereading policy cannot enter tool dispatch', async t => {
  const controller = new AbortController();
  let wrapper, reads = 0, dispatched = false, renewed = false;
  installWorkerPermissionGate({ on(_name, fn) { wrapper = fn; } }, {
    database: { getTicket: () => ({ mandate: {} }), renewAssignment: () => { renewed = true; return { allowed: true }; } },
    assignment: { id: 'assignment', ticketId: 'ticket' },
    readPolicy: async () => { if (++reads === 2) controller.abort(new Error('cancelled')); return { version: 1 }; },
    authorizeAction: async () => ({ allowed: true }),
  });
  await assert.rejects(wrapper({ signal: controller.signal }, () => { dispatched = true; }), /cancelled/);
  assert.equal(renewed, false);
  assert.equal(dispatched, false);
});

test('checkpoint IO precedes final authorization and revoked tools never dispatch', async () => {
  let wrapper, version = 1, backup = 0, dispatched = 0;
  installWorkerPermissionGate({ on(_name, fn) { wrapper = fn; } }, {
    database: { getTicket: () => ({ mandate: {} }), renewAssignment: (_id, args) => ({ allowed: args.validateMandate() }) },
    assignment: { id: 'assignment', ticketId: 'ticket' },
    readPolicy: async () => ({ version }), authorizeAction: async () => ({ allowed: true }),
    withCheckpoint: async (_execution, dispatch) => { backup++; version++; return dispatch(); },
  });
  await assert.rejects(wrapper({ signal: new AbortController().signal }, () => { dispatched++; }));
  assert.equal(backup, 1); assert.equal(dispatched, 0);
});

test('review continuation blocks repeated dispatched effects but permits a distinct authorized correction', async () => {
  let wrapper, dispatches = 0;
  const scope = { on(_name, fn) { wrapper = fn; } };
  installWorkerPermissionGate(scope, {
    database: { getTicket: () => ({ mandate: {} }), renewAssignment: (_id, args) => ({ allowed: args.validateMandate() }) },
    assignment: { id: 'same-assignment', ticketId: 'same-ticket', reviewContinuation: { runId: 'same-run' } },
    priorToolEvents: [{ type: 'assistant/message', data: { message: { content: [
      { type: 'tool-call', id: 'published', name: 'publish', arguments: '{"recipient":"owner","body":"original"}' },
      { type: 'tool-call', id: 'read', name: 'web_fetch', arguments: '{"url":"https://source.invalid"}' },
    ] } } }, { type: 'tool/result', data: { message: { toolCallId: 'published', content: [] } } }],
    readPolicy: async () => ({ version: 'current' }), authorizeAction: async () => ({ allowed: true }),
  });
  const execution = (name, args) => ({ name, arguments: args, signal: new AbortController().signal });
  const dispatch = () => { dispatches++; return 'allowed'; };
  await assert.rejects(wrapper(execution('publish', { body: 'original', recipient: 'owner' }), dispatch), { code: 'ACTION_REPLAY_BLOCKED' });
  assert.equal(dispatches, 0);
  assert.equal(await wrapper(execution('web_fetch', { url: 'https://source.invalid' }), dispatch), 'allowed');
  assert.equal(await wrapper(execution('edit', { path: 'existing.md', replacement: 'corrected' }), dispatch), 'allowed');
  assert.equal(dispatches, 2);
});

test('budget continuation blocks replay of a completed action while permitting fresh authorized correction', async () => {
  let wrapper, dispatches = 0;
  installWorkerPermissionGate({ on(_name, fn) { wrapper = fn; } }, {
    database: { getTicket: () => ({ mandate: {} }), renewAssignment: (_id, args) => ({ allowed: args.validateMandate() }) },
    assignment: { id: 'original', ticketId: 'ticket', pauseContinuation: { kind: 'execution-budget', runId: 'original-run' } },
    priorToolEvents: [{ type: 'assistant/message', data: { message: { content: [
      { type: 'tool-call', id: 'sent', name: 'opaque_send', arguments: '{"body":"already completed"}' },
    ] } } }, { type: 'tool/result', data: { message: { toolCallId: 'sent', content: [] } } }],
    readPolicy: async () => ({ version: 'current' }), authorizeAction: async () => ({ allowed: true }),
  });
  const signal = new AbortController().signal;
  await assert.rejects(wrapper({ name: 'opaque_send', arguments: { body: 'already completed' }, signal }, () => dispatches++), { code: 'ACTION_REPLAY_BLOCKED' });
  await wrapper({ name: 'web_fetch', arguments: { url: 'https://source.invalid' }, signal }, () => dispatches++);
  assert.equal(dispatches, 1);
});

for (const failed of [false, true]) test(`unknown previous effects block changed parameters and different actions during review (failed=${failed})`, async () => {
  let wrapper, dispatches = 0;
  const events = [{ type: 'assistant/message', data: { message: { content: [
    { type: 'tool-call', id: 'old-send', name: 'opaque_send', arguments: '{"recipient":"owner","body":"first"}' },
  ] } } }];
  if (failed) events.push({ type: 'tool/result', data: { message: { toolCallId: 'old-send', isError: true, content: [] }, error: { code: 'TIMEOUT' } } });
  installWorkerPermissionGate({ on(_name, fn) { wrapper = fn; } }, {
    database: { getTicket: () => ({ mandate: {} }), renewAssignment: (_id, args) => ({ allowed: args.validateMandate() }) },
    assignment: { id: 'original', ticketId: 'ticket', reviewContinuation: { runId: 'original-run' } },
    priorToolEvents: events, readPolicy: async () => ({ version: 'current' }), authorizeAction: async () => ({ allowed: true }),
  });
  const signal = new AbortController().signal, dispatch = () => { dispatches++; };
  await assert.rejects(wrapper({ name: 'opaque_send', arguments: { recipient: 'owner', body: 'changed' }, signal }, dispatch), { code: 'EXECUTION_EFFECTS_UNKNOWN' });
  await assert.rejects(wrapper({ name: 'different_publish', arguments: { body: 'changed again' }, signal }, dispatch), { code: 'EXECUTION_EFFECTS_UNKNOWN' });
  await wrapper({ name: 'web_fetch', arguments: { url: 'https://source.invalid' }, signal }, dispatch);
  assert.equal(dispatches, 1);
});
