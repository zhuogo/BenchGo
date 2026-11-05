import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDefaultDataDirectory, prepareVoiceDataDirectory } from '../src/data-directory.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'benchgo-data-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, previous: join(home, '.dowork', 'commander'), current: join(home, '.benchgo') };
}

test('moves all legacy plugin data and remains idempotent', async t => {
  const { home, previous, current } = await fixture(t);
  await mkdir(join(previous, 'link'), { recursive: true });
  await writeFile(join(previous, 'sessions.json'), 'sessions');
  await writeFile(join(previous, 'link', 'devices.json'), 'devices');
  assert.equal(await prepareDefaultDataDirectory(home), current);
  assert.equal(await readFile(join(current, 'sessions.json'), 'utf8'), 'sessions');
  assert.equal(await readFile(join(current, 'link', 'devices.json'), 'utf8'), 'devices');
  await assert.rejects(access(previous), { code: 'ENOENT' });
  assert.equal(await prepareDefaultDataDirectory(home), current);
});

test('creates a new directory when no legacy data exists', async t => {
  const { home, current } = await fixture(t);
  assert.equal(await prepareDefaultDataDirectory(home), current);
  await access(current);
});

test('existing destination wins without merging or overwriting either directory', async t => {
  const { home, previous, current } = await fixture(t);
  await mkdir(previous, { recursive: true });
  await mkdir(current);
  await writeFile(join(previous, 'sessions.json'), 'old');
  await writeFile(join(current, 'sessions.json'), 'new');
  await prepareDefaultDataDirectory(home);
  assert.equal(await readFile(join(previous, 'sessions.json'), 'utf8'), 'old');
  assert.equal(await readFile(join(current, 'sessions.json'), 'utf8'), 'new');
});

test('refuses migration while the previous owner process is alive', async t => {
  const { home, previous, current } = await fixture(t);
  await mkdir(previous, { recursive: true });
  const record = JSON.stringify({ pid: process.pid, host: hostname() });
  await writeFile(join(previous, 'owner.lock'), record);
  await assert.rejects(prepareDefaultDataDirectory(home), { code: 'BENCHGO_DATA_LOCKED' });
  assert.equal(await readFile(join(previous, 'owner.lock'), 'utf8'), record);
  await assert.rejects(access(current), { code: 'ENOENT' });
});

test('preserves unverified owner locks', async t => {
  const { home, previous } = await fixture(t);
  await mkdir(previous, { recursive: true });
  for (const [record, code] of [['invalid', 'BENCHGO_LOCK_UNREADABLE'], [JSON.stringify({ pid: process.pid, host: `${hostname()}-other` }), 'BENCHGO_LOCK_OTHER_HOST']]) {
    await writeFile(join(previous, 'owner.lock'), record);
    await assert.rejects(prepareDefaultDataDirectory(home), { code });
    assert.equal(await readFile(join(previous, 'owner.lock'), 'utf8'), record);
  }
});

test('moves a stale owner lock for the Store to recover after migration', async t => {
  const { home, previous, current } = await fixture(t);
  await mkdir(previous, { recursive: true });
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  const record = JSON.stringify({ pid: child.pid, host: hostname() });
  await writeFile(join(previous, 'owner.lock'), record);
  await prepareDefaultDataDirectory(home);
  assert.equal(await readFile(join(current, 'owner.lock'), 'utf8'), record);
  await assert.rejects(access(previous), { code: 'ENOENT' });
});

test('concurrent preparations migrate exactly once', async t => {
  const { home, previous, current } = await fixture(t);
  await mkdir(previous, { recursive: true });
  await writeFile(join(previous, 'sessions.json'), 'kept');
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => prepareDefaultDataDirectory(home))), Array(5).fill(current));
  assert.equal(await readFile(join(current, 'sessions.json'), 'utf8'), 'kept');
  await assert.rejects(access(previous), { code: 'ENOENT' });
});

test('moves legacy voice data from the configured official home into BenchGo', async t => {
  const { home, current } = await fixture(t);
  const dshHome = join(home, 'official-home');
  await mkdir(join(dshHome, 'voice'), { recursive: true });
  await writeFile(join(dshHome, 'voice', 'config.json'), 'voice-settings');
  await prepareDefaultDataDirectory(home);
  assert.equal(await prepareVoiceDataDirectory({ home, dshHome }), join(current, 'voice'));
  assert.equal(await readFile(join(current, 'voice', 'config.json'), 'utf8'), 'voice-settings');
  await assert.rejects(access(join(dshHome, 'voice')), { code: 'ENOENT' });
});

test('keeps existing BenchGo voice data and original voice data intact', async t => {
  const { home, current } = await fixture(t);
  const dshHome = join(home, '.dsh');
  await mkdir(join(dshHome, 'voice'), { recursive: true });
  await mkdir(join(current, 'voice'), { recursive: true });
  await writeFile(join(dshHome, 'voice', 'config.json'), 'old');
  await writeFile(join(current, 'voice', 'config.json'), 'new');
  await prepareVoiceDataDirectory({ home, dshHome });
  assert.equal(await readFile(join(current, 'voice', 'config.json'), 'utf8'), 'new');
  assert.equal(await readFile(join(dshHome, 'voice', 'config.json'), 'utf8'), 'old');
});

test('opening voice first also preserves and migrates legacy plugin data', async t => {
  const { home, previous, current } = await fixture(t);
  await mkdir(previous, { recursive: true });
  await writeFile(join(previous, 'sessions.json'), 'sessions');
  await prepareVoiceDataDirectory({ home });
  assert.equal(await readFile(join(current, 'sessions.json'), 'utf8'), 'sessions');
  await access(join(current, 'voice'));
});
