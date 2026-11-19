import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataOwner } from '../shared/data-owner.mjs';
import { ownerProcessExited } from '../shared/owner-process.mjs';

const run = promisify(execFile);
async function fixture(t, { old = false, processExited } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-owner-'));
  const path = join(directory, 'owner.lock');
  const record = JSON.stringify({ pid: process.pid, host: hostname(), token: 'previous-owner' });
  await writeFile(path, record);
  if (old) await utimes(path, new Date(0), new Date(0));
  const owner = new DataOwner(directory, { processExited });
  t.after(async () => { await owner.close(); await rm(directory, { recursive: true, force: true }); });
  return { owner, path, record };
}

test('opening an unlocked store does not probe another process', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-owner-unlocked-'));
  const owner = new DataOwner(directory, { processExited: () => assert.fail('unnecessary owner probe') });
  t.after(async () => { await owner.close(); await rm(directory, { recursive: true, force: true }); });
  await owner.open();
  assert.equal(JSON.parse(await readFile(join(directory, 'owner.lock'), 'utf8')).pid, process.pid);
});

test('Windows recovers an old owner lock when the live PID demonstrably started later', { skip: process.platform !== 'win32' }, async t => {
  const { owner, path, record } = await fixture(t, { old: true });
  await owner.open();
  const saved = await readFile(path, 'utf8');
  assert.notEqual(saved, record);
  assert.equal(JSON.parse(saved).pid, process.pid);
  assert.notEqual(JSON.parse(saved).token, 'previous-owner');
});

test('a real live owner keeps its lock', async t => {
  const { owner, path, record } = await fixture(t);
  await assert.rejects(owner.open(), { code: 'BENCHGO_DATA_LOCKED' });
  assert.equal(await readFile(path, 'utf8'), record);
});

for (const mode of ['failure', 'timeout']) test(`an unsuccessful Windows start-time query (${mode}) preserves even an old owner lock`, async t => {
  let called = false;
  const processExited = (pid, modifiedAt) => ownerProcessExited(pid, modifiedAt, { platform: 'win32', execute: (command, args, options) => {
    called = true;
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 2000);
    assert.ok(args.includes('-NoProfile') && args.includes('-NonInteractive'));
    // Exercise real execFile error/timeout handling without a slow PowerShell
    // startup or an unbounded fake promise in the ownership critical section.
    return run(process.execPath, ['-e', mode === 'failure' ? 'process.exit(3)' : 'setTimeout(() => {}, 30000)'],
      { ...options, ...(mode === 'timeout' ? { timeout: 50 } : {}) });
  } });
  const { owner, path, record } = await fixture(t, { old: true, processExited });
  await assert.rejects(owner.open(), { code: 'BENCHGO_DATA_LOCKED' });
  assert.equal(called, true);
  assert.equal(await readFile(path, 'utf8'), record);
});

test('process identity probing adds no child process for an exited PID or non-Windows host', async () => {
  const execute = () => assert.fail('unnecessary start-time query');
  assert.equal(await ownerProcessExited(123, 0, { platform: 'win32', execute,
    kill() { throw Object.assign(Error('gone'), { code: 'ESRCH' }); } }), true);
  assert.equal(await ownerProcessExited(process.pid, 0, { platform: 'linux', execute }), false);
});

test('Windows requires a valid start time more than one second after the lock modification', async () => {
  const modifiedAt = Date.parse('2026-11-17T00:00:00Z');
  const check = stdout => ownerProcessExited(process.pid, modifiedAt, { platform: 'win32', execute: async () => ({ stdout }) });
  for (const value of ['', '2099', 'invalid', '2026-11-17T00:00:00.0000000Z', '2026-11-17T00:00:01.0000000Z'])
    assert.equal(await check(value), false, value);
  assert.equal(await check('2026-11-17T00:00:01.0010000Z'), true);
});
