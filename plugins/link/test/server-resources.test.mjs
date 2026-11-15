import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ensureServerResources, SERVER_RESOURCE_FILES } from '../../benchgo/shared/server-resources.mjs';
import { createServerManager } from '../src/server/manager.mjs';
const tar = createRequire(new URL('../../benchgo/package.json', import.meta.url))('tar');
const digest = value => createHash('sha256').update(value).digest('hex');
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const expected = { schemaVersion: 1, delivery: 'online', releaseVersion: '2.0.0', pluginVersion: '1.2.3', harnessVersion: '0.2.2-rc.1', harnessCommit: 'a'.repeat(40), sourceDigest: 'c'.repeat(64) };

async function fixture(t, { corruptArchive = false, engine = expected.harnessVersion, badSignature = false, duplicate = false, linked = false, slow = false, delivery = 'online' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-server-resources-'));
  const assetsRoot = join(root, 'assets'), cacheRoot = join(root, 'cache'), stage = join(root, 'stage'), name = 'benchgo-1.0.0-linux-server';
  const directory = join(stage, name);
  await mkdir(assetsRoot); await mkdir(directory, { recursive: true });
  const payload = Buffer.from('isolated server deployment seed');
  const manifest = { schemaVersion: 1, pluginVersion: expected.pluginVersion, harnessVersion: engine, harnessCommit: expected.harnessCommit, sourceDigest: expected.sourceDigest, sha256: digest(payload) };
  const files = {
    'bootstrap.sh': Buffer.from('#!/usr/bin/env bash\nprintf fixture\n'),
    'bootstrap.mjs': Buffer.from('export const fixture = true;\n'),
    'server-seed.tar.gz': payload,
    'manifest.json': Buffer.from(JSON.stringify(manifest)),
    'release-source.json': Buffer.from(JSON.stringify({ schemaVersion: 1, sourceSha: 'b'.repeat(40), version: '1.0.0', pluginVersion: expected.pluginVersion,
      platform: 'linux', arch: 'x64', kind: 'server', engine: { version: engine, commit: expected.harnessCommit } })),
  };
  for (const [name, value] of Object.entries(files)) await writeFile(join(directory, name), value);
  if (linked) {
    await rm(join(directory, 'bootstrap.sh'));
    await symlink(join(directory, 'bootstrap.mjs'), join(directory, 'bootstrap.sh'), process.platform === 'win32' ? 'file' : undefined);
  }
  const archiveFile = join(root, 'server.tar.gz');
  await tar.c({ file: archiveFile, cwd: stage, gzip: true, portable: true, noMtime: true }, duplicate ? [name, `${name}/bootstrap.sh`] : [name]);
  const archive = await readFile(archiveFile);
  const artifact = { target: 'linux-server', kind: 'server', arch: 'x64', version: '1.0.0', url: `https://github.com/zhuogo/BenchGo/releases/download/v2.0.0/${name}.tar.gz`, size: archive.length, sha256: digest(archive) };
  const catalog = { schemaVersion: 1, releaseVersion: expected.releaseVersion, sourceSha: 'b'.repeat(40), files: [artifact,
    { target: 'plugin', version: expected.pluginVersion, url: 'https://github.com/zhuogo/BenchGo/releases/download/v2.0.0/benchgo-1.2.3-plugin.tar.gz', size: 1, sha256: 'd'.repeat(64) }] };
  const catalogBytes = Buffer.from(JSON.stringify(catalog));
  const signature = Buffer.from((badSignature ? Buffer.alloc(64) : sign(null, catalogBytes, keys.privateKey)).toString('base64'));
  const archiveBytes = corruptArchive ? Buffer.concat([Buffer.from('x'), archive.subarray(1)]) : archive;
  const bodies = new Map([['downloads.json', catalogBytes], ['downloads.json.sig', signature], [`${name}.tar.gz`, archiveBytes]]);
  const requests = [], openResponses = new Set();
  const server = createServer((req, res) => {
    const file = new URL(req.url, 'http://localhost').pathname.split('/').at(-1); requests.push(file);
    const bytes = bodies.get(file);
    if (!bytes) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-length': bytes.length });
    if (slow && file.endsWith('.tar.gz')) { openResponses.add(res); res.once('close', () => openResponses.delete(res)); res.write(bytes.subarray(0, 5)); return; }
    res.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetcher = (url, options) => fetch(origin + new URL(url).pathname, options);
  await writeFile(join(assetsRoot, 'resources.json'), JSON.stringify({ ...expected, delivery }));
  await writeFile(join(assetsRoot, 'update-public-key.pem'), publicKey);
  t.after(async () => { for (const response of openResponses) response.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { root, assetsRoot, cacheRoot, requests, files, fetcher, options: { assetsRoot, cacheRoot, source: 'github', fetcher } };
}

test('fixed signed release is downloaded, safely extracted and reused offline from a verified atomic cache', async t => {
  const f = await fixture(t), progress = [];
  const first = await ensureServerResources({ ...f.options, onProgress: event => progress.push(event) });
  assert.equal(first.origin, 'download'); assert.equal(first.manifest.pluginVersion, expected.pluginVersion);
  assert.equal(progress.some(event => event.stage === 'downloading' && event.total > 0 && event.transferred === event.total), true);
  assert.deepEqual(f.requests.sort(), ['benchgo-1.0.0-linux-server.tar.gz', 'downloads.json', 'downloads.json.sig']);
  for (const name of SERVER_RESOURCE_FILES) assert.deepEqual(await readFile(join(first.directory, name)), f.files[name]);
  const count = f.requests.length;
  const second = await ensureServerResources({ ...f.options, fetcher: () => { throw new Error('cache must work offline'); } });
  assert.equal(second.origin, 'cache'); assert.equal(second.directory, first.directory); assert.equal(f.requests.length, count);
  assert.equal((await readdir(f.cacheRoot)).some(name => name.endsWith('.lock') || name.startsWith('.prepare-')), false);
  assert.equal((await readdir(first.directory)).includes('distribution.tar.gz'), true);
});

for (const delivery of ['full', 'online']) test(`complete offline resources are preferred without a network request (${delivery})`, async t => {
  const f = await fixture(t, { delivery });
  for (const name of SERVER_RESOURCE_FILES) await writeFile(join(f.assetsRoot, name), f.files[name]);
  const result = await ensureServerResources({ ...f.options, fetcher: () => { throw new Error('offline must not download'); } });
  assert.equal(result.origin, 'offline'); assert.equal(result.directory, f.assetsRoot); assert.equal(f.requests.length, 0);
});

for (const delivery of ['full', 'online']) test(`partial or corrupted offline payloads fail explicitly without switching to the network (${delivery})`, async t => {
  const f = await fixture(t, { delivery });
  await writeFile(join(f.assetsRoot, 'bootstrap.sh'), f.files['bootstrap.sh']);
  await assert.rejects(ensureServerResources(f.options), /不完整/);
  for (const name of SERVER_RESOURCE_FILES) await writeFile(join(f.assetsRoot, name), f.files[name]);
  await writeFile(join(f.assetsRoot, 'server-seed.tar.gz'), 'corrupted');
  await assert.rejects(ensureServerResources(f.options), /校验失败/); assert.equal(f.requests.length, 0);
});

test('a full delivery with every offline resource missing fails without cache reuse or a network request', async t => {
  const f = await fixture(t);
  await ensureServerResources(f.options);
  const requestCount = f.requests.length;
  await writeFile(join(f.assetsRoot, 'resources.json'), JSON.stringify({ ...expected, delivery: 'full' }));
  await assert.rejects(ensureServerResources(f.options), /不完整/);
  assert.equal(f.requests.length, requestCount);
  await rm(f.cacheRoot, { recursive: true });
  await assert.rejects(ensureServerResources(f.options), /不完整/);
  await assert.rejects(readdir(f.cacheRoot), { code: 'ENOENT' });
  assert.equal(f.requests.length, requestCount);
});

test('a descriptor must explicitly declare full or online delivery', async t => {
  const f = await fixture(t);
  for (const delivery of [undefined, null, '', 'legacy']) {
    await writeFile(join(f.assetsRoot, 'resources.json'), JSON.stringify({ ...expected, delivery }));
    await assert.rejects(ensureServerResources(f.options), /描述无效/);
  }
  assert.equal(f.requests.length, 0);
  await assert.rejects(readdir(f.cacheRoot), { code: 'ENOENT' });
});

for (const [label, options, message] of [
  ['invalid signature', { badSignature: true }, /签名/],
  ['changed archive', { corruptArchive: true }, /完整性/],
  ['mismatched engine', { engine: '0.2.1' }, /不兼容/],
  ['duplicate archive entry', { duplicate: true }, /不安全或重复/],
  ['symbolic link archive entry', { linked: true }, /不安全或重复/],
]) test(`unsafe deployment resource is rejected: ${label}`, async t => {
  const f = await fixture(t, options);
  await assert.rejects(ensureServerResources(f.options), message);
  const files = await readdir(f.cacheRoot); assert.deepEqual(files, []);
});

test('a forged writable cache receipt cannot authorize changed scripts; the same source safely repairs them', async t => {
  const f = await fixture(t), result = await ensureServerResources(f.options);
  await writeFile(join(result.directory, 'bootstrap.mjs'), 'tampered');
  await writeFile(join(result.directory, 'cache.json'), JSON.stringify({ files: { 'bootstrap.mjs': digest('tampered') } }));
  const progress = [], repaired = await ensureServerResources({ ...f.options, onProgress: value => progress.push(value) });
  assert.equal(repaired.origin, 'download');
  assert.deepEqual(await readFile(join(repaired.directory, 'bootstrap.mjs')), f.files['bootstrap.mjs']);
  assert.equal(progress.some(value => value.stage === 'repairing-cache'), true);
  assert.equal(f.requests.filter(name => name.endsWith('.tar.gz')).length, 2);
  assert.equal((await readdir(repaired.directory)).includes('cache.json'), false);
});

test('corrupt signed archive cache is downloaded again and never trusted by a local receipt', async t => {
  const f = await fixture(t), result = await ensureServerResources(f.options);
  await writeFile(join(result.directory, 'distribution.tar.gz'), 'tampered');
  const repaired = await ensureServerResources(f.options);
  assert.equal(repaired.origin, 'download'); assert.equal(f.requests.filter(name => name.endsWith('.tar.gz')).length, 2);
});

test('cache repair refuses symlink directories and preserves their targets', async t => {
  const f = await fixture(t), result = await ensureServerResources(f.options), outside = join(f.root, 'outside');
  await rm(result.directory, { recursive: true }); await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), 'preserve');
  await symlink(outside, result.directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(ensureServerResources(f.options), /阻止自动清理/);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'preserve');
});

test('an abandoned ownerless cache lock can be recovered without deleting unrelated files', async t => {
  const f = await fixture(t);
  const identity = digest(JSON.stringify([expected.releaseVersion, expected.pluginVersion, expected.harnessVersion, expected.harnessCommit])).slice(0, 24);
  const lock = join(f.cacheRoot, `${identity}.lock`);
  await mkdir(lock, { recursive: true });
  await utimes(lock, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
  await writeFile(join(f.cacheRoot, 'keep.txt'), 'preserve');
  assert.equal((await ensureServerResources(f.options)).origin, 'download');
  assert.equal(await readFile(join(f.cacheRoot, 'keep.txt'), 'utf8'), 'preserve');
});

for (const ownerless of [false, true]) test(`concurrent stale recovery preserves the new live owner (${ownerless ? 'ownerless' : 'dead process'} primary and recovery locks)`, async t => {
  const f = await fixture(t);
  const identity = digest(JSON.stringify([expected.releaseVersion, expected.pluginVersion, expected.harnessVersion, expected.harnessCommit])).slice(0, 24);
  const lock = join(f.cacheRoot, `${identity}.lock`), recovery = `${lock}.recovery`;
  await mkdir(lock, { recursive: true }); await mkdir(recovery);
  if (ownerless) {
    const abandoned = new Date(Date.now() - 10_000);
    await utimes(lock, abandoned, abandoned); await utimes(recovery, abandoned, abandoned);
  } else {
    const exited = spawnSync(process.execPath, ['-e', '']);
    assert.equal(exited.status, 0);
    assert.throws(() => process.kill(exited.pid, 0), { code: 'ESRCH' });
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: exited.pid, nonce: 'dead-primary' }));
    await writeFile(join(recovery, `owner-${exited.pid}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json`), '');
  }
  await writeFile(join(f.cacheRoot, 'keep.txt'), 'preserve');
  let checkedLiveOwner = false;
  const fetcher = async (url, options) => {
    if (new URL(url).pathname.endsWith('.tar.gz')) {
      const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
      assert.equal(owner.pid, process.pid); assert.equal(typeof owner.nonce, 'string');
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.deepEqual(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')), owner);
      checkedLiveOwner = true;
    }
    return f.fetcher(url, options);
  };
  const results = await Promise.all(Array.from({ length: 8 }, () => ensureServerResources({ ...f.options, fetcher, lockTimeoutMs: 5000 })));
  assert.equal(checkedLiveOwner, true);
  assert.equal(new Set(results.map(value => value.directory)).size, 1);
  assert.equal(results.filter(value => value.origin === 'download').length, 1);
  assert.equal(results.filter(value => value.origin === 'cache').length, 7);
  assert.equal(f.requests.filter(name => name.endsWith('.tar.gz')).length, 1);
  assert.equal(await readFile(join(f.cacheRoot, 'keep.txt'), 'utf8'), 'preserve');
  assert.deepEqual((await readdir(f.cacheRoot)).sort(), [identity, 'keep.txt'].sort());
});

test('a live recovery owner is preserved when another caller times out', async t => {
  const f = await fixture(t);
  const identity = digest(JSON.stringify([expected.releaseVersion, expected.pluginVersion, expected.harnessVersion, expected.harnessCommit])).slice(0, 24);
  const recovery = join(f.cacheRoot, `${identity}.lock.recovery`), marker = `owner-${process.pid}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json`;
  await mkdir(recovery, { recursive: true }); await writeFile(join(recovery, marker), '');
  await assert.rejects(ensureServerResources({ ...f.options, lockTimeoutMs: 100 }), /其他进程/);
  assert.deepEqual(await readdir(recovery), [marker]); assert.equal(f.requests.length, 0);
});

test('cancelling a stalled real download removes partial files and its lock; retry can succeed', async t => {
  const f = await fixture(t, { slow: true }), controller = new AbortController();
  await assert.rejects(ensureServerResources({ ...f.options, signal: controller.signal, onProgress(event) { if (event.stage === 'downloading') setTimeout(() => controller.abort(), 30); } }), /取消/);
  assert.deepEqual(await readdir(f.cacheRoot), []);
  // A second fixture uses the same release identity with an independent, healthy transport.
  const healthy = await fixture(t);
  const result = await ensureServerResources({ ...f.options, fetcher: healthy.fetcher });
  assert.equal(result.origin, 'download');
});

test('simultaneous callers share the completed cache rather than downloading a second copy', async t => {
  const f = await fixture(t);
  const results = await Promise.all([ensureServerResources(f.options), ensureServerResources(f.options)]);
  assert.equal(results[0].directory, results[1].directory);
  assert.deepEqual(results.map(value => value.origin).sort(), ['cache', 'download']);
  assert.equal(f.requests.filter(name => name.endsWith('.tar.gz')).length, 1);
});

test('prefetch is a recoverable owner job without SSH, a device record or secret exposure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-prefetch-job-'));
  const manager = createServerManager({ directory: root, resourceFetcher: async ({ onProgress }) => {
    onProgress({ stage: 'downloading', total: 100, transferred: 25 });
    return { origin: 'cache', manifest: { pluginVersion: '1.2.3' } };
  } });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const { jobId } = await manager.prefetch({ source: 'github' });
  let job;
  for (let count = 0; count < 50; count++) { job = await manager.job(jobId); if (job.state !== 'running') break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(job.kind, 'server-prefetch'); assert.equal(job.state, 'done'); assert.equal(job.device, undefined);
  assert.deepEqual(job.resources, { cached: true, origin: 'cache', version: '1.2.3' }); assert.equal(job.cancellable, false);
  assert.match(job.steps.find(step => step.message)?.message, /25%/);
  await assert.rejects(readFile(join(root, 'servers.json')), { code: 'ENOENT' });
});

test('owner can cancel resource acquisition and read back a cancelled terminal job', async t => {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-prefetch-cancel-'));
  const manager = createServerManager({ directory: root, resourceFetcher: async ({ signal, onProgress }) => {
    onProgress({ stage: 'checking' });
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const { jobId } = await manager.prefetch();
  for (let count = 0; count < 50 && !(await manager.job(jobId)).cancellable; count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(manager.cancelJob(jobId), { ok: true });
  let job;
  for (let count = 0; count < 50; count++) { job = await manager.job(jobId); if (job.state !== 'running') break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(job.state, 'cancelled'); assert.equal(job.device, undefined); assert.equal(job.cancellable, false);
});
