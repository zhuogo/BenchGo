import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { installWorkerPermissionGate } from '../src/worker-permissions.mjs';

test('desktop tools ignore channel revisions but stop on desktop authority changes', async () => {
  let wrapper, desktopVersion = 'd1', version = 'f1', changeDesktop = false;
  installWorkerPermissionGate({ on(_name, fn) { wrapper = fn; } }, {
    database: { getTicket: () => ({ mandate: { source: { channel: 'desktop' } } }), appliedTicketSnapshot: () => ({}), renewAssignment: (_id, args) => ({ allowed: args.validateMandate() }) },
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
  installWorkerPermissionGate({ on(name, fn) { if (name === 'tools/execute') wrapper = fn; } }, {
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
    database: { getTicket: () => ({ mandate: {} }), appliedTicketSnapshot: () => ({}), renewAssignment: () => { renewed = true; return { allowed: true }; } },
    assignment: { id: 'assignment', ticketId: 'ticket' },
    readPolicy: async () => { if (++reads === 2) controller.abort(new Error('cancelled')); return { version: 1 }; },
    authorizeAction: async () => ({ allowed: true }),
  });
  await assert.rejects(wrapper({ signal: controller.signal }, () => { dispatched = true; }), /cancelled/);
  assert.equal(renewed, false);
  assert.equal(dispatched, false);
});

for (const nested of [false, true]) test(`interrupted continuation mechanically blocks completed action replay (nested=${nested})`, async () => {
  let wrapper, dispatches = 0;
  const prior = nested ? [
    { type: 'tool/ptc-dispatch-start', data: { subCallId: 'sent', name: 'opaque_send', arguments: { body: 'already completed' } } },
    { type: 'tool/ptc-dispatch', data: { subCallId: 'sent', name: 'opaque_send', content: [] } },
  ] : [
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'sent', name: 'opaque_send', arguments: '{"body":"already completed"}' }] } } },
    { type: 'tool/result', data: { message: { toolCallId: 'sent', content: [] } } },
  ];
  installWorkerPermissionGate({ on(_name, fn) { wrapper = fn; } }, {
    database: { getTicket: () => ({ mandate: {} }), appliedTicketSnapshot: () => ({}), renewAssignment: (_id, args) => ({ allowed: args.validateMandate() }) },
    assignment: { id: 'original', ticketId: 'ticket', interruptedContinuation: { runId: 'same-run' } },
    priorToolEvents: prior, readPolicy: async () => ({ version: 'current' }), authorizeAction: async () => ({ allowed: true }),
  });
  const signal = new AbortController().signal;
  await assert.rejects(wrapper({ name: 'opaque_send', arguments: { body: 'already completed' }, signal }, () => dispatches++), { code: 'ACTION_REPLAY_BLOCKED' });
  await wrapper({ name: 'read', arguments: { path: 'result' }, signal }, () => dispatches++);
  assert.equal(dispatches, 1);
});

for (const failed of [false, true]) test(`unknown previous effects block changed parameters and different actions during continuation (failed=${failed})`, async () => {
  let wrapper, dispatches = 0;
  const events = [{ type: 'assistant/message', data: { message: { content: [
    { type: 'tool-call', id: 'old-send', name: 'opaque_send', arguments: '{"recipient":"owner","body":"first"}' },
  ] } } }];
  if (failed) events.push({ type: 'tool/result', data: { message: { toolCallId: 'old-send', isError: true, content: [] }, error: { code: 'TIMEOUT' } } });
  installWorkerPermissionGate({ on(_name, fn) { wrapper = fn; } }, {
    database: { getTicket: () => ({ mandate: {} }), appliedTicketSnapshot: () => ({}), renewAssignment: (_id, args) => ({ allowed: args.validateMandate() }) },
    assignment: { id: 'original', ticketId: 'ticket', interruptedContinuation: { runId: 'original-run' } },
    priorToolEvents: events, readPolicy: async () => ({ version: 'current' }), authorizeAction: async () => ({ allowed: true }),
  });
  const signal = new AbortController().signal, dispatch = () => { dispatches++; };
  await assert.rejects(wrapper({ name: 'opaque_send', arguments: { recipient: 'owner', body: 'changed' }, signal }, dispatch), { code: 'EXECUTION_EFFECTS_UNKNOWN' });
  await assert.rejects(wrapper({ name: 'different_publish', arguments: { body: 'changed again' }, signal }, dispatch), { code: 'EXECUTION_EFFECTS_UNKNOWN' });
  await wrapper({ name: 'web_fetch', arguments: { url: 'https://source.invalid' }, signal }, dispatch);
  assert.equal(dispatches, 1);
});

test('batch snapshot keeps ordinary edits stable while live tool narrowing and stop block submission', async () => {
  const hooks = new Map(); let stopped = false, narrowed = false, applied = 1, dispatched = 0;
  const database = {
    getTicket: () => ({ id: 'ticket', status: stopped ? 'waiting' : 'running', executionControl: stopped ? { pauseRequested: true } : {}, instructionRevision: 2, target: 'new target', mandate: { scope: { toolNames: narrowed ? ['read'] : ['read', 'write'] } } }),
    appliedTicketSnapshot: () => ({ instructionRevision: applied, target: applied === 1 ? 'old target' : 'new target', authorizationVersion: 1, mandate: {}, toolScope: ['read', 'write'] }),
    renewAssignment: (_id, args) => ({ allowed: args.validateMandate() }),
  };
  const observed = [];
  installWorkerPermissionGate({ on: (event, fn) => hooks.set(event, fn) }, { database, assignment: { id: 'assignment', ticketId: 'ticket' }, readPolicy: async () => ({ version: 1 }), authorizeAction: async ({ ticket }) => { observed.push([ticket.instructionRevision, ticket.target]); return { allowed: true }; } });
  const execution = { name: 'write', signal: new AbortController().signal };
  await hooks.get('tools/execute')(execution, () => dispatched++);
  assert.deepEqual(observed, [[1, 'old target']]);
  applied = 2; await hooks.get('tools/execute')(execution, () => dispatched++);
  assert.deepEqual(observed[1], [2, 'new target']);
  narrowed = true;
  assert.throws(() => hooks.get('tools/pre-execute')(execution, () => assert.fail('narrowed dispatch')), { code: 'WORKER_TOOL_SCOPE' });
  stopped = true;
  await assert.rejects(hooks.get('tools/execute')({ ...execution, name: 'read' }, () => assert.fail('stopped dispatch')), { code: 'WORKER_TICKET_INACTIVE' });
  assert.equal(dispatched, 2);
});

 test('resumed permissions reuse the saved official deterministic error receipt', async () => {
  let wrapper, dispatched = false;
  installWorkerPermissionGate({ on(_name, fn) { wrapper = fn; } }, {
    database: { getTicket: () => ({ mandate: {} }), appliedTicketSnapshot: () => ({}), renewAssignment: (_id, args) => ({ allowed: args.validateMandate() }) },
    assignment: { id: 'original', ticketId: 'ticket' },
    priorToolEvents: [{ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'bad', name: 'missing_tool', arguments: '{}' }] } } },
      { type: 'tool/result', data: { message: { toolCallId: 'bad', isError: true, content: [] } } }],
    toolReceipts: new Map([['bad', { code: 'UNKNOWN_TOOL' }]]),
    readPolicy: async () => ({ version: 'current' }), authorizeAction: async () => ({ allowed: true }),
  });
  await wrapper({ name: 'write', arguments: {}, signal: new AbortController().signal }, () => { dispatched = true; });
  assert.equal(dispatched, true);
});
