import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleDownloads, downloadPlatforms, platformDownloadEntries, validatePlatformReceipt, verifyDownloads } from './downloads.mjs';
import { findPreviousRelease, releaseKind, sha256 } from './github.mjs';
import { releaseDownloadUrl } from '../../plugins/base/shared/update-feed.mjs';

const plan = { sourceSha: 'a'.repeat(40), releaseVersion: '0.1.2', tag: 'v0.1.2', versions: { windows: '0.1.2' } };
const mac = arch => ({ schemaVersion: 1, sourceSha: plan.sourceSha, version: '0.1.2', platform: 'darwin', arch,
  signing: 'ad-hoc', notarized: false, verified: ['packaged-runtime', 'external-plugin-seed', 'enrollment-source-match', 'startup-brand'],
  files: ['dmg', 'zip'].map(ext => ({ name: `benchgo-0.1.2-mac-${arch}.${ext}`, size: 4, sha256: sha256('test') })) });
const artifact = (suffix, version = '0.1.0', tag = 'v0.1.1') => ({ version, url: releaseDownloadUrl(`benchgo-${version}-${suffix}`, tag), size: 4, sha256: sha256('test') });
const previousCatalog = () => ({ schemaVersion: 1, sourceSha: 'b'.repeat(40), releaseVersion: '0.1.1', files: [
  ...['arm64', 'x64'].flatMap(arch => ['dmg', 'zip'].map(format => ({ target: `mac-${arch}`, ...artifact(`mac-${arch}.${format}`), signing: 'ad-hoc', notarized: false }))),
  { target: 'linux-server', ...artifact('linux-server.tar.gz', '0.1.0', 'v0.1.0'), kind: 'server', arch: 'x64', systems: ['Ubuntu', 'Debian'] },
] });

test('platform provenance rejects wrong source, architecture, notarization claims and missing formats', () => {
  assert.equal(validatePlatformReceipt(mac('arm64'), plan, 'mac-arm64').expected.length, 2);
  for (const change of [{ sourceSha: 'b'.repeat(40) }, { arch: 'x64' }, { notarized: true }, { files: mac('arm64').files.slice(0, 1) }, { verified: [] }]) {
    assert.throws(() => validatePlatformReceipt({ ...mac('arm64'), ...change }, plan, 'mac-arm64'));
  }
});

test('Linux publication requires the completed native fresh-install and service smoke', () => {
  const receipt = { schemaVersion: 1, sourceSha: plan.sourceSha, version: '0.1.2', platform: 'linux', arch: 'x64',
    verified: ['server-seed-sha256', 'server-seed-safe-paths', 'linux-x64-native-worker', 'current-bootstrap', 'distribution-inventory'],
    files: [{ name: 'benchgo-0.1.2-linux-server.tar.gz', size: 4, sha256: sha256('test') }] };
  assert.throws(() => validatePlatformReceipt(receipt, plan, 'linux-server'), /Incomplete/);
  receipt.verified.push('server-install-and-start');
  assert.equal(validatePlatformReceipt(receipt, plan, 'linux-server').expected.length, 1);
});

test('platform reuse requires the complete signed formats and immutable descriptors', () => {
  const catalog = previousCatalog();
  assert.deepEqual(platformDownloadEntries(catalog, 'mac-arm64'), catalog.files.slice(0, 2));
  assert.deepEqual(platformDownloadEntries(catalog, 'linux-server'), catalog.files.slice(-1));
  assert.deepEqual(platformDownloadEntries(null, 'mac-arm64'), []);
  assert.deepEqual(platformDownloadEntries(catalog, 'unknown'), []);
  for (const change of [
    files => files.shift(),
    files => files.push(files[0]),
    files => { files[0].url = files[0].url.replace('zhuogo', 'another'); },
    files => { files[0].url = files[0].url.replace('/v0.1.1/', '/latest/'); },
    files => { files[0].url = files[0].url.replace('/v0.1.1/', '/v0.1.2/'); },
    files => { files[0].url = files[0].url.replace('/v0.1.1/', '/v0.1.0/'); },
    files => { files[0].url = files[0].url.replace('arm64', 'x64'); },
    files => { files[0].version = '0.1.1'; },
    files => { files[0].size = 0; },
    files => { files[0].sha256 = 'invalid'; },
    files => { delete files[0].signing; },
    files => { files[0].notarized = true; },
  ]) {
    const value = previousCatalog();
    change(value.files);
    assert.deepEqual(platformDownloadEntries(value, 'mac-arm64'), []);
    assert.equal(platformDownloadEntries(value, 'mac-x64').length, 2);
  }
  catalog.files.at(-1).arch = 'arm64';
  assert.deepEqual(platformDownloadEntries(catalog, 'linux-server'), []);
});

test('the previous release returns only a signature-verified, source-bound downloads catalog', async t => {
  const keys = generateKeyPairSync('ed25519'), catalog = previousCatalog();
  const { releaseVersion, sourceSha } = catalog;
  const release = { tag_name: `v${releaseVersion}`, assets: [] };
  const payloads = new Map(), json = value => Buffer.from(`${JSON.stringify(value)}\n`);
  const signature = raw => Buffer.from(`${sign(null, raw, keys.privateKey).toString('base64')}\n`);
  const add = (name, bytes) => {
    const id = payloads.size + 1, asset = { id, name, size: bytes.length };
    payloads.set(id, bytes);
    release.assets.push(asset);
    return asset;
  };
  const manifest = json({ schemaVersion: 1, version: '0.1.0', releaseVersion, sourceSha, engine: { min: '0.2.0' }, plugin: artifact('plugin.tar.gz') });
  add('benchgo-update.json', manifest);
  add('benchgo-update.json.sig', signature(manifest));
  add('release-source.json', json({ schemaVersion: 1, kind: releaseKind, releaseVersion, sourceSha, manifestSha256: sha256(manifest) }));
  const fetcher = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetcher; });
  globalThis.fetch = async url => {
    const { pathname } = new URL(url);
    if (pathname === '/repos/zhuogo/BenchGo/releases') return Response.json([release]);
    if (pathname.endsWith(`/commits/${release.tag_name}`)) return Response.json({ sha: sourceSha });
    const bytes = payloads.get(Number(pathname.split('/').at(-1)));
    assert.ok(bytes, `Unexpected GitHub request: ${pathname}`);
    return new Response(bytes);
  };
  const find = () => findPreviousRelease({ publicKey: keys.publicKey });
  assert.equal((await find()).downloads, null);
  const raw = json(catalog), doc = add('downloads.json', raw);
  await assert.rejects(find(), /missing or ambiguous/);
  const sig = add('downloads.json.sig', signature(raw));
  assert.deepEqual((await find()).downloads, catalog);
  payloads.set(sig.id, signature(json({ ...catalog, releaseVersion: '0.1.2' })));
  await assert.rejects(find(), /signature is invalid/);
  for (const changes of [{ sourceSha: 'c'.repeat(40) }, { releaseVersion: '0.1.2' }, { schemaVersion: 2 }, { files: null }]) {
    const updated = json({ ...catalog, ...changes });
    payloads.set(doc.id, updated);
    doc.size = updated.length;
    payloads.set(sig.id, signature(updated));
    await assert.rejects(find(), /does not match its release source/);
  }
});

test('complete catalog binds every platform to checked bytes and verifies its signature', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-downloads-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const buildRoot = join(directory, 'builds'), output = join(directory, 'out');
  await mkdir(output, { recursive: true });
  const keys = generateKeyPairSync('ed25519');
  for (const arch of ['arm64', 'x64']) {
    const folder = join(buildRoot, `benchgo-macos-${arch}`), receipt = mac(arch);
    await mkdir(folder, { recursive: true });
    for (const file of receipt.files) await writeFile(join(folder, file.name), 'test');
    await writeFile(join(folder, 'build-source.json'), JSON.stringify(receipt));
  }
  const linux = join(buildRoot, 'benchgo-linux-server'), name = 'benchgo-0.1.2-linux-server.tar.gz';
  await mkdir(linux, { recursive: true });
  await writeFile(join(linux, name), 'test');
  await writeFile(join(linux, 'build-source.json'), JSON.stringify({ schemaVersion: 1, sourceSha: plan.sourceSha, version: '0.1.2', platform: 'linux', arch: 'x64',
    verified: ['server-seed-sha256', 'server-seed-safe-paths', 'linux-x64-native-worker', 'current-bootstrap', 'distribution-inventory', 'server-install-and-start'], files: [{ name, size: 4, sha256: sha256('test') }] }));
  const manifest = {};
  for (const [key, suffix] of [['app', 'win-x64-setup.exe'], ['android', 'android.apk'], ['plugin', 'plugin.tar.gz']]) {
    const filename = `benchgo-0.1.2-${suffix}`;
    manifest[key] = { version: '0.1.2', url: `https://github.com/zhuogo/BenchGo/releases/download/v0.1.2/${filename}`, size: 4, sha256: sha256('test') };
    await writeFile(join(output, filename), 'test');
  }
  const catalog = await assembleDownloads({ plan, manifest, buildRoot, output, privateKey: keys.privateKey });
  assert.equal(catalog.files.length, 8);
  assert.deepEqual(await verifyDownloads({ directory: output, plan, publicKey: keys.publicKey }), catalog);
  assert.match(await readFile(join(output, 'SHA256SUMS.txt'), 'utf8'), /downloads.json.sig/);
  await writeFile(join(output, 'benchgo-0.1.2-mac-arm64.dmg'), 'evil');
  await assert.rejects(verifyDownloads({ directory: output, plan, publicKey: keys.publicKey }), /checksum/);

  const mixedOutput = join(directory, 'mixed');
  await mkdir(mixedOutput);
  const downloads = previousCatalog();
  const mixed = { ...plan, versions: { ...plan.versions, macos: '0.1.0', linux: '0.1.2' }, builds: { macos: false, linux: true }, previous: { releaseVersion: downloads.releaseVersion, sourceSha: downloads.sourceSha, downloads } };
  const mixedManifest = { app: artifact('win-x64-setup.exe'), android: artifact('android.apk'), plugin: artifact('plugin.tar.gz') };
  const mixedCatalog = await assembleDownloads({ plan: mixed, manifest: mixedManifest, buildRoot, output: mixedOutput, privateKey: keys.privateKey });
  assert.deepEqual(platformDownloadEntries(mixedCatalog, 'mac-arm64'), platformDownloadEntries(downloads, 'mac-arm64'));
  assert.equal(platformDownloadEntries(mixedCatalog, 'linux-server')[0].url, releaseDownloadUrl(name, plan.tag));
  assert.deepEqual(await verifyDownloads({ directory: mixedOutput, plan: mixed, publicKey: keys.publicKey }), mixedCatalog);
});

test('an unchanged platform reuses its signed descriptors without a local build or checksum inventory', async t => {
  const output = await mkdtemp(join(tmpdir(), 'benchgo-downloads-reuse-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ed25519'), downloads = previousCatalog();
  const previous = { releaseVersion: downloads.releaseVersion, sourceSha: downloads.sourceSha, downloads };
  const reuse = { ...plan, versions: { ...plan.versions, macos: '0.1.0', linux: '0.1.0' }, builds: { macos: false, linux: false }, previous };
  const manifest = { app: artifact('win-x64-setup.exe'), android: artifact('android.apk'), plugin: artifact('plugin.tar.gz') };
  const buildRoot = join(output, 'missing-builds');
  const assemble = value => assembleDownloads({ plan: value, manifest, buildRoot, output, privateKey: keys.privateKey });
  await assert.rejects(assemble({ ...reuse, previous: { ...previous, downloads: null } }), /trusted previous download entries/);
  await assert.rejects(assemble({ ...reuse, previous: { ...previous, sourceSha: 'c'.repeat(40) } }), /trusted previous download entries/);
  const catalog = await assemble(reuse);
  for (const target of downloadPlatforms) {
    assert.deepEqual(platformDownloadEntries(catalog, target), platformDownloadEntries(downloads, target));
  }
  assert.deepEqual(await verifyDownloads({ directory: output, plan: reuse, publicKey: keys.publicKey }), catalog);
  assert.deepEqual((await readdir(output)).sort(), ['SHA256SUMS.txt', 'downloads.json', 'downloads.json.sig']);
  assert.doesNotMatch(await readFile(join(output, 'SHA256SUMS.txt'), 'utf8'), /mac-|linux-server/);
});
