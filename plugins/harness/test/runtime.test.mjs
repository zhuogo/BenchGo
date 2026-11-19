import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Commander } from '../src/runtime.mjs';
import { fixtureRoute, fixtureRouteService, fixtureInstaller } from './fixtures/api-route.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

class ControlledProvider {
  static capabilities = { stream: true, resume: true, approvals: true, permissions: true };
  submitted = [];
  hosts = [];
  async connect(session, host) {
    this.hosts.push(host);
    return {
      nativeId: session.nativeId ?? `native-${session.id}`,
      async setPermission() {},
      submit: async text => { this.submitted.push(text); },
      interrupt: async () => { host.event('turn.completed', { status: 'interrupted' }); },
      close: async () => {},
    };
  }
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'commander-runtime-'));
  const commander = await new Commander({ dataDir: directory, routeService: fixtureRouteService, ...options }).open();
  commander.toolInstaller = fixtureInstaller;
  const provider = new ControlledProvider(); commander.providers.set('test', provider);
  commander.resolvePermission = session => commander.providers.get(session.provider)?.constructor.capabilities?.permissions ? { sandbox: 'workspace-write', approval: 'ask' } : undefined;
  t.after(async () => { await commander.close(); await rm(directory, { recursive: true, force: true }); });
  return { commander, provider, directory };
}

test('initial launch failure can retry after restart without creating a second record', async t => {
  const { commander, directory } = await fixture(t);
  commander.providers.set('test', { async connect() { throw new Error('temporary launch failure'); } });
  await assert.rejects(commander.create({ route: fixtureRoute(), provider: 'test' }), /隔离工具启动失败/);
  const { id } = commander.list()[0];
  await commander.close();
  const restored = await new Commander({ dataDir: directory, routeService: fixtureRouteService }).open();
  restored.toolInstaller = fixtureInstaller;
  try {
    restored.providers.set('test', new ControlledProvider());
    assert.equal((await restored.connect(id)).status, 'idle');
    assert.equal(restored.list().length, 1);
  } finally { await restored.close(); }
});

test('successful connection without a durable handle still refuses replacement', async t => {
  const { commander } = await fixture(t);
  commander.providers.set('test', { async connect() { return { async close() {} }; } });
  const { id } = await commander.create({ route: fixtureRoute(), provider: 'test' });
  await commander.disconnect(id);
  await assert.rejects(commander.connect(id), /No durable native handle/);
});

test('reserves the active turn before async persistence; duplicate request IDs never execute twice', async t => {
  const { commander, provider } = await fixture(t);
  const session = await commander.create({ route: fixtureRoute(), provider: 'test' });
  const first = commander.submit(session.id, 'one', { requestId: 'same' });
  const duplicate = commander.submit(session.id, 'one', { requestId: 'same' });
  await assert.rejects(commander.submit(session.id, 'two'), /running/);
  assert.deepEqual(await first, await duplicate);
  assert.equal(provider.submitted.length, 1);
  await assert.rejects(commander.submit(session.id, 'different', { requestId: 'same' }), /different prompt/);
  provider.hosts[0].event('turn.completed', { status: 'completed' });
  await commander.submit(session.id, 'two');
  assert.deepEqual(provider.submitted, ['one', 'two']);
});

test('human approval is scoped, single use and expires to denial', async t => {
  const { commander, provider } = await fixture(t, { approvalTimeout: 30 });
  const session = await commander.create({ route: fixtureRoute(), provider: 'test' });
  await commander.submit(session.id, 'run');
  const answer = provider.hosts[0].approval({ kind: 'permission', method: 'bash', details: {} });
  await new Promise(resolve => setImmediate(resolve));
  const approval = commander.snapshot(session.id).pendingApprovals[0];
  assert.equal(commander.snapshot(session.id).status, 'waiting');
  assert.throws(() => commander.approve('another-session', approval.id, { allow: true }), /belongs/);
  assert.throws(() => commander.approve(session.id, approval.id, { allow: 'false' }), /boolean/);
  commander.approve(session.id, approval.id, { allow: true });
  assert.deepEqual(await answer, { allow: true });
  assert.throws(() => commander.approve(session.id, approval.id, { allow: true }), /expired/);
  assert.deepEqual(await provider.hosts[0].approval({ kind: 'permission', method: 'edit', details: {} }), { allow: false });
  assert.equal(commander.snapshot(session.id).status, 'running');
});

test('Worker questions stay with the execution owner and late answers are discarded', async t => {
  const { commander, provider } = await fixture(t);
  const { id } = await commander.create({ route: fixtureRoute(), provider: 'test', executionId: 'worker-run' });
  await commander.submit(id, 'run');
  const host = provider.hosts[0];
  const request = { kind: 'question', method: 'choose', nativeRequestId: 'native-q' };
  assert.deepEqual(await host.approval(request), { allow: false });
  const ownerRequest = deferred(), ownerAnswer = deferred();
  const release = commander.registerExecutionHandler(id, (value, signal) => {
    ownerRequest.resolve({ value, signal });
    return ownerAnswer.promise;
  });
  const pending = host.approval(request);
  const { value, signal } = await ownerRequest.promise;
  assert.deepEqual(value, request);
  assert.equal(commander.snapshot(id).status, 'waiting');
  assert.deepEqual(commander.snapshot(id).pendingApprovals, []);
  assert.equal(commander.events(id).events.some(event => event.type === 'approval.requested'), false);
  const [approvalId] = commander.pending.keys();
  assert.throws(() => commander.approve(id, approvalId, { allow: true }), /expired/);
  await commander.interrupt(id);
  assert.equal(signal.aborted, true);
  ownerAnswer.resolve({ allow: true });
  assert.deepEqual(await pending, { allow: false });
  assert.equal(commander.snapshot(id).status, 'idle');
  release();
});

test('native Full policy permits new tool permission calls without prompts but never answers questions or resets old pending approvals', async t => {
  const { commander, provider } = await fixture(t);
  let permission = { sandbox: 'workspace-write', approval: 'ask' };
  commander.resolvePermission = () => permission;
  const { id } = await commander.create({ route: fixtureRoute(), provider: 'test' });
  await commander.submit(id, 'run');
  const host = provider.hosts[0];
  const old = host.approval({ kind: 'permission', method: 'old-tool' });
  await new Promise(resolve => setImmediate(resolve));
  const previous = commander.snapshot(id).pendingApprovals[0];
  assert.ok(previous);
  permission = { sandbox: 'danger-full-access', approval: 'never' };
  const cursor = commander.snapshot(id).cursor;
  assert.deepEqual(await host.approval({ kind: 'permission', method: 'new-tool' }), { allow: true });
  assert.deepEqual(commander.snapshot(id).pendingApprovals.map(value => value.id), [previous.id]);
  assert.equal(commander.events(id, cursor).events.some(event => event.type === 'approval.requested'), false);
  const question = host.approval({ kind: 'question', method: 'choose' });
  const pendingQuestion = commander.snapshot(id).pendingApprovals.find(value => value.kind === 'question');
  assert.ok(pendingQuestion);
  commander.approve(id, pendingQuestion.id, { allow: false, answers: { selection: 'B' } });
  assert.deepEqual(await question, { allow: false, answers: { selection: 'B' } });
  commander.approve(id, previous.id, { allow: false });
  assert.deepEqual(await old, { allow: false });
});

test('native Full cannot bypass a missing owner, an aborted request or a released connection', async t => {
  const { commander, provider } = await fixture(t);
  commander.resolvePermission = () => ({ sandbox: 'danger-full-access', approval: 'never' });
  const { id } = await commander.create({ route: fixtureRoute(), provider: 'test' }), host = provider.hosts[0];
  await commander.submit(id, 'run');
  const abort = new AbortController(); abort.abort();
  assert.deepEqual(await host.approval({ kind: 'permission' }, abort.signal), { allow: false });
  commander.resolvePermission = () => { throw new Error('owner unavailable'); };
  await assert.rejects(host.approval({ kind: 'permission' }), /owner unavailable/);
  const permission = deferred();
  commander.resolvePermission = () => permission.promise;
  const raced = host.approval({ kind: 'permission' });
  await commander.disconnect(id);
  permission.resolve({ sandbox: 'danger-full-access', approval: 'never' });
  assert.deepEqual(await raced, { allow: false });
  assert.equal(commander.snapshot(id).pendingApprovals.length, 0);
});

test('native Full permission resolution cannot grant a late request after completion, failure or interrupt', async t => {
  const { commander, provider } = await fixture(t);
  for (const end of ['completed', 'failed', 'interrupt']) {
    commander.resolvePermission = () => ({ sandbox: 'danger-full-access', approval: 'never' });
    const { id } = await commander.create({ route: fixtureRoute(), provider: 'test' });
    await commander.submit(id, end);
    const host = provider.hosts.at(-1), permission = deferred();
    commander.resolvePermission = () => permission.promise;
    const result = host.approval({ kind: 'permission', method: 'late-tool' });
    if (end === 'interrupt') await commander.interrupt(id);
    else host.event('turn.completed', { status: end });
    permission.resolve({ sandbox: 'danger-full-access', approval: 'never' });
    assert.deepEqual(await result, { allow: false }, end);
    assert.deepEqual(await host.approval({ kind: 'permission' }), { allow: false }, end);
    assert.equal(commander.snapshot(id).pendingApprovals.length, 0);
  }
});

test('requesting interrupt invalidates Full permissions before native acknowledgement or completion arrives', async t => {
  const { commander, provider } = await fixture(t);
  commander.resolvePermission = () => ({ sandbox: 'danger-full-access', approval: 'never' });
  const { id } = await commander.create({ route: fixtureRoute(), provider: 'test' });
  await commander.submit(id, 'run');
  const permission = deferred(), acknowledgement = deferred(), host = provider.hosts[0];
  commander.resolvePermission = () => permission.promise;
  commander.drivers.get(id).interrupt = () => acknowledgement.promise;
  const result = host.approval({ kind: 'permission', method: 'racing-tool' });
  const interrupt = commander.interrupt(id);
  assert.equal(commander.snapshot(id).status, 'running');
  permission.resolve({ sandbox: 'danger-full-access', approval: 'never' });
  assert.deepEqual(await result, { allow: false });
  assert.deepEqual(await host.approval({ kind: 'permission', method: 'late-tool' }), { allow: false });
  assert.equal(commander.snapshot(id).pendingApprovals.length, 0);
  acknowledgement.resolve(); await interrupt;
  assert.equal(commander.snapshot(id).status, 'running');
  host.event('turn.completed', { status: 'interrupted' });
  assert.equal(commander.snapshot(id).status, 'idle');
});

test('Full works through the shared native approval seam without provider permission controls, while unsupported lower modes fail before launch', async t => {
  const { commander } = await fixture(t);
  let connected = 0, host;
  commander.providers.set('plain', { async connect(session, value) { connected++; host = value; return { nativeId: session.id, async submit() {}, async close() {} }; } });
  const { id } = await commander.create({ route: fixtureRoute(), provider: 'plain' });
  await commander.submit(id, 'run');
  assert.deepEqual(await host.approval({ kind: 'permission', method: 'tool' }), { allow: true });
  assert.equal(commander.snapshot(id).pendingApprovals.length, 0);
  commander.resolvePermission = () => ({ sandbox: 'workspace-write', approval: 'ask' });
  await assert.rejects(commander.create({ route: fixtureRoute(), provider: 'plain' }), /无法精确同步/);
  assert.equal(connected, 1);
});

test('interrupt denies pending permissions, and cancelling a wait does not cancel the native task', async t => {
  const { commander, provider } = await fixture(t);
  const { id } = await commander.create({ route: fixtureRoute(), provider: 'test' });
  await commander.submit(id, 'run');
  const abort = new AbortController();
  const wait = commander.wait(id, { signal: abort.signal });
  abort.abort(new Error('caller left'));
  await assert.rejects(wait, /caller left/);
  assert.equal(commander.snapshot(id).status, 'running');
  const approval = provider.hosts[0].approval({ kind: 'permission', method: 'bash', details: {} });
  await commander.interrupt(id);
  assert.deepEqual(await approval, { allow: false });
  assert.equal(commander.snapshot(id).status, 'idle');
});

test('permissions and questions keep waiting until every pending interaction is resolved', async t => {
  const { commander, provider } = await fixture(t);
  const { id } = await commander.create({ route: fixtureRoute(), provider: 'test' });
  await commander.submit(id, 'run');
  const host = provider.hosts[0];
  const permission = host.approval({ kind: 'permission', method: 'bash', details: {} });
  await new Promise(resolve => setImmediate(resolve));
  const question = host.approval({ kind: 'question', method: 'input', details: {} });
  const [first, second] = commander.snapshot(id).pendingApprovals;
  host.event('turn.started');
  assert.equal(commander.snapshot(id).status, 'waiting');
  commander.approve(id, first.id, { allow: true });
  assert.deepEqual(await permission, { allow: true });
  assert.equal(commander.snapshot(id).status, 'waiting');
  assert.equal(commander.snapshot(id).pendingApprovals.length, 1);
  commander.approve(id, second.id, { value: 'answer' });
  assert.deepEqual(await question, { value: 'answer' });
  assert.equal(commander.snapshot(id).status, 'running');
  assert.equal(commander.snapshot(id).pendingApprovals.length, 0);
});

test('completion and provider failure clear pending interaction without restoring running status', async t => {
  const { commander, provider } = await fixture(t);
  const { id } = await commander.create({ route: fixtureRoute(), provider: 'test' });
  const host = provider.hosts[0];
  for (const status of ['completed', 'failed']) {
    await commander.submit(id, 'run');
    const answer = host.approval({ kind: 'question', method: 'input', details: {} });
    host.event('turn.completed', { status });
    assert.deepEqual(await answer, { allow: false });
    assert.equal(commander.snapshot(id).status, status === 'completed' ? 'idle' : 'failed');
    assert.equal(commander.snapshot(id).pendingApprovals.length, 0);
  }
  await commander.connect(id);
  await commander.submit(id, 'run again');
  const current = provider.hosts.at(-1);
  const answer = current.approval({ kind: 'permission', method: 'bash', details: {} });
  current.failure(new Error('stream lost'));
  assert.deepEqual(await answer, { allow: false });
  assert.equal(commander.snapshot(id).status, 'failed');
  assert.equal(commander.snapshot(id).pendingApprovals.length, 0);
});

test('failed native submission clears interactions opened before acknowledgement', async t => {
  const { commander, provider } = await fixture(t);
  const { id } = await commander.create({ route: fixtureRoute(), provider: 'test' });
  let answer;
  commander.drivers.get(id).submit = async () => {
    answer = provider.hosts[0].approval({ kind: 'question', method: 'input', details: {} });
    throw new Error('native acknowledgement lost');
  };
  await assert.rejects(commander.submit(id, 'run'), /native acknowledgement lost/);
  assert.deepEqual(await answer, { allow: false });
  assert.equal(commander.snapshot(id).status, 'failed');
  assert.equal(commander.snapshot(id).pendingApprovals.length, 0);
});

test('restarts retain native identity and input receipts without replaying work', async t => {
  const { commander, provider, directory } = await fixture(t);
  const { id, nativeId } = await commander.create({ route: fixtureRoute(), provider: 'test' });
  await commander.submit(id, 'persisted', { requestId: 'durable' });
  await commander.close();
  const restored = await new Commander({ dataDir: directory, routeService: fixtureRouteService }).open();
  restored.toolInstaller = fixtureInstaller;
  restored.providers.set('test', provider);
  try {
    assert.equal(restored.snapshot(id).status, 'disconnected');
    assert.equal(restored.snapshot(id).nativeId, nativeId);
    await restored.connect(id);
    await restored.submit(id, 'persisted', { requestId: 'durable' });
    assert.equal(provider.submitted.length, 1);
    assert.equal(restored.snapshot(id).nativeId, nativeId);
    assert.ok(restored.events(id).events.some(e => e.type === 'input.accepted'));
  } finally { await restored.close(); }
});

test('old driver callbacks cannot finish or mutate a newly connected generation', async t => {
  const { commander, provider } = await fixture(t);
  const { id } = await commander.create({ route: fixtureRoute(), provider: 'test' });
  const old = provider.hosts[0];
  await commander.disconnect(id); await commander.connect(id); await commander.submit(id, 'new');
  old.event('turn.completed', { status: 'completed' }); old.nativeId('wrong'); old.failure(new Error('old stream'));
  assert.equal(commander.snapshot(id).status, 'running');
  assert.notEqual(commander.snapshot(id).nativeId, 'wrong');
  assert.deepEqual(await old.approval({ kind: 'permission' }), { allow: false });
});

test('bounded replay signals a missing baseline instead of silently hiding a gap', async t => {
  const { commander, provider } = await fixture(t, { eventLimit: 3 });
  const { id } = await commander.create({ route: fixtureRoute(), provider: 'test' });
  for (let n = 0; n < 10; n++) provider.hosts[0].event('text.delta', { text: `${n}` });
  const replay = commander.events(id, 0);
  assert.equal(replay.events.length, 3); assert.equal(replay.truncated, true);
  assert.equal(replay.cursor, replay.latest);
  await commander.persist();
  const data = JSON.parse(await readFile(join(commander.store.directory, 'sessions.json'), 'utf8'));
  assert.equal(data.sessions[0].events.length, 3);
});

test('owner lock prevents two runtimes writing the same state', async t => {
  const { directory } = await fixture(t);
  await assert.rejects(new Commander({ dataDir: directory, routeService: fixtureRouteService }).open(), /already in use/);
});

test('duplicate callers both fail if the input cannot be durably accepted; native engine is not invoked', async t => {
  const { commander, provider } = await fixture(t);
  const { id } = await commander.create({ route: fixtureRoute(), provider: 'test' });
  const original = commander.store.save.bind(commander.store);
  commander.store.save = () => Promise.reject(new Error('disk full'));
  const first = commander.submit(id, 'one', { requestId: 'same' });
  const retry = commander.submit(id, 'one', { requestId: 'same' });
  await assert.rejects(first, /disk full/);
  await assert.rejects(retry, /disk full/);
  assert.equal(provider.submitted.length, 0);
  commander.store.save = original;
});

test('concurrent native inputs wait for the coalesced snapshot containing both durable receipts', async t => {
  const { commander, provider, directory } = await fixture(t);
  const a = await commander.create({ route: fixtureRoute(), provider: 'test' });
  const b = await commander.create({ route: fixtureRoute(), provider: 'test' });
  const write = commander.store.writeSnapshot.bind(commander.store);
  const started = [deferred(), deferred()], release = [deferred(), deferred()];
  let writes = 0;
  t.mock.method(commander.store, 'writeSnapshot', async sessions => {
    const index = writes++;
    if (!index) { await write(sessions); started[0].resolve(); await release[0].promise; return; }
    if (index === 1) { started[1].resolve(); await release[1].promise; }
    return write(sessions);
  });
  for (const [session, requestId] of [[a, 'receipt-a'], [b, 'receipt-b']]) {
    commander.drivers.get(session.id).submit = async text => {
      const saved = JSON.parse(await readFile(join(directory, 'sessions.json'), 'utf8'));
      assert.equal(saved.sessions.find(row => row.id === session.id).receipts[requestId].text, text);
      provider.submitted.push(text);
    };
  }
  try {
    const baseline = commander.persist(); await started[0].promise;
    const first = commander.submit(a.id, 'one', { requestId: 'receipt-a' });
    const duplicate = commander.submit(a.id, 'one', { requestId: 'receipt-a' });
    const second = commander.submit(b.id, 'two', { requestId: 'receipt-b' });
    assert.deepEqual(provider.submitted, []);
    release[0].resolve(); await baseline; await started[1].promise;
    assert.deepEqual(provider.submitted, []);
    const before = JSON.parse(await readFile(join(directory, 'sessions.json'), 'utf8'));
    assert.equal(before.sessions.find(row => row.id === a.id).receipts['receipt-a'], undefined);
    assert.equal(before.sessions.find(row => row.id === b.id).receipts['receipt-b'], undefined);
    release[1].resolve();
    const [receipt, retry] = await Promise.all([first, duplicate, second]);
    assert.deepEqual(receipt, retry);
    assert.deepEqual(provider.submitted.sort(), ['one', 'two']);
  } finally { for (const gate of release) gate.resolve(); }
});

test('a failed pending snapshot rejects duplicate input callers before native dispatch', async t => {
  const { commander, provider } = await fixture(t);
  const { id } = await commander.create({ route: fixtureRoute(), provider: 'test' });
  const write = commander.store.writeSnapshot.bind(commander.store);
  const started = deferred(), release = deferred();
  let writes = 0;
  t.mock.method(commander.store, 'writeSnapshot', async sessions => {
    const index = writes++;
    if (!index) { await write(sessions); started.resolve(); await release.promise; return; }
    if (index === 1) throw new Error('coalesced disk write failed');
    return write(sessions);
  });
  try {
    const baseline = commander.persist(); await started.promise;
    const first = assert.rejects(commander.submit(id, 'one', { requestId: 'same' }), /coalesced disk write failed/);
    const duplicate = assert.rejects(commander.submit(id, 'one', { requestId: 'same' }), /coalesced disk write failed/);
    release.resolve(); await Promise.all([baseline, first, duplicate]);
    assert.deepEqual(provider.submitted, []);
    assert.match(commander.fault.message, /coalesced disk write failed/);
    await assert.rejects(commander.submit(id, 'another'), /persistence failed/);
  } finally { release.resolve(); }
});

test('remove releases an idle driver and persists record deletion while retaining native history, project files and children', async t => {
  const { commander, provider, directory } = await fixture(t);
  const nativeHistory = join(directory, 'native-history.jsonl');
  await writeFile(nativeHistory, 'native history remains');
  const parent = await commander.create({ route: fixtureRoute(), provider: 'test', cwd: directory });
  const child = await commander.create({ route: fixtureRoute(), provider: 'test', cwd: directory, parentId: parent.id });
  let closed = false;
  commander.drivers.get(parent.id).close = async () => { closed = true; };
  assert.deepEqual(await commander.remove(parent.id), { id: parent.id, removed: true });
  assert.equal(closed, true);
  assert.equal(commander.drivers.has(parent.id), false);
  assert.throws(() => commander.snapshot(parent.id), /Unknown BenchGo session/);
  assert.equal(commander.snapshot(child.id).parentId, undefined);
  assert.equal(await readFile(nativeHistory, 'utf8'), 'native history remains');
  await access(directory);
  const data = JSON.parse(await readFile(join(directory, 'sessions.json'), 'utf8'));
  assert.deepEqual(data.sessions.map(s => s.id), [child.id]);
  provider.hosts[0].event('text.delta', { text: 'stale event' });
  assert.equal(commander.list().length, 1);
});

test('archive and remove refuse active turns and remove excludes reconnect during resource cleanup', async t => {
  const { commander } = await fixture(t);
  const { id } = await commander.create({ route: fixtureRoute(), provider: 'test' });
  await commander.submit(id, 'active');
  await assert.rejects(commander.remove(id), /interrupt.*before deleting/);
  await assert.rejects(commander.archive(id), /interrupt.*before archiving/);
  await commander.interrupt(id);
  let release;
  commander.drivers.get(id).close = () => new Promise(resolve => { release = resolve; });
  const removal = commander.remove(id);
  await assert.rejects(commander.connect(id), /being deleted/);
  await assert.rejects(commander.submit(id, 'race'), /being deleted/);
  release();
  await removal;
});

test('archive prevents reconnect and deletion until driver cleanup finishes', async t => {
  const { commander } = await fixture(t);
  const { id } = await commander.create({ route: fixtureRoute(), provider: 'test' });
  let release;
  commander.drivers.get(id).close = () => new Promise(resolve => { release = resolve; });
  const pending = commander.archive(id);
  await assert.rejects(commander.connect(id), /being archived/);
  await assert.rejects(commander.remove(id), /being archived/);
  release();
  assert.equal((await pending).archived, true);
  assert.equal(commander.drivers.has(id), false);
});

test('removing a parent detaches shared-owner children without changing independently adopted children', async t => {
  const { commander, directory } = await fixture(t);
  const parent = await commander.create({ route: fixtureRoute(), provider: 'test', cwd: directory, ownerSessionId: 'original-harness' });
  const child = await commander.create({ route: fixtureRoute(), provider: 'test', cwd: directory, parentId: parent.id, ownerSessionId: 'original-harness' });
  const adopted = await commander.create({ route: fixtureRoute(), provider: 'test', cwd: directory, parentId: parent.id, ownerSessionId: 'independent-harness' });
  commander.get(adopted.id).harnessAdopted = true;
  const adoptedSameOwner = await commander.create({ route: fixtureRoute(), provider: 'test', cwd: directory, parentId: parent.id, ownerSessionId: 'original-harness' });
  commander.get(adoptedSameOwner.id).harnessAdopted = true;
  await commander.remove(parent.id);
  assert.equal(commander.snapshot(child.id).ownerSessionId, `commander-web:detached:${child.id}`);
  assert.equal(commander.snapshot(child.id).parentId, undefined);
  assert.equal(commander.snapshot(adopted.id).ownerSessionId, 'independent-harness');
  assert.equal(commander.snapshot(adoptedSameOwner.id).ownerSessionId, 'original-harness');
  const primary = commander.list().find(s => !s.parentId && !s.harnessAdopted && s.ownerSessionId === 'original-harness');
  assert.equal(primary, undefined);
  const saved = JSON.parse(await readFile(join(directory, 'sessions.json'), 'utf8'));
  assert.equal(saved.sessions.find(s => s.id === child.id).ownerSessionId, `commander-web:detached:${child.id}`);
});

test('failed removal persistence restores child parent and ownership fields', async t => {
  const { commander, directory } = await fixture(t);
  const parent = await commander.create({ route: fixtureRoute(), provider: 'test', cwd: directory, ownerSessionId: 'original-harness' });
  const child = await commander.create({ route: fixtureRoute(), provider: 'test', cwd: directory, parentId: parent.id, ownerSessionId: 'original-harness' });
  const unowned = await commander.create({ route: fixtureRoute(), provider: 'test', cwd: directory, parentId: parent.id });
  const persist = commander.persist.bind(commander);
  commander.persist = async () => {
    if (!commander.sessions.has(parent.id)) throw new Error('deletion write failed');
    return persist();
  };
  await assert.rejects(commander.remove(parent.id), /deletion write failed/);
  assert.equal(commander.snapshot(parent.id).ownerSessionId, 'original-harness');
  assert.equal(commander.snapshot(child.id).parentId, parent.id);
  assert.equal(commander.snapshot(child.id).ownerSessionId, 'original-harness');
  assert.equal(commander.snapshot(unowned.id).parentId, parent.id);
  assert.equal(Object.hasOwn(commander.get(unowned.id), 'ownerSessionId'), false);
  commander.persist = persist;
});
