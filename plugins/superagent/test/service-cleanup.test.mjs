import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupAssistant } from '../src/service-cleanup.mjs';
import { DataOwner } from '../../benchgo/shared/data-owner.mjs';
import { mountAssistant } from '../src/service.mjs';

async function owned(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-assistant-cleanup-'));
  const owner = new DataOwner(directory);
  await owner.open();
  t.after(async () => { await owner.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  return { directory, owner };
}

test('an unregister failure still closes stores and releases ownership for the next instance', async t => {
  const { owner, directory } = await owned(t);
  const calls = [], failure = Error('remote registration already disposed');
  await assert.rejects(cleanupAssistant({
    halt: [() => calls.push('abort')],
    stop: [async () => calls.push('writer-stopped')],
    detach: [() => { throw failure; }, () => calls.push('credentials-disposed')],
    close: [() => calls.push('database-closed'), async () => calls.push('store-closed')],
    release: () => owner.close(),
  }), error => error instanceof AggregateError && error.errors.includes(failure));
  assert.deepEqual(calls, ['abort', 'writer-stopped', 'credentials-disposed', 'database-closed', 'store-closed']);
  const successor = new DataOwner(directory);
  await successor.open();
  await successor.close();
});

test('a synchronous watchdog stop failure cannot skip the other shutdown callbacks or release an unsafe writer', async t => {
  const { owner, directory } = await owned(t);
  const before = await readFile(join(directory, 'owner.lock'), 'utf8');
  const calls = [], failure = Error('watchdog stop failed');
  await assert.rejects(cleanupAssistant({
    halt: [() => { throw failure; }, () => calls.push('abort')],
    stop: [() => calls.push('engine-stopped'), async () => calls.push('worker-stopped')],
    detach: [() => calls.push('remote-removed')],
    close: [() => calls.push('store-closed')], release: () => owner.close(),
  }), error => error.errors.includes(failure));
  assert.deepEqual(calls, ['abort', 'engine-stopped', 'worker-stopped', 'remote-removed']);
  assert.equal(await readFile(join(directory, 'owner.lock'), 'utf8'), before);
  await assert.rejects(new DataOwner(directory).open(), { code: 'BENCHGO_DATA_LOCKED' });
});

test('all producer shutdowns settle before storage closes and any failed producer keeps ownership', async t => {
  const { owner, directory } = await owned(t);
  const pending = Promise.withResolvers(), calls = [], failure = Error('worker still active');
  const cleanup = cleanupAssistant({ stop: [() => { throw failure; }, async () => { await pending.promise; calls.push('stopped'); }],
    detach: [() => calls.push('detached')], close: [() => calls.push('closed')], release: () => owner.close() });
  const rejected = assert.rejects(cleanup, error => error.errors.includes(failure));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []);
  pending.resolve();
  await rejected;
  assert.deepEqual(calls, ['stopped', 'detached']);
  await assert.rejects(new DataOwner(directory).open(), { code: 'BENCHGO_DATA_LOCKED' });
});

test('a database close failure still attempts every other store close and preserves ownership', async t => {
  const { owner, directory } = await owned(t);
  const calls = [], failure = Error('database close failed');
  await assert.rejects(cleanupAssistant({ close: [() => { throw failure; }, () => calls.push('other-store-closed')],
    release: () => owner.close() }), error => error.errors.includes(failure));
  assert.deepEqual(calls, ['other-store-closed']);
  await assert.rejects(new DataOwner(directory).open(), { code: 'BENCHGO_DATA_LOCKED' });
});

test('ownership release preserves a changed successor lock and reports the error', async t => {
  const { owner, directory } = await owned(t);
  const path = join(directory, 'owner.lock'), prior = JSON.parse(await readFile(path, 'utf8'));
  const successorRecord = JSON.stringify({ ...prior, token: 'successor-owned-lock' });
  await writeFile(path, successorRecord);
  await assert.rejects(cleanupAssistant({ release: () => owner.close() }), error =>
    error instanceof AggregateError && error.errors.some(cause => cause.code === 'BENCHGO_LOCK_OWNERSHIP_CHANGED'));
  assert.equal(await readFile(path, 'utf8'), successorRecord);
});

test('an initialization failure after opening the real assistant store still closes and releases it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-assistant-init-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const failure = Error('context already disposed during initialization');
  const ctx = { effect() { throw failure; } };
  await assert.rejects(mountAssistant(ctx, { store: { directory } }, {}), error => error === failure);
  const successor = new DataOwner(join(directory, 'assistant'));
  await successor.open();
  await successor.close();
});
