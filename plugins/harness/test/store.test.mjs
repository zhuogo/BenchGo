import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Commander } from '../src/runtime.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'commander-store-'));
  const stores = [];
  t.after(async () => {
    await Promise.allSettled(stores.map(store => store.close()));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, store() { const store = new Store(directory); stores.push(store); return store; } };
}

async function childStore(t, directory) {
  const child = spawn(process.execPath, ['--import', new URL('../../../scripts/source-loader.mjs', import.meta.url).href, '--input-type=module', '-e', `
    import { Store } from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)};
    const store = new Store(process.argv[1]);
    process.on('message', async message => {
      if (message !== 'open') return;
      try { await store.open(); process.send({ opened: true }); }
      catch (error) { process.send({ opened: false, message: error.message, code: error.code }); }
    });
    process.send({ ready: true });
  `, directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const ready = await Promise.race([once(child, 'message'), exited.then(([code]) => { throw new Error(`Store fixture exited before ready (${code}): ${stderr}`); })]);
  assert.deepEqual(ready[0], { ready: true });
  return { child, exited, async open() { const reply = once(child, 'message'); child.send('open'); return (await reply)[0]; } };
}

test('killed owner restarts from its persisted sessions without manual lock removal', { timeout: 10000 }, async t => {
  const f = await fixture(t), sessions = [{ id: 'kept-session', nativeId: 'native-thread', receipts: { 'input-1': { receipt: { status: 'accepted' } } } }];
  await writeFile(join(f.directory, 'sessions.json'), JSON.stringify({ version: 1, sessions }));
  const owner = await childStore(t, f.directory);
  assert.deepEqual(await owner.open(), { opened: true });
  const oldLock = await readFile(join(f.directory, 'owner.lock'), 'utf8');
  owner.child.kill('SIGKILL'); await owner.exited;
  assert.equal(await readFile(join(f.directory, 'owner.lock'), 'utf8'), oldLock);
  const restarted = f.store();
  assert.deepEqual(await restarted.open(), { version: 1, sessions });
  const newLock = JSON.parse(await readFile(join(f.directory, 'owner.lock'), 'utf8'));
  assert.equal(newLock.pid, process.pid); assert.equal(newLock.host, hostname()); assert.equal(typeof newLock.token, 'string');
  assert.notEqual(JSON.stringify(newLock), oldLock);
});

test('legacy PID and hostname locks are recovered only after their real owner exits', { timeout: 10000 }, async t => {
  const f = await fixture(t), owner = await childStore(t, f.directory);
  const legacy = JSON.stringify({ pid: owner.child.pid, host: hostname() });
  await writeFile(join(f.directory, 'owner.lock'), legacy);
  await assert.rejects(f.store().open(), error => error.code === 'BENCHGO_DATA_LOCKED');
  assert.equal(await readFile(join(f.directory, 'owner.lock'), 'utf8'), legacy);
  owner.child.kill('SIGKILL'); await owner.exited;
  assert.deepEqual(await f.store().open(), { version: 1, sessions: [] });
});

test('concurrent processes recovering the same killed owner admit exactly one writer', { timeout: 15000 }, async t => {
  const f = await fixture(t), owner = await childStore(t, f.directory);
  assert.equal((await owner.open()).opened, true);
  owner.child.kill('SIGKILL'); await owner.exited;
  const contenders = await Promise.all(Array.from({ length: 5 }, () => childStore(t, f.directory)));
  const results = await Promise.all(contenders.map(contender => contender.open()));
  assert.equal(results.filter(result => result.opened).length, 1, JSON.stringify(results));
  assert.ok(results.filter(result => !result.opened).every(result => result.code === 'BENCHGO_DATA_LOCKED'));
  const winner = contenders[results.findIndex(result => result.opened)];
  assert.equal(JSON.parse(await readFile(join(f.directory, 'owner.lock'), 'utf8')).pid, winner.child.pid);
});

test('close releases ownership and repeated close preserves the successor lock', async t => {
  const f = await fixture(t), first = f.store(), next = f.store();
  await first.open(); await first.save([{ id: 'persisted' }]); await first.close();
  assert.deepEqual(await next.open(), { version: 1, sessions: [{ id: 'persisted' }] });
  const record = await readFile(join(f.directory, 'owner.lock'), 'utf8');
  await first.close();
  assert.equal(await readFile(join(f.directory, 'owner.lock'), 'utf8'), record);
  await next.close();
  await assert.rejects(access(join(f.directory, 'owner.lock')), { code: 'ENOENT' });
});

test('close refuses to delete a lock with a different ownership token', async t => {
  const f = await fixture(t), owner = f.store(); await owner.open();
  const successor = JSON.stringify({ pid: process.pid, host: hostname(), token: 'successor' });
  await writeFile(join(f.directory, 'owner.lock'), successor);
  await assert.rejects(owner.close(), error => error.code === 'BENCHGO_LOCK_OWNERSHIP_CHANGED');
  assert.equal(await readFile(join(f.directory, 'owner.lock'), 'utf8'), successor);
  await owner.close();
  assert.equal(await readFile(join(f.directory, 'owner.lock'), 'utf8'), successor);
});

test('untrusted locks retain their bytes and do not probe invalid or foreign PIDs', async t => {
  const f = await fixture(t), path = join(f.directory, 'owner.lock');
  const records = [
    '{broken json', 'null', JSON.stringify({ pid: 0, host: hostname() }), JSON.stringify({ pid: -1, host: hostname() }),
    JSON.stringify({ pid: 1.5, host: hostname() }), JSON.stringify({ pid: '12', host: hostname() }),
    JSON.stringify({ pid: 2147483648, host: hostname() }), JSON.stringify({ pid: process.pid }),
    JSON.stringify({ pid: process.pid, host: `${hostname()}-other` }),
  ];
  const probe = t.mock.method(process, 'kill', () => { throw new Error('untrusted PID must not be probed'); });
  for (const record of records) {
    await writeFile(path, record);
    await assert.rejects(f.store().open(), error => ['BENCHGO_LOCK_UNREADABLE', 'BENCHGO_LOCK_OTHER_HOST'].includes(error.code));
    assert.equal(await readFile(path, 'utf8'), record);
  }
  assert.equal(probe.mock.callCount(), 0);
});

test('permission-denied owner probes preserve the lock instead of taking over', async t => {
  const f = await fixture(t), path = join(f.directory, 'owner.lock');
  const record = JSON.stringify({ pid: process.pid, host: hostname() }); await writeFile(path, record);
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); });
  await assert.rejects(f.store().open(), error => error.code === 'BENCHGO_LOCK_PROBE_FAILED' && error.cause.code === 'EPERM');
  assert.equal(await readFile(path, 'utf8'), record);
});

test('corrupt session JSON is retained while failed startup releases its owner lock', async t => {
  const f = await fixture(t), path = join(f.directory, 'sessions.json'), corrupt = '{unfinished';
  await writeFile(path, corrupt);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(f.store().open(), SyntaxError);
    assert.equal(await readFile(path, 'utf8'), corrupt);
    await assert.rejects(access(join(f.directory, 'owner.lock')), { code: 'ENOENT' });
  }
});

test('runtime hydration failures release ownership without rewriting stored sessions', async t => {
  const f = await fixture(t), path = join(f.directory, 'sessions.json');
  for (const invalid of [{ version: 1, sessions: [null] }, { version: 1, sessions: [{ id: 'broken', status: 'running' }] }, null]) {
    const bytes = JSON.stringify(invalid); await writeFile(path, bytes);
    const runtime = new Commander({ dataDir: f.directory });
    await assert.rejects(runtime.open());
    assert.equal(runtime.sessions.size, 0);
    assert.equal(await readFile(path, 'utf8'), bytes);
    await assert.rejects(access(join(f.directory, 'owner.lock')), { code: 'ENOENT' });
  }
});

test('pretty-printed v1 snapshots retain their schema and records when saved compactly', async t => {
  const f = await fixture(t), store = f.store();
  const state = { version: 1, sessions: [{ id: 'kept', nativeId: 'native', events: [{ seq: 1 }], receipts: { request: { text: '保留输入', receipt: { status: 'accepted' } } } }] };
  await writeFile(join(f.directory, 'sessions.json'), JSON.stringify(state, null, 2));
  assert.deepEqual(await store.open(), state);
  await store.save(state.sessions);
  const saved = await readFile(join(f.directory, 'sessions.json'), 'utf8');
  assert.deepEqual(JSON.parse(saved), state);
  assert.equal(saved, JSON.stringify(state));
});

test('slow writes coalesce pending states without serializing or acknowledging them early', async t => {
  const f = await fixture(t), store = f.store(); await store.open();
  const started = [deferred(), deferred()], release = [deferred(), deferred()];
  const write = store.writeSnapshot.bind(store);
  let writes = 0, serializations = 0, pendingSettled = false;
  t.mock.method(store, 'writeSnapshot', async sessions => {
    const index = writes++;
    started[index].resolve(); await release[index].promise;
    return write(sessions);
  });
  const state = revision => [{ toJSON() { serializations++; return { id: 'session', revision }; } }];
  try {
    const first = store.save(state(0)); await started[0].promise;
    const callers = Array.from({ length: 100 }, (_, index) => store.save(state(index + 1)));
    callers[0].then(() => { pendingSettled = true; });
    assert.ok(callers.every(promise => promise === callers[0]));
    assert.equal(serializations, 0);
    assert.equal(writes, 1);
    release[0].resolve(); await first; await started[1].promise;
    assert.equal(serializations, 1);
    assert.equal(pendingSettled, false);
    assert.equal(JSON.parse(await readFile(join(f.directory, 'sessions.json'), 'utf8')).sessions[0].revision, 0);
    release[1].resolve(); await Promise.all(callers);
    assert.equal(serializations, 2);
    assert.equal(writes, 2);
    assert.equal(JSON.parse(await readFile(join(f.directory, 'sessions.json'), 'utf8')).sessions[0].revision, 100);
  } finally { for (const gate of release) gate.resolve(); }
});

test('a failed in-flight write rejects its callers without losing the pending durable barrier', async t => {
  const f = await fixture(t), store = f.store(); await store.open();
  const started = [deferred(), deferred()], release = [deferred(), deferred()];
  const write = store.writeSnapshot.bind(store);
  let writes = 0, pendingSettled = false;
  t.mock.method(store, 'writeSnapshot', async sessions => {
    const index = writes++;
    started[index].resolve(); await release[index].promise;
    if (!index) throw new Error('disk write failed');
    return write(sessions);
  });
  try {
    const failed = assert.rejects(store.save([{ id: 'old' }]), /disk write failed/);
    await started[0].promise;
    const pending = store.save([{ id: 'latest' }]);
    pending.then(() => { pendingSettled = true; });
    release[0].resolve(); await failed; await started[1].promise;
    assert.equal(pendingSettled, false);
    await assert.rejects(access(join(f.directory, 'sessions.json')), { code: 'ENOENT' });
    release[1].resolve(); await pending;
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'sessions.json'), 'utf8')).sessions, [{ id: 'latest' }]);
  } finally { for (const gate of release) gate.resolve(); }
});

test('a failed coalesced write rejects all its callers and a later save can recover', async t => {
  const f = await fixture(t), store = f.store(); await store.open();
  const release = deferred(), started = deferred(), write = store.writeSnapshot.bind(store);
  let writes = 0;
  t.mock.method(store, 'writeSnapshot', async sessions => {
    const index = writes++;
    if (!index) { started.resolve(); await release.promise; }
    if (index === 1) throw new Error('latest snapshot failed');
    return write(sessions);
  });
  try {
    const first = store.save([{ id: 'baseline' }]); await started.promise;
    const second = assert.rejects(store.save([{ id: 'intermediate' }]), /latest snapshot failed/);
    const third = assert.rejects(store.save([{ id: 'latest' }]), /latest snapshot failed/);
    release.resolve(); await Promise.all([first, second, third]);
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'sessions.json'), 'utf8')).sessions, [{ id: 'baseline' }]);
    await store.save([{ id: 'recovered' }]);
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'sessions.json'), 'utf8')).sessions, [{ id: 'recovered' }]);
    assert.equal(writes, 3);
  } finally { release.resolve(); }
});

test('failed atomic replacement cleans its temporary file and permits a subsequent save', async t => {
  const f = await fixture(t), store = f.store(); await store.open();
  const target = join(f.directory, 'sessions.json');
  await mkdir(target);
  await assert.rejects(store.save([{ id: 'blocked' }]));
  assert.deepEqual((await readdir(f.directory)).filter(name => name.endsWith('.tmp')), []);
  await rm(target, { recursive: true });
  await store.save([{ id: 'recovered' }]);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')).sessions, [{ id: 'recovered' }]);
});

test('close flushes the latest pending state before releasing ownership and rejects later saves', async t => {
  const f = await fixture(t), store = f.store(); await store.open();
  const started = [deferred(), deferred()], release = [deferred(), deferred()];
  const write = store.writeSnapshot.bind(store);
  let writes = 0, closed = false;
  t.mock.method(store, 'writeSnapshot', async sessions => {
    const index = writes++;
    started[index].resolve(); await release[index].promise;
    return write(sessions);
  });
  try {
    const first = store.save([{ id: 'old' }]); await started[0].promise;
    const latest = store.save([{ id: 'latest' }]);
    const closing = store.close().then(() => { closed = true; });
    await assert.rejects(store.save([{ id: 'too-late' }]), /store is closing/);
    release[0].resolve(); await first; await started[1].promise;
    assert.equal(closed, false);
    await access(join(f.directory, 'owner.lock'));
    await assert.rejects(f.store().open(), error => error.code === 'BENCHGO_DATA_LOCKED');
    release[1].resolve(); await Promise.all([latest, closing]);
    const next = f.store();
    assert.deepEqual(await next.open(), { version: 1, sessions: [{ id: 'latest' }] });
    assert.equal(writes, 2);
  } finally { for (const gate of release) gate.resolve(); }
});
