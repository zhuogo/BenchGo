import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_UPDATE_CONFIG, normalizeUpdateConfig, releaseDownloadUrl, resolveUpdateUrl,
  fetchVerifiedRelease, fetchUpdateBytes, validateReleaseManifest, compareVersions,
  isNewerVersion, isEngineCompatible, MAX_PLUGIN_BYTES, fetchUpdateArtifact,
} from '../shared/update-feed.mjs';
import { createUpdateManifest } from '../../../scripts/desktop/create-update-manifest.mjs';

const { publicKey: publicObject, privateKey } = generateKeyPairSync('ed25519');
const publicKey = publicObject.export({ type: 'spki', format: 'pem' });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const artifact = Buffer.from('test signed plugin archive');
const manifest = () => ({ schemaVersion: 1, version: '0.1.2', engine: { min: '0.2.1-alpha.3', max: '0.2.1-alpha.3' }, plugin: { version: '0.1.2', url: releaseDownloadUrl('benchgo-0.1.2-plugin.tar.gz', 'plugin-v0.1.2'), sha256: createHash('sha256').update(artifact).digest('hex'), size: artifact.byteLength } });
function feed(data = manifest(), transform) {
  const bytes = Buffer.from(JSON.stringify(data));
  const signature = sign(null, bytes, privateKey).toString('base64');
  return async url => new Response(url.endsWith('.sig') ? signature : transform ? transform(bytes) : bytes);
}

test('default source uses domestic mirror and selected source never silently changes', () => {
  const url = releaseDownloadUrl('benchgo-update.json');
  assert.equal(resolveUpdateUrl(url), `https://ghfast.top/${url}`);
  assert.deepEqual(normalizeUpdateConfig(), DEFAULT_UPDATE_CONFIG);
  assert.equal(resolveUpdateUrl(url, { source: 'github', mirrorUrl: 'invalid ignored field' }), url);
  assert.equal(resolveUpdateUrl(url, { source: 'custom', mirrorUrl: 'https://mirror.example/proxy' }), `https://mirror.example/proxy/${url}`);
});

test('source and artifact URLs reject credentials, injected URLs and unsafe basenames', () => {
  for (const mirrorUrl of ['http://mirror.example', 'https://user:pass@mirror.example', 'https://mirror.example/?key=secret', 'https://mirror.example/#token']) {
    assert.throws(() => normalizeUpdateConfig({ source: 'custom', mirrorUrl }), { code: 'UPDATE_SOURCE' });
  }
  assert.throws(() => normalizeUpdateConfig({ source: 'custom' }), { code: 'UPDATE_SOURCE' });
  for (const url of ['https://github.com/other/repo/releases/download/v1/x.tar.gz', 'https://evil.example/x.tar.gz', 'https://github.com/zhuogo/BenchGo/releases/download/v1/../../evil', 'https://github.com/zhuogo/BenchGo/releases/download/v1/%2e%2e.tar.gz', 'https://github.com/zhuogo/BenchGo/releases/download/v1/x.tar.gz?token=secret']) {
    assert.throws(() => resolveUpdateUrl(url), { code: 'UPDATE_URL' });
  }
});

test('manifest is authenticated before parsing and validates app independently', async () => {
  const data = manifest();
  data.app = { version: '0.1.0', url: releaseDownloadUrl('BenchGo-Setup.exe', 'v0.1.0') };
  const requested = [];
  const fetcher = feed(data);
  assert.deepEqual(await fetchVerifiedRelease({ publicKey, fetcher: url => { requested.push(url); return fetcher(url); } }), data);
  assert.deepEqual(requested, [
    'https://ghfast.top/https://github.com/zhuogo/BenchGo/releases/download/plugin-updates/benchgo-update.json',
    'https://ghfast.top/https://github.com/zhuogo/BenchGo/releases/download/plugin-updates/benchgo-update.json.sig',
  ]);
  await assert.rejects(fetchVerifiedRelease({ publicKey, fetcher: feed(data, bytes => Buffer.from(bytes.toString().replace('0.1.2', '0.1.3'))) }), { code: 'UPDATE_SIGNATURE' });
  const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  await assert.rejects(fetchVerifiedRelease({ publicKey: other, fetcher: feed() }), { code: 'UPDATE_SIGNATURE' });
  await assert.rejects(fetchVerifiedRelease({ publicKey, fetcher: async () => new Response('unsigned') }), { code: 'UPDATE_SIGNATURE' });
  const invalid = Buffer.from('{not json');
  await assert.rejects(fetchVerifiedRelease({ publicKey, fetcher: async url => new Response(url.endsWith('.sig') ? sign(null, invalid, privateKey).toString('base64') : invalid) }), { code: 'UPDATE_MANIFEST' });
});

test('signed manifests still require valid versions, ranges, size, hash and origin', async () => {
  for (const mutate of [
    data => { data.schemaVersion = 2; },
    data => { data.plugin.version = '0.1.3'; },
    data => { data.engine.max = '0.1.0'; },
    data => { data.plugin.url = 'https://evil.example/payload.tar.gz'; },
    data => { data.plugin.url = releaseDownloadUrl('payload.exe', 'v1'); },
    data => { data.plugin.size = 0; },
    data => { data.plugin.sha256 = 'bad'; },
    data => { data.version = data.plugin.version = '01.2.3'; },
    data => { data.notes = 'x'.repeat(16_385); },
  ]) {
    const data = manifest(); mutate(data);
    assert.throws(() => validateReleaseManifest(data));
    await assert.rejects(fetchVerifiedRelease({ publicKey, fetcher: feed(data) }));
  }
});

test('semver ordering respects prerelease, numeric identifiers and exact engine range', () => {
  const versions = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
  for (let index = 1; index < versions.length; index++) assert.equal(isNewerVersion(versions[index], versions[index - 1]), true);
  assert.equal(compareVersions('1.0.0+first', '1.0.0+second'), 0);
  assert.equal(isNewerVersion('0.1.1', '0.1.2'), false);
  assert.equal(isEngineCompatible('0.2.1-alpha.3', manifest().engine), true);
  assert.equal(isEngineCompatible('0.2.1-alpha.4', manifest().engine), false);
  assert.equal(isEngineCompatible('0.2.0', { min: '0.2.1-alpha.3' }), false);
  for (const version of ['1.0', 'v1.0.0', '1.0.0-01', '1.0.0-', '1.0.0+']) assert.throws(() => compareVersions(version, '1.0.0'));
});

test('network failures retain source and bound metadata length, timeout and redirects', async () => {
  const url = releaseDownloadUrl('benchgo-update.json');
  const calls = [];
  await assert.rejects(fetchUpdateBytes(url, { config: { source: 'github' }, fetcher: async target => { calls.push(target); throw Error('offline'); } }), { code: 'UPDATE_NETWORK' });
  assert.deepEqual(calls, [url]);
  await assert.rejects(fetchUpdateBytes(url, { fetcher: async () => new Response('x', { headers: { 'content-length': '262145' } }) }), { code: 'UPDATE_SIZE' });
  await assert.rejects(fetchUpdateBytes(url, { maxBytes: 3, fetcher: async () => new Response('1234') }), { code: 'UPDATE_SIZE' });
  await assert.rejects(fetchUpdateBytes(url, { timeoutMs: 10, fetcher: async () => new Promise(() => {}) }), { code: 'UPDATE_TIMEOUT' });
  await assert.rejects(fetchUpdateBytes(url, { fetcher: async () => new Response(null, { status: 404 }) }), { code: 'UPDATE_HTTP' });
  for (const location of ['http://github.com/x', 'https://evil.example/file', 'https://user:secret@github.com/x', 'https://github.com:8443/x']) {
    await assert.rejects(fetchUpdateBytes(url, { fetcher: async () => new Response(null, { status: 302, headers: { location } }) }), { code: 'UPDATE_REDIRECT' });
  }
  await assert.rejects(fetchUpdateBytes(url, { fetcher: async () => new Response(null, { status: 302, headers: { location: url } }) }), { code: 'UPDATE_REDIRECT' });
  let requests = 0;
  const bytes = await fetchUpdateBytes(url, { fetcher: async () => ++requests === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/a/file?signature=test' } }) : new Response('ok') });
  assert.equal(bytes.toString(), 'ok');
});

test('plugin downloads stream into a new file and verify signed size and hash before returning', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'benchgo-stream-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'plugin.tar.gz');
  const payload = manifest().plugin;
  const chunks = [artifact.subarray(0, 4), artifact.subarray(4, 12), artifact.subarray(12)];
  const fetcher = async () => new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }));
  const result = await fetchUpdateArtifact(payload, { file, fetcher });
  assert.equal(result.size, artifact.length);
  assert.deepEqual(await readFile(file), artifact);
  await assert.rejects(fetchUpdateArtifact(payload, { file, fetcher }), { code: 'EEXIST' });
  assert.deepEqual(await readFile(file), artifact, 'an existing download is never overwritten');
});

test('streamed artifact progress reports signed totals, real first and final bytes, and verification for small packages', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'benchgo-progress-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const progress = [], file = path.join(directory, 'plugin.tar.gz');
  await fetchUpdateArtifact(manifest().plugin, { file, fetcher: async () => new Response(artifact), onProgress: value => progress.push(value) });
  assert.equal(progress[0].stage, 'downloading'); assert.equal(progress[0].transferred, 0);
  assert.ok(progress.some(value => value.stage === 'downloading' && value.transferred === artifact.length));
  assert.equal(progress.at(-1).stage, 'verifying'); assert.equal(progress.at(-1).transferred, artifact.length);
  for (const [index, value] of progress.entries()) {
    assert.equal(value.total, artifact.length);
    assert.ok(Number.isFinite(value.bytesPerSecond) && value.bytesPerSecond >= 0);
    assert.ok(Number.isFinite(Date.parse(value.updatedAt)));
    if (index) assert.ok(value.transferred >= progress[index - 1].transferred);
  }
  assert.ok(progress.some(value => value.bytesPerSecond > 0));
});

test('progress remains a verification stage on hash failure and never implies successful installation', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'benchgo-progress-hash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const progress = [], file = path.join(directory, 'plugin.tar.gz');
  await assert.rejects(fetchUpdateArtifact(manifest().plugin, { file, fetcher: async () => new Response(Buffer.alloc(artifact.length)), onProgress: value => progress.push(value) }), { code: 'UPDATE_HASH' });
  assert.equal(progress.at(-1).stage, 'verifying');
  assert.equal(progress.at(-1).transferred, artifact.length);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('a slow stream stays alive with real chunks while both idle and total deadlines remain bounded', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'benchgo-idle-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.mock.method(performance, 'now', () => Date.now());

  function startDownload(file, options) {
    let pendingPull = Promise.withResolvers();
    const cancel = t.mock.fn();
    const stream = new ReadableStream({
      pull(controller) { pendingPull.resolve(controller); },
      cancel,
    }, { highWaterMark: 0 });
    const result = fetchUpdateArtifact(manifest().plugin, { file, ...options, fetcher: async () => new Response(stream) });
    return {
      result,
      cancel,
      async nextPull() {
        // Wait for the reader to finish writing the previous chunk before advancing time.
        const controller = await Promise.race([pendingPull.promise, result.then(() => {
          throw new Error('Download finished before the next chunk was requested');
        })]);
        pendingPull = Promise.withResolvers();
        return controller;
      },
    };
  }

  const progress = [], file = path.join(directory, 'plugin.tar.gz');
  const slow = startDownload(file, { timeoutMs: 2000, idleTimeoutMs: 250, onProgress: value => progress.push(value) });
  for (let offset = 0; offset < artifact.length; offset += 6) {
    const controller = await slow.nextPull();
    t.mock.timers.tick(80);
    const end = Math.min(artifact.length, offset + 6);
    controller.enqueue(artifact.subarray(offset, end));
    if (end === artifact.length) controller.close();
  }
  await slow.result;
  assert.ok(Date.now() > 250, 'ongoing data can exceed the short inactivity interval');
  assert.deepEqual(await readFile(file), artifact);
  assert.ok(progress.some(value => value.transferred > 0 && value.transferred < artifact.length), 'a longer stream publishes intermediate bytes');
  const capped = path.join(directory, 'capped.tar.gz');
  const limited = startDownload(capped, { timeoutMs: 50, idleTimeoutMs: 1000 });
  for (let offset = 0; offset < 3; offset++) {
    const controller = await limited.nextPull();
    t.mock.timers.tick(15);
    controller.enqueue(artifact.subarray(offset, offset + 1));
  }
  await limited.nextPull();
  assert.deepEqual(await readFile(capped), artifact.subarray(0, 3));
  const rejected = assert.rejects(limited.result, { code: 'UPDATE_TIMEOUT' });
  t.mock.timers.tick(5);
  await rejected;
  assert.equal(limited.cancel.mock.callCount(), 1);
  await assert.rejects(readFile(capped), { code: 'ENOENT' });
});

test('idle streams and external cancellation clean partial files even when reader cancellation never settles', { timeout: 2000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'benchgo-cancel-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const external of [false, true]) {
    const signal = new AbortController(), stalled = Promise.withResolvers();
    let pulls = 0, cancelled = false;
    const file = path.join(directory, `${external}.tar.gz`);
    const operation = fetchUpdateArtifact(manifest().plugin, { file, signal: signal.signal, timeoutMs: 1000, idleTimeoutMs: external ? 1000 : 30,
      fetcher: async () => new Response(new ReadableStream({ pull(controller) {
        if (!pulls++) controller.enqueue(artifact.subarray(0, 2));
        else stalled.resolve();
      }, cancel() { cancelled = true; return new Promise(() => {}); } }, { highWaterMark: 0 })),
    });
    const rejected = assert.rejects(operation, { code: external ? 'UPDATE_CANCELLED' : 'UPDATE_TIMEOUT' });
    await stalled.promise;
    if (external) signal.abort();
    await rejected;
    assert.equal(cancelled, true);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  }
  let requests = 0;
  const signal = AbortSignal.abort(), file = path.join(directory, 'pre-cancelled.tar.gz');
  await assert.rejects(fetchUpdateArtifact(manifest().plugin, { file, signal, fetcher: async () => { requests++; return new Response(artifact); } }), { code: 'UPDATE_CANCELLED' });
  assert.equal(requests, 0);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('failed, oversized, corrupt or stalled streamed downloads remove partial files', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'benchgo-stream-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [index, code, fetcher] of [
    [0, 'UPDATE_HASH', async () => new Response(Buffer.alloc(artifact.length))],
    [1, 'UPDATE_SIZE', async () => new Response('short')],
    [2, 'UPDATE_SIZE', async () => new Response(Buffer.alloc(artifact.length + 1))],
    [3, 'UPDATE_TIMEOUT', async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(artifact.subarray(0, 2)); } }))],
    [4, 'UPDATE_TIMEOUT', () => new Promise(() => {})],
  ]) {
    const file = path.join(directory, `plugin-${index}.tar.gz`);
    await assert.rejects(fetchUpdateArtifact(manifest().plugin, { file, fetcher, timeoutMs: 25 }), { code });
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  }
});

test('release generator signs exact output and rejects a mismatched publishing key', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'benchgo-update-'));
  try {
    const pluginPath = path.join(dir, 'benchgo-0.1.2-plugin.tar.gz');
    await writeFile(pluginPath, artifact);
    const options = { pluginPath, outDir: dir, version: '0.1.2', engineVersion: '0.2.1-alpha.3', privateKey: privatePem, publicKey };
    assert.deepEqual(await createUpdateManifest(options), manifest());
    const bytes = await readFile(path.join(dir, 'benchgo-update.json'));
    const sig = await readFile(path.join(dir, 'benchgo-update.json.sig'));
    assert.deepEqual(await fetchVerifiedRelease({ publicKey, fetcher: async url => new Response(url.endsWith('.sig') ? sig : bytes) }), manifest());
    const wrong = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    await assert.rejects(createUpdateManifest({ ...options, publicKey: wrong }), /不匹配/);
    await assert.rejects(createUpdateManifest({ ...options, privateKey: undefined }), /缺少/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('missing metadata is a channel readiness state; missing signatures and missing artifacts remain failures', async () => {
  await assert.rejects(fetchVerifiedRelease({ publicKey, fetcher: async () => new Response(null, { status: 404 }) }), { code: 'UPDATE_UNPUBLISHED' });
  const valid = feed();
  await assert.rejects(fetchVerifiedRelease({ publicKey, fetcher: url => url.endsWith('.sig') ? new Response(null, { status: 404 }) : valid(url) }), { code: 'UPDATE_HTTP', httpStatus: 404 });
  await assert.rejects(fetchVerifiedRelease({ publicKey, fetcher: async () => new Response(null, { status: 403 }) }), { code: 'UPDATE_HTTP', httpStatus: 403 });
  await assert.rejects(fetchUpdateBytes(manifest().plugin.url, { fetcher: async () => new Response(null, { status: 404 }) }), { code: 'UPDATE_HTTP', httpStatus: 404 });
});

test('schema one accepts signed release identity, optional desktop minimum and complete Android metadata', async () => {
  const data = { ...manifest(), releaseVersion: '0.5.0', minAppVersion: '0.4.0', android: {
    version: '0.5.0', versionCode: 15, url: releaseDownloadUrl('benchgo-0.5.0-android.apk', 'v0.5.0'), sha256: 'a'.repeat(64), size: 300000000,
  } };
  assert.deepEqual(await fetchVerifiedRelease({ publicKey, fetcher: feed(data) }), data);
  const independent = structuredClone(data); independent.android.url = releaseDownloadUrl('benchgo-0.5.0-android.apk', 'v0.7.0');
  assert.deepEqual(await fetchVerifiedRelease({ publicKey, fetcher: feed(independent) }), independent);
  assert.equal(validateReleaseManifest(manifest()).minAppVersion, undefined);
  for (const mutate of [
    value => { value.releaseVersion = 'latest'; }, value => { value.minAppVersion = 'v0.4.0'; },
    value => { delete value.android.sha256; }, value => { delete value.android.size; },
    value => { value.android.versionCode = 0; }, value => { value.android.versionCode = 2147483648; },
    value => { value.android.versionCode = 1.2; }, value => { value.android.url = releaseDownloadUrl('payload.exe', 'v0.5.0'); },
    value => { value.android.url = releaseDownloadUrl('other.apk', 'v0.5.0'); }, value => { value.android.size = 1024 * 1024 * 1024 + 1; },
    value => { value.android.url = releaseDownloadUrl('benchgo-0.5.0-android.apk', 'app-updates'); },
    value => { value.android.url = 'https://evil.example/app.apk'; },
  ]) {
    const invalid = structuredClone(data); mutate(invalid);
    await assert.rejects(fetchVerifiedRelease({ publicKey, fetcher: feed(invalid) }));
  }
  assert.equal(MAX_PLUGIN_BYTES, 512 * 1024 * 1024);
  const fullSize = manifest(); fullSize.plugin.size = MAX_PLUGIN_BYTES;
  assert.equal(validateReleaseManifest(fullSize).plugin.size, MAX_PLUGIN_BYTES);
  const oversize = manifest(); oversize.plugin.size = MAX_PLUGIN_BYTES + 1;
  assert.throws(() => validateReleaseManifest(oversize), { code: 'UPDATE_MANIFEST' });
});

test('release generator signs unified and native metadata without inventing an application minimum', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'benchgo-unified-feed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pluginPath = path.join(dir, 'benchgo-0.1.2-plugin.tar.gz'); await writeFile(pluginPath, artifact);
  const options = { pluginPath, outDir: dir, version: '0.1.2', engineVersion: '0.2.1-alpha.3', privateKey: privatePem, publicKey,
    releaseVersion: '0.5.0', android: { version: '0.5.0', versionCode: 15, url: releaseDownloadUrl('benchgo-0.5.0-android.apk', 'v0.5.0'), sha256: 'b'.repeat(64), size: 100 } };
  const data = await createUpdateManifest(options);
  assert.equal(data.minAppVersion, undefined); assert.equal(data.releaseVersion, '0.5.0');
  const bytes = await readFile(path.join(dir, 'benchgo-update.json')), signature = await readFile(path.join(dir, 'benchgo-update.json.sig'));
  assert.deepEqual(await fetchVerifiedRelease({ publicKey, fetcher: async url => new Response(url.endsWith('.sig') ? signature : bytes) }), data);
  assert.equal((await createUpdateManifest({ ...options, minAppVersion: '0.4.0' })).minAppVersion, '0.4.0');
  const reused = await createUpdateManifest({ outDir: dir, plugin: manifest().plugin, engine: manifest().engine,
    releaseVersion: '0.6.0', sourceSha: 'c'.repeat(40), privateKey: privatePem, publicKey });
  assert.deepEqual(reused.plugin, manifest().plugin); assert.deepEqual(reused.engine, manifest().engine);
  assert.equal(reused.sourceSha, 'c'.repeat(40)); assert.equal(reused.version, '0.1.2');
  await assert.rejects(createUpdateManifest({ ...options, plugin: manifest().plugin }), /不能同时指定/);
  await assert.rejects(createUpdateManifest({ outDir: dir, plugin: manifest().plugin, engine: manifest().engine,
    sourceSha: 'bad', privateKey: privatePem, publicKey }), /源码提交/);
});
