import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Worktrees may share a built official dependency tree through node_modules.
const checkout = fileURLToPath(new URL('../../../deepseek-harness/', import.meta.url));
const official = existsSync(join(checkout, 'packages/api/gateway/lib/index.js'))
  ? checkout : dirname(realpathSync(join(checkout, 'node_modules')));
const requireOfficial = createRequire(join(official, 'packages/api/gateway/package.json'));
const pinned = new Map(['@deepseek-ai/cordis', '@deepseek-ai/dsh-typert-protocol', 'zod']
  .map(name => [name, pathToFileURL(requireOfficial.resolve(name)).href]));
const hook = registerHooks({ resolve(specifier, context, next) {
  return pinned.has(specifier) ? { url: pinned.get(specifier), shortCircuit: true } : next(specifier, context);
} });
const load = name => import(pathToFileURL(requireOfficial.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: Registry } = await load('@deepseek-ai/dsh-typert-registry');
const { default: Gateway } = await load('@deepseek-ai/dsh-api-gateway');
const { default: RemoteAccess } = await load('@deepseek-ai/dsh-api-remote-access');
const { Peer } = await load('@deepseek-ai/dsh-client-connection');
const clientGateway = await load('@deepseek-ai/dsh-api-gateway/client');
const { installExecutionFactsRemote } = await import('../src/execution-facts-remote.mjs');
const { executionFactsRemoteContribution } = await import('../src/execution-facts-contract.mjs');
test.after(() => hook.deregister());

function factStore() {
  const entries = [], listeners = new Set();
  const calls = [];
  const facts = {
    calls, entries, listeners,
    currentCursor: () => entries.length,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    append(count = 1) {
      for (let i = 0; i < count; i++) entries.push({ seq: entries.length + 1, ticketId: 'ticket-1', kind: 'progress' });
      for (const listener of listeners) listener();
    },
    async snapshot(request) {
      calls.push(['snapshot', request]);
      const result = { cursor: entries.length, tickets: [{ id: 'ticket-1' }], bootId: 'boot-1', observedAt: 'now', completeness: { complete: true } };
      await facts.duringSnapshot?.();
      return result;
    },
    page({ after = 0, through = entries.length, limit = 100 }) {
      calls.push(['page', { after, through, limit }]);
      const selected = entries.filter(row => row.seq > after && row.seq <= through).slice(0, limit);
      const cursor = selected.at(-1)?.seq ?? after;
      return { cursor, entries: selected, hasMore: cursor < through };
    },
    evidence(request) { calls.push(['evidence', request]); return { ticketId: request.ticketId, references: [] }; },
  };
  return facts;
}

async function setup(t, facts = factStore()) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Registry);
  await ctx.plugin(RemoteAccess);
  await ctx.plugin(Gateway);
  const dispose = await installExecutionFactsRemote({ ctx, facts });
  const peer = new Peer(ctx, { principal: { kind: 'owner' } });
  const invoke = (method, request = {}, selectedPeer = peer) => ctx.typertGateway.invoke({
    namespace: 'benchgoExecutionFacts', method, args: { request }, peer: selectedPeer,
  });
  const open = async (signal = new AbortController().signal, selectedPeer = peer) => {
    const stream = await ctx.typertGateway.stream({
      namespace: 'benchgoExecutionFacts', method: 'stream', args: { request: {} }, peer: selectedPeer, signal,
    });
    return stream[Symbol.asyncIterator]();
  };
  return { ctx, facts, dispose, peer, invoke, open };
}

test('official strict Gateway dispatches the registered service and validates its wire requests', async t => {
  const b = await setup(t);
  assert.equal(b.ctx.typert.local.get('benchgoExecutionFacts/stream').mode, 'stream');
  assert.deepEqual(await b.invoke('snapshot', { ticketId: 'ticket-1' }), {
    cursor: 0, tickets: [{ id: 'ticket-1' }], bootId: 'boot-1', observedAt: 'now', completeness: { complete: true },
  });
  b.facts.append(3);
  assert.deepEqual(await b.invoke('page', { after: 0, through: 3, limit: 2 }), {
    cursor: 2, entries: b.facts.entries.slice(0, 2), hasMore: true,
  });
  const evidence = { ticketId: 'ticket-1', runId: 'run-2', instructionRevision: 2, after: 1, limit: 8 };
  await b.invoke('evidence', evidence);
  assert.deepEqual(b.facts.calls.at(-1), ['evidence', evidence]);
  for (const request of [{ principal: { kind: 'owner' } }, { ticketId: '' }]) {
    await assert.rejects(b.invoke('snapshot', request), { code: 'gateway/input-invalid' });
  }
  await assert.rejects(b.invoke('page', { limit: 0 }), { code: 'gateway/input-invalid' });
  await assert.rejects(b.invoke('page', { after: 2, through: 1 }), { code: 'gateway/bad-request' });
  await b.dispose();
  assert.equal(b.ctx.typert.local.get('benchgoExecutionFacts/snapshot'), undefined);
  await assert.rejects(b.invoke('snapshot'), { code: 'gateway/definition-unavailable' });
});

test('owner checks use the actual invocation Peer even if a broader policy permits a guest', async t => {
  const b = await setup(t);
  const guest = new Peer(b.ctx, { principal: { kind: 'test-guest' } });
  const actions = executionFactsRemoteContribution.descriptors.map(row => `${row.namespace}/${row.method}`);
  b.ctx.remoteAccess.registerPolicy('test-guest', { bindings: () => [{
    resource: { kind: 'global' }, role: { name: 'test-all', resource: 'global', actions },
  }] });
  for (const [method, request] of [['snapshot', {}], ['page', {}], ['evidence', { ticketId: 'ticket-1' }]]) {
    await assert.rejects(b.invoke(method, request, guest), error => error.code === 'remote-access/denied' && error.details.reason === 'owner-required');
  }
  const stream = await b.open(undefined, guest);
  await assert.rejects(stream.next(), error => error.code === 'remote-access/denied' && error.details.reason === 'owner-required');
  assert.equal(b.facts.calls.length, 0);
  assert.equal(b.facts.listeners.size, 0);
});

test('follow subscribes before its baseline and drains slow consumers in bounded pages', async t => {
  const b = await setup(t);
  b.facts.duringSnapshot = () => {
    assert.equal(b.facts.listeners.size, 1);
    b.facts.append(251);
  };
  const signal = new AbortController();
  const stream = await b.open(signal.signal);
  const opening = (await stream.next()).value;
  assert.equal(opening.type, 'snapshot');
  assert.equal(opening.snapshot.cursor, 0);
  const seen = [];
  for (const expected of [100, 100, 51]) {
    const frame = (await stream.next()).value;
    assert.equal(frame.type, 'changes');
    assert.equal(frame.entries.length, expected);
    seen.push(...frame.entries.map(row => row.seq));
  }
  assert.deepEqual(seen, Array.from({ length: 251 }, (_, index) => index + 1));
  const pending = stream.next();
  b.facts.append();
  assert.equal((await pending).value.cursor, 252);
  signal.abort();
  assert.equal(b.facts.listeners.size, 0, 'abort releases subscription even while suspended at yield');
  await stream.return();
});

test('stream cancellation and service disposal release idle listeners without a timer', async t => {
  const b = await setup(t);
  const stream = await b.open();
  await stream.next();
  const pending = stream.next();
  await b.dispose();
  assert.equal((await pending).done, true);
  assert.equal(b.facts.listeners.size, 0);
});

test('two subscribers cancel independently and reopened followers catch the durable cursor', async t => {
  const b = await setup(t);
  const firstSignal = new AbortController();
  const first = await b.open(firstSignal.signal);
  const second = await b.open();
  assert.equal((await first.next()).value.snapshot.cursor, 0);
  assert.equal((await second.next()).value.snapshot.cursor, 0);
  assert.equal(b.facts.listeners.size, 2);
  b.facts.append(2);
  assert.equal((await first.next()).value.cursor, 2);
  assert.equal((await second.next()).value.cursor, 2);
  firstSignal.abort();
  await first.return();
  assert.equal(b.facts.listeners.size, 1);

  const waitingSecond = second.next();
  b.facts.append(3);
  const continued = (await waitingSecond).value;
  assert.deepEqual(continued.entries.map(row => row.seq), [3, 4, 5]);
  assert.equal(continued.cursor, b.facts.currentCursor());
  const reopened = await b.open();
  assert.equal((await reopened.next()).value.snapshot.cursor, 5);
  assert.equal(b.facts.listeners.size, 2);
  const waitingReopened = reopened.next();
  const waitingOriginal = second.next();
  b.facts.append();
  const frames = await Promise.all([waitingReopened, waitingOriginal]);
  assert.ok(frames.every(frame => frame.value.cursor === 6));
  assert.ok(frames.every(frame => frame.value.entries.length === 1 && frame.value.entries[0].seq === 6));

  const endings = [reopened.next(), second.next()];
  await b.dispose();
  assert.ok((await Promise.all(endings)).every(result => result.done));
  assert.equal(b.facts.listeners.size, 0);
});

test('sequence gaps fail explicitly and reconnect takes a fresh authoritative snapshot', async t => {
  const b = await setup(t);
  const stream = await b.open();
  await stream.next();
  b.facts.append(2);
  const read = b.facts.page;
  b.facts.page = request => ({ ...read(request), entries: [b.facts.entries[1]] });
  await assert.rejects(stream.next(), { code: 'gateway/internal' });
  assert.equal(b.facts.listeners.size, 0);
  b.facts.page = read;
  const reopened = await b.open();
  assert.equal((await reopened.next()).value.snapshot.cursor, 2);
  await reopened.return();
  assert.equal(b.facts.listeners.size, 0);
});

test('the real Client Remote mount calls the same strict unary and stream definitions', async t => {
  const b = await setup(t);
  const client = new Context();
  t.after(() => client.fiber.dispose());
  await client.plugin(Registry);
  const requestFor = (endpoint, payload, signal) => {
    const [namespace, method] = endpoint.split('/');
    return { namespace, method, args: payload.args, signal, peer: b.peer };
  };
  client.provide('connection', {
    interactions: 'none',
    rpc: {
      async call(_channel, endpoint, payload, signal) {
        return { ok: true, value: await b.ctx.typertGateway.invoke(requestFor(endpoint, payload, signal)) };
      },
      async *open(_channel, endpoint, payload, signal) {
        yield* await b.ctx.typertGateway.stream(requestFor(endpoint, payload, signal));
      },
    },
  });
  await client.plugin(clientGateway);
  const unmount = await client.remote.$mount(executionFactsRemoteContribution);
  assert.equal((await client.remote.benchgoExecutionFacts.snapshot({})).value.bootId, 'boot-1');
  const handle = client.remote.benchgoExecutionFacts.stream({});
  const iterator = handle[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, 'snapshot');
  b.facts.append();
  assert.equal((await iterator.next()).value.cursor, 1);
  await handle.dispose();
  assert.equal(b.facts.listeners.size, 0);
  await unmount();
  assert.equal(client.remote.benchgoExecutionFacts, undefined);
});
