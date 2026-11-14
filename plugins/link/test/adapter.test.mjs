import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionAdapter } from '../src/session/adapter.mjs';

function fixture() {
  const calls = [], eventStreams = [], results = [], peers = [];
  const project = { id: 'project', title: 'Project', path: '/project', sessionIds: ['session'] };
  const opening = { type: 'snapshot', cursor: 7, hasMore: false, projections: { values: {} }, records: [
    { event: { seq: 1, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: 'hello' }] } } },
    { event: { seq: 2, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'answer' }] } } } },
    { event: { seq: 3, type: 'tool/result', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'tool output' }] } } } },
    { event: { seq: 4, type: 'assistant/message', surfaceOp: { op: 'replace' }, data: { message: { content: [{ type: 'text', text: 'hidden replacement' }] } } } },
  ], assistantStream: { activeAttempt: { attemptId: 'attempt', stream: [{ type: 'text-chunks', texts: ['live ', 'output'] }] } } };
  const ctx = {
    get(name) {
      if (name !== 'assistant') return undefined;
      return { dispatch: async (input, peer) => ({ events: input.action === 'notificationSync' ? [{ id: 'event-1', text: '通知' }] : [], deviceId: peer?.principal?.deviceId, action: input.action }) };
    },
    workspaceRegistry: { list: () => [project] },
    connection: {
      createPeer({ principal, interactions }) {
        assert.deepEqual(principal, { kind: 'owner' }); assert.equal(interactions, 'answer');
        const controller = new AbortController(); const peer = { id: `peer-${peers.length}`, signal: controller.signal, dispose: async () => controller.abort() }; peers.push(peer); return peer;
      },
      createSharedFetchHandler(channel) { assert.equal(channel, '/api'); return { async fetch(request, peer) { results.push({ body: await request.json(), peer }); return Response.json({ type: 'server-response', result: { ok: true } }); } }; },
    },
    typertGateway: {
      async invoke(call) {
        calls.push(call);
        if (call.method === 'list') return { items: [{ sessionId: 'session', projections: { values: { title: 'Session' } }, running: true }, { sessionId: 'private', running: false }] };
        if (call.method === 'modelCatalog') return { groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'model', name: 'Model' }] }] };
        if (call.method === 'create') { project.sessionIds.push(call.args.request.sessionId); return { sessionId: call.args.request.sessionId }; }
        if (call.method === 'page') return { records: opening.records.slice(0, 1), hasMore: false };
        if (call.namespace === 'userQuestions' && call.method === 'answer') return true;
        return { accepted: true };
      },
      async stream(call) {
        calls.push(call);
        return (async function* () { yield opening; })();
      },
      wireStream: { async open(endpoint, payload, _uplink, peer, signal) {
        assert.equal(endpoint, '$events'); assert.deepEqual(payload, { args: {} });
        const queue = []; let wake, failure;
        const stream = { push(value) { queue.push(value); wake?.(); }, fail(error) { failure = error; wake?.(); } }; eventStreams.push(stream);
        return (async function* () {
          yield { type: 'ready', clientId: `client-${peer.id}` };
          while (!signal.aborted) {
            if (failure) throw failure;
            if (queue.length) { yield queue.shift(); continue; }
            await new Promise(resolve => {
              const abort = () => { signal.removeEventListener('abort', abort); resolve(); };
              signal.addEventListener('abort', abort, { once: true });
              wake = () => { signal.removeEventListener('abort', abort); resolve(); };
            });
          }
        })();
      } },
    },
  };
  const adapter = createSessionAdapter(ctx);
  return { adapter, ctx, calls, results, peers, opening, eventStreams, project, device: { id: 'phone' } };
}

test('state lists registered Harness sessions and maps official model catalog', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const state = await f.adapter.dispatch({ action: 'state' }, f.device);
  assert.deepEqual(state.sessions.map(session => session.id), ['session']);
  assert.equal(state.models[0].model, 'model');
  assert.deepEqual(f.calls.find(call => call.method === 'list').args, { _request: {} });
});

test('internal session summaries skip model catalog and accept a request-local project snapshot', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const expected = (await f.adapter.dispatch({ action: 'state' }, f.device)).sessions;
  f.calls.length = 0;
  f.ctx.workspaceRegistry.list = () => { throw new Error('Snapshot must be reused'); };
  const invoke = f.ctx.typertGateway.invoke;
  f.ctx.typertGateway.invoke = call => {
    if (call.method === 'modelCatalog') throw new Error('Catalog unavailable');
    return invoke(call);
  };
  assert.deepEqual(await f.adapter.list(f.device, [f.project]), expected);
  assert.deepEqual(f.calls.map(call => call.method), ['list']);
  await assert.rejects(f.adapter.dispatch({ action: 'models' }, f.device), /Catalog unavailable/);
  await assert.rejects(f.adapter.dispatch({ action: 'sessions' }, f.device), /Unsupported Link action/);
});

test('session summary requests hold their peer until completion and release it after failure', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let rejectList;
  f.ctx.typertGateway.invoke = () => new Promise((resolve, reject) => { rejectList = reject; });
  const pending = f.adapter.list(f.device);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(45_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.peers[0].signal.aborted, false, 'idle expiry cannot evict an active summary request');
  rejectList(new Error('List failed'));
  await assert.rejects(pending, /List failed/);
  t.mock.timers.tick(45_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.peers[0].signal.aborted, true, 'failed summary requests release their activity hold');
});

test('state maps 5000 sessions across 20 projects with one registry read', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const projects = Array.from({ length: 20 }, (_, index) => ({ id: `project-${index}`, path: `/project-${index}`, sessionIds: [] }));
  const items = Array.from({ length: 5000 }, (_, index) => {
    const sessionId = `session-${index}`;
    projects[index % projects.length].sessionIds.push(sessionId);
    return { sessionId, projections: { values: { title: `Session ${index}` } }, running: index % 2 === 0, updatedAt: 5000 - index };
  });
  let projectReads = 0;
  f.ctx.workspaceRegistry.list = () => { projectReads++; return projects; };
  const invoke = f.ctx.typertGateway.invoke;
  f.ctx.typertGateway.invoke = call => call.method === 'list' ? { items } : invoke(call);
  const state = await f.adapter.dispatch({ action: 'state' }, f.device);
  assert.equal(projectReads, 1);
  assert.deepEqual(state.projects, projects.map(project => ({ id: project.id, name: project.id, path: project.path })));
  assert.deepEqual(state.sessions, items.map((row, index) => ({ id: row.sessionId, projectId: `project-${index % projects.length}`, title: `Session ${index}`, running: row.running, updatedAt: row.updatedAt })));
});

test('state preserves first project ownership, visibility, titles and source order without caching', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  let projects = [
    { id: 'first', title: 'First', path: '/first', sessionIds: ['plain', 'nested', 'empty', 'private', 'child', 'subagent'] },
    { id: 'second', path: '/second', sessionIds: ['nested'] },
  ];
  const items = [
    { sessionId: 'nested', projections: { values: { title: { title: 'Nested title' } } }, running: true, updatedAt: 10 },
    { sessionId: 'unregistered', updatedAt: 100 },
    { sessionId: 'private', updatedAt: 90 },
    { sessionId: 'child', parentSessionId: 'plain', updatedAt: 80 },
    { sessionId: 'subagent', origin: 'subagent', updatedAt: 70 },
    { sessionId: 'plain', projections: { values: { title: 'Plain title' } }, running: false, updatedAt: 30 },
    { sessionId: 'empty', projections: { values: { title: '' } }, updatedAt: 20 },
  ];
  let projectReads = 0;
  f.ctx.workspaceRegistry.list = () => { projectReads++; return projects; };
  f.ctx.get = name => name === 'assistant' ? { sidebarPrivateSessionIds: async () => ['private'] } : undefined;
  const invoke = f.ctx.typertGateway.invoke;
  f.ctx.typertGateway.invoke = call => call.method === 'list' ? { items } : invoke(call);
  const state = await f.adapter.dispatch({ action: 'state' }, f.device);
  assert.equal(projectReads, 1);
  assert.deepEqual(state.sessions, [
    { id: 'nested', projectId: 'first', title: 'Nested title', running: true, updatedAt: 10 },
    { id: 'plain', projectId: 'first', title: 'Plain title', running: false, updatedAt: 30 },
    { id: 'empty', projectId: 'first', title: '新会话', running: undefined, updatedAt: 20 },
  ]);
  assert.deepEqual(await f.adapter.list(f.device, projects), state.sessions);
  assert.equal(projectReads, 1, 'summaries reuse the supplied project snapshot');
  projects = [{ id: 'replacement', title: 'Replacement', path: '/replacement', sessionIds: ['nested'] }];
  const refreshed = await f.adapter.dispatch({ action: 'state' }, f.device);
  assert.equal(projectReads, 2);
  assert.deepEqual(refreshed.projects, [{ id: 'replacement', name: 'Replacement', path: '/replacement' }]);
  assert.deepEqual(refreshed.sessions, [{ ...state.sessions[0], projectId: 'replacement' }]);
});

test('paired Link syncs durable notifications and marks transport delivery for its device', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const result = await f.adapter.dispatch({ action: 'notifications', afterSeq: 0 }, f.device);
  assert.deepEqual(result.events, [{ id: 'event-1', text: '通知' }]);
  assert.equal(result.deviceId, 'phone');
});

test('official sessions remain available while SuperAgent is disabled and notification calls recover after enable', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  let current;
  f.ctx.get = name => name === 'assistant' ? current : undefined;
  const unavailable = error => error.status === 503 && /SuperAgent.*不可用/.test(error.message);
  assert.equal((await f.adapter.dispatch({ action: 'state' }, f.device)).sessions[0].id, 'session');
  await assert.rejects(f.adapter.dispatch({ action: 'notifications' }, f.device), unavailable);
  const calls = [];
  const instance = label => ({ dispatch: async input => { calls.push([label, input.action]); return { events: [{ id: label }] }; } });
  current = instance('first');
  assert.deepEqual((await f.adapter.dispatch({ action: 'notifications' }, f.device)).events, [{ id: 'first' }]);
  current = undefined;
  await assert.rejects(f.adapter.dispatch({ action: 'notificationAck', eventIds: ['first'] }, f.device), unavailable);
  assert.equal((await f.adapter.dispatch({ action: 'models' }, f.device)).models[0].model, 'model');
  current = instance('replacement');
  await f.adapter.dispatch({ action: 'notificationRead', eventIds: ['first'] }, f.device);
  assert.deepEqual(calls, [['first', 'notificationSync'], ['first', 'notificationDelivered'], ['replacement', 'notificationRead']]);
});

test('notification delivery does not retain a SuperAgent instance removed during synchronization', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const calls = [];
  let current = { dispatch: async input => { calls.push(input.action); current = undefined; return { events: [{ id: 'pending' }] }; } };
  f.ctx.get = name => name === 'assistant' ? current : undefined;
  await assert.rejects(f.adapter.dispatch({ action: 'notifications' }, f.device), error => error.status === 503);
  assert.deepEqual(calls, ['notificationSync']);
});

test('state does not wait for a slow interaction stream', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const open = f.ctx.typertGateway.wireStream.open;
  f.ctx.typertGateway.wireStream.open = (...args) => new Promise(resolve => {
    setTimeout(() => resolve(open(...args)), 100);
  });
  const started = Date.now();
  const state = await f.adapter.dispatch({ action: 'state' }, f.device);
  assert.deepEqual(state.sessions.map(session => session.id), ['session']);
  assert.ok(Date.now() - started < 80, 'state should not wait for interaction stream readiness');
});

test('send/cancel use official gateway, rejects foreign sessions and unsupported actions', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await f.adapter.dispatch({ action: 'send', id: 'session', requestId: 'request', text: 'hello' }, f.device);
  assert.deepEqual(f.calls.at(-1).args, { request: { sessionId: 'session', requestId: 'request', mode: 'queue', content: [{ type: 'text', text: 'hello' }] } });
  await f.adapter.dispatch({ action: 'cancel', id: 'session' }, f.device);
  assert.deepEqual(f.calls.at(-1).args, { request: { sessionId: 'session' } });
  await assert.rejects(f.adapter.dispatch({ action: 'send', id: 'private', requestId: 'r', text: 'x' }, f.device), /not registered/);
  await assert.rejects(f.adapter.dispatch({ action: 'shell', command: 'echo' }, f.device), /Unsupported/);
});

test('history parses committed and live text, excludes replacement and pages at real cursor', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const result = await f.adapter.dispatch({ action: 'history', id: 'session' }, f.device);
  assert.deepEqual(result.messages.map(message => message.text), ['hello', 'answer', 'tool output', 'live output']);
  assert.equal(result.running, true);
  await f.adapter.dispatch({ action: 'history', id: 'session', before: 3 }, f.device);
  assert.deepEqual(f.calls.find(call => call.method === 'page').args.request, { address: { kind: 'session', sessionId: 'session' }, throughSeq: 7, beforeSeq: 3, maxMessages: 100 });
});

test('creation retries share one result and reject changed input for same request id', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const input = { action: 'create', projectId: 'project', requestId: 'first', provider: 'p', model: 'm' };
  const [a, b] = await Promise.all([f.adapter.dispatch(input, f.device), f.adapter.dispatch(input, f.device)]);
  assert.equal(a.id, b.id); assert.equal(f.calls.filter(call => call.method === 'create').length, 1);
  assert.equal(f.calls.find(call => call.method === 'create').args.request.workspaceId, 'project');
  await assert.rejects(f.adapter.dispatch({ ...input, model: 'different' }, f.device), /another session configuration/);
});

test('approval uses same owner peer and official event result, prevents cross-session reply', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await f.adapter.dispatch({ action: 'state' }, f.device);
  f.eventStreams[0].push({ type: 'waterfall', event: 'approval/request', eventId: 'approval', agentId: 'session', request: { toolName: 'shell', reason: 'Execute command?' } });
  await new Promise(resolve => setImmediate(resolve));
  const history = await f.adapter.dispatch({ action: 'history', id: 'session' }, f.device);
  assert.equal(history.interactions[0].kind, 'permission');
  await f.adapter.dispatch({ action: 'respond', id: 'session', interactionId: 'approval', answer: { allow: true } }, f.device);
  assert.deepEqual(f.results[0].body.payload.args, { clientId: 'client-peer-0', eventId: 'approval', outcome: { kind: 'result', value: 'allowed-once' } });
  assert.equal(f.results[0].peer, f.peers[0]);
  await assert.rejects(f.adapter.dispatch({ action: 'respond', id: 'session', interactionId: 'approval', answer: { allow: true } }, f.device), /expired/);
});

test('continued questions use userQuestions answer with agentId lookup', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  f.opening.projections.values.userQuestions = { active: [{ callId: 'call', state: 'continued', questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'Yes' }] }] }] };
  const answer = { answers: [{ id: 'q', selected: ['Yes'] }] };
  await f.adapter.dispatch({ action: 'respond', id: 'session', interactionId: 'continued:call', answer }, f.device);
  assert.deepEqual(f.calls.at(-1).args, { agentId: 'session', callId: 'call', answer });
});

test('revoke/close dispose peers and permit later service reconfiguration', async () => {
  const f = fixture();
  await f.adapter.dispatch({ action: 'state' }, f.device);
  await f.adapter.revoke('phone'); assert.equal(f.peers[0].signal.aborted, true);
  await f.adapter.dispatch({ action: 'state' }, f.device); assert.equal(f.peers.length, 2);
  await f.adapter.close(); assert.equal(f.peers[1].signal.aborted, true);
  await f.adapter.dispatch({ action: 'state' }, f.device); assert.equal(f.peers.length, 3);
  await f.adapter.close();
});

test('failed interaction stream before ready disposes its peer and allows retry', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const open = f.ctx.typertGateway.wireStream.open;
  let first = true;
  f.ctx.typertGateway.wireStream.open = (...args) => {
    if (first) { first = false; throw new Error('Interaction source unavailable'); }
    return open(...args);
  };
  await assert.rejects(f.adapter.dispatch({ action: 'state' }, f.device), /source unavailable/);
  assert.equal(f.peers[0].signal.aborted, true);
  const state = await f.adapter.dispatch({ action: 'state' }, f.device);
  assert.equal(state.sessions[0].id, 'session');
  assert.equal(f.peers.length, 2);
});

test('stream failure after ready evicts immediately and delayed teardown preserves replacement', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await f.adapter.dispatch({ action: 'state' }, f.device);
  let finishDisposal;
  const disposal = new Promise(resolve => { finishDisposal = resolve; });
  t.after(finishDisposal);
  const dispose = f.peers[0].dispose;
  f.peers[0].dispose = async () => { await disposal; await dispose(); };
  f.eventStreams[0].fail(new Error('Connection lost'));
  await new Promise(resolve => setImmediate(resolve));
  await f.adapter.dispatch({ action: 'state' }, f.device);
  assert.equal(f.peers.length, 2, 'retry uses a new peer before prior disposal completes');
  finishDisposal();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.peers[0].signal.aborted, true);
  assert.equal(f.peers[1].signal.aborted, false);
  await f.adapter.dispatch({ action: 'state' }, f.device);
  assert.equal(f.peers.length, 2, 'old finally did not evict replacement');
});

test('unsupported, unregistered and capacity-exceeding waterfalls delegate via official next', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await f.adapter.dispatch({ action: 'state' }, f.device);
  const push = (eventId, agentId = 'session', event = 'approval/request') => f.eventStreams[0].push({ type: 'waterfall', event, eventId, agentId, request: { toolName: 'shell' } });
  push('foreign', 'private');
  push('unknown', 'session', 'unrelated/request');
  for (let index = 0; index < 101; index++) push(`approval-${index}`);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.results.map(result => result.body.payload.args), ['foreign', 'unknown', 'approval-100'].map(eventId => ({ clientId: 'client-peer-0', eventId, outcome: { kind: 'next' } })));
  assert.ok(f.results.every(result => result.peer === f.peers[0]));
  const history = await f.adapter.dispatch({ action: 'history', id: 'session' }, f.device);
  assert.equal(history.interactions.length, 100);
});
