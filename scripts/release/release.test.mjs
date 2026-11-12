import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createReleasePlan, classifyChanges } from './plan.mjs';
import { assembleRelease, immutableArtifact, validateReceipt, requiredVerification } from './assemble.mjs';
import { validateAppChannelAdvance, validateChannelAdvance, validatePublishBaseline } from './publish.mjs';
import { sha256, releaseKind } from './github.mjs';
import { checkedLegacyAsset, legacyInstallerChecksum, saveInstaller, selectLegacyInstaller } from './download-previous-installer.mjs';

const oldSha = 'a'.repeat(40), newSha = 'b'.repeat(40), hash = 'c'.repeat(64);
const descriptor = (name, version = '1.0.0') => ({ version, url: `https://github.com/zhuogo/BenchGo/releases/download/v1.0.0/${name}`, sha256: hash, size: 100 });
function baseline() {
  return { releaseVersion: '1.0.0', tag: 'v1.0.0', sourceSha: oldSha, manifestSha256: hash,
    manifest: { schemaVersion: 1, version: '1.0.0', releaseVersion: '1.0.0', sourceSha: oldSha, engine: { min: '0.2.2-rc.1', max: '0.2.2-rc.1' },
      plugin: descriptor('benchgo-1.0.0-plugin.tar.gz'), app: descriptor('benchgo-1.0.0-win-x64-setup.exe'),
      android: { ...descriptor('benchgo-1.0.0-android.apk'), versionCode: 10 } },
    source: { components: Object.fromEntries(['plugin', 'windows', 'android'].map(key => [key, { version: '1.0.0', sourceSha: oldSha, releaseVersion: '1.0.0' }])) } };
}
const versions = changes => ({ plugin: '1.0.0', windows: '1.0.0', android: '1.0.0', androidVersionCode: 10, engine: '0.2.2-rc.1', ...changes });
const plan = overrides => createReleasePlan({ releaseVersion: '1.1.0', sourceSha: newSha, previous: baseline(), versions: versions(), minAppVersion: '1.0.0', ...overrides });

test('first unified release builds all components; legacy release tags cannot silently supply a baseline', () => {
  const value = plan({ previous: null });
  assert.deepEqual(value.builds, { plugin: true, windows: true, android: true });
  assert.equal(value.kind, releaseKind);
});

test('first adoption still selects the newest older official legacy Windows installer for upgrade verification', () => {
  const release = version => ({ tag_name: `v${version}`, draft: false, prerelease: false, assets: [{ name: `benchgo-${version}-win-x64-setup.exe` }] });
  const old = release('0.0.1');
  assert.equal(selectLegacyInstaller([old, release('0.1.0'), release('0.2.0'), { ...release('0.0.3'), draft: true },
    { ...release('0.0.4'), prerelease: true }, { ...release('0.0.5'), assets: [{ name: 'release-source.json' }, ...release('0.0.5').assets] }], '0.1.0'), old);
  assert.equal(selectLegacyInstaller([old, release('0.0.2')], '0.1.0').tag_name, 'v0.0.2');
});

test('legacy fallback requires canonical same-repository/tag assets and an unambiguous SHA256SUMS entry', () => {
  const filename = 'benchgo-0.0.1-win-x64-setup.exe';
  assert.equal(legacyInstallerChecksum(`${hash}  unrelated.apk\r\n${hash.toUpperCase()} *${filename}\r\n`, filename), hash);
  assert.throws(() => legacyInstallerChecksum(`${hash}  ../${filename}`, filename), /exactly one/);
  assert.throws(() => legacyInstallerChecksum(`${hash}  ${filename}\n${hash}  ${filename}`, filename), /exactly one/);
  const asset = { id: 123, size: 100, name: filename, browser_download_url: `https://github.com/zhuogo/BenchGo/releases/download/v0.0.1/${filename}` };
  assert.equal(checkedLegacyAsset({ tag_name: 'v0.0.1', assets: [asset] }, filename), asset);
  assert.throws(() => checkedLegacyAsset({ tag_name: 'v0.0.1', assets: [{ ...asset, browser_download_url: asset.browser_download_url.replace('zhuogo', 'another') }] }, filename), /another repository/);
});

test('legacy download streams only an exact checksum-verified MZ installer and removes corrupt partial output', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'benchgo-legacy-download-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('MZ-verified-upgrade-fixture'), name = 'benchgo-0.0.1-win-x64-setup.exe';
  await saveInstaller(new Response(bytes), { name, size: bytes.length, sha256: sha256(bytes), output: directory });
  assert.deepEqual(await readFile(resolve(directory, name)), bytes);
  await assert.rejects(saveInstaller(new Response(bytes), { name: 'corrupt.exe', size: bytes.length, sha256: hash, output: directory }), /checksum mismatch/);
  assert.deepEqual((await (await import('node:fs/promises')).readdir(directory)).sort(), [name]);
});

test('plugin-only release keeps application versions and reuses both native binaries', () => {
  const value = plan({ versions: versions({ plugin: '1.1.0' }), paths: ['plugins/voice/src/calls.mjs'] });
  assert.deepEqual(value.builds, { plugin: true, windows: false, android: false });
  assert.equal(value.versions.windows, '1.0.0');
});

test('Windows-only version increase preserves the independent Android artifact and versionCode', () => {
  const value = plan({ versions: versions({ windows: '1.1.0' }), paths: ['package.json'] });
  assert.deepEqual(value.builds, { plugin: false, windows: true, android: false });
  assert.equal(value.versions.android, '1.0.0');
  assert.equal(value.versions.androidVersionCode, 10);
});

test('Android-only version increase preserves the independent Windows artifact', () => {
  const value = plan({ versions: versions({ android: '1.1.0', androidVersionCode: 11 }), paths: ['plugins/link/mobile/android/app/build.gradle'] });
  assert.deepEqual(value.builds, { plugin: false, windows: false, android: true });
  assert.equal(value.versions.windows, '1.0.0');
  assert.throws(() => plan({ versions: versions({ android: '1.1.0' }), paths: ['plugins/link/mobile/android/app/build.gradle'] }), /increased versionCode/);
});

test('native Android and embedded Link changes are explicit; documentation and tests do not rebuild', () => {
  assert.deepEqual(classifyChanges(['plugins/link/mobile/android/app/src/main/java/Main.kt']), { plugin: [], windows: [], android: ['plugins/link/mobile/android/app/src/main/java/Main.kt'] });
  const embedded = classifyChanges(['plugins/link/client/main.jsx']);
  assert.equal(embedded.plugin.length, 1); assert.equal(embedded.android.length, 1); assert.equal(embedded.windows.length, 0);
  assert.deepEqual(plan({ paths: ['docs/设计.md', 'plugins/voice/test/calls.test.mjs', '.github/workflows/unified-release.yml'] }).builds,
    { plugin: false, windows: false, android: false });
});

test('changed components require increased versions and Android additionally requires increased versionCode', () => {
  assert.throws(() => plan({ paths: ['plugins/voice/src/calls.mjs'] }), /increment its component version/);
  assert.throws(() => plan({ versions: versions({ windows: '1.1.0', android: '1.1.0' }) }), /increased versionCode/);
  assert.throws(() => plan({ versions: versions({ android: '1.1' }) }), /Invalid android component version/);
  assert.throws(() => plan({ releaseVersion: '1.0.0' }), /must increase/);
  assert.throws(() => plan({ versions: versions({ plugin: '0.9.0' }) }), /roll back/);
});

test('official engine or brand changes cannot skip a component build', () => {
  const value = plan({ paths: ['deepseek-harness'], versions: versions({ plugin: '1.1.0', windows: '1.1.0', android: '1.1.0', androidVersionCode: 11 }) });
  assert.deepEqual(value.builds, { plugin: true, windows: true, android: true });
  assert.throws(() => plan({ minAppVersion: '2.0.0' }), /minAppVersion/);
});

test('immutable component references forbid mutable channel and unrelated repository URLs', () => {
  assert.equal(immutableArtifact(descriptor('benchgo-1.0.0-plugin.tar.gz')).version, '1.0.0');
  assert.throws(() => immutableArtifact({ ...descriptor('a.apk'), url: 'https://github.com/zhuogo/BenchGo/releases/download/app-updates/a.apk' }), /immutable/);
  assert.throws(() => immutableArtifact({ ...descriptor('a.apk'), url: 'https://example.com/a.apk' }), /immutable/);
});

test('provenance requires exact source, unified identity, verification results and staging scope', () => {
  const value = plan({ versions: versions({ plugin: '1.1.0' }) });
  const receipt = { schemaVersion: 1, component: 'plugin', sourceSha: newSha, releaseVersion: '1.1.0', version: '1.1.0',
    verified: requiredVerification.plugin, staged: [{ path: 'plugins/benchgo/package.json', field: 'benchgo.releaseVersion', value: '1.1.0' }],
    artifact: 'benchgo-1.1.0-plugin.tar.gz', files: [{ name: 'benchgo-1.1.0-plugin.tar.gz', sha256: hash, size: 100 }] };
  assert.equal(validateReceipt(receipt, value, 'plugin'), receipt);
  assert.throws(() => validateReceipt({ ...receipt, sourceSha: oldSha }, value, 'plugin'), /source or version/);
  assert.throws(() => validateReceipt({ ...receipt, verified: [] }, value, 'plugin'), /verification/);
  assert.throws(() => validateReceipt({ ...receipt, staged: [] }, value, 'plugin'), /staging/);
});

test('Android publication also requires the completed native update-signature unit-test gate', () => {
  const value = plan();
  const receipt = { schemaVersion: 1, component: 'android', sourceSha: newSha, releaseVersion: '1.1.0', version: '1.0.0', versionCode: 10,
    verified: ['android-release-signature', 'android-current-resources', 'android-non-debuggable'],
    staged: [{ path: 'plugins/benchgo/package.json', field: 'benchgo.releaseVersion', value: '1.1.0' }],
    artifact: 'benchgo-1.0.0-android.apk', files: [{ name: 'benchgo-1.0.0-android.apk', sha256: hash, size: 100 }] };
  assert.throws(() => validateReceipt(receipt, value, 'android'), /verification/);
  assert.equal(validateReceipt({ ...receipt, verified: [...receipt.verified, 'android-update-signature-tests'] }, value, 'android').versionCode, 10);
});

test('publication rejects raced baselines, component downgrades and another source for the same public version', () => {
  const value = plan();
  assert.doesNotThrow(() => validatePublishBaseline({ plan: value, current: baseline() }));
  assert.throws(() => validatePublishBaseline({ plan: value, current: { ...baseline(), sourceSha: newSha } }), /baseline changed/);
  assert.throws(() => validateChannelAdvance(baseline().manifest, { ...baseline().manifest, releaseVersion: '0.9.0' }), /roll back/);
  assert.throws(() => validateChannelAdvance(baseline().manifest, { ...baseline().manifest, sourceSha: newSha }), /two source/);
  assert.throws(() => validateChannelAdvance(baseline().manifest, { ...baseline().manifest, releaseVersion: '1.1.0', plugin: { ...baseline().manifest.plugin, version: '0.9.0' } }), /roll back/);
});

test('an existing native app feed prevents a first-unified or plugin-only application rollback', () => {
  const feed = { version: '2.0.0', files: [{ sha512: 'existing-verified-hash' }] };
  assert.throws(() => validateAppChannelAdvance(feed, baseline().manifest), /cannot roll back/);
  assert.doesNotThrow(() => validateAppChannelAdvance({ ...feed, version: '1.0.0' }, baseline().manifest));
});

test('metadata-only release signs a fresh unified identity while preserving exact immutable component references', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'benchgo-unified-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', { privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
  const value = plan(), out = resolve(directory, 'release');
  const result = await assembleRelease({ plan: value, buildRoot: directory, outDir: out, notes: '验证清单复用', privateKey, publicKey, enforceSource: false });
  assert.equal(result.manifest.releaseVersion, '1.1.0');
  assert.equal(result.manifest.version, '1.0.0');
  assert.deepEqual(result.manifest.plugin, value.previous.manifest.plugin);
  assert.deepEqual(result.manifest.app, value.previous.manifest.app);
  assert.deepEqual(result.manifest.android, value.previous.manifest.android);
  const raw = await readFile(resolve(out, 'benchgo-update.json'));
  assert.equal(verify(null, raw, publicKey, Buffer.from((await readFile(resolve(out, 'benchgo-update.json.sig'), 'utf8')).trim(), 'base64')), true);
  assert.equal(result.receipt.manifestSha256, sha256(raw));
  assert.equal(result.receipt.components.plugin.sourceSha, oldSha);
});

test('assembly fails on wrong checksum before signing any update channel', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'benchgo-unified-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const built = resolve(directory, 'benchgo-plugin-update'); await mkdir(built);
  const value = plan({ versions: versions({ plugin: '1.1.0' }) });
  await writeFile(resolve(built, 'benchgo-1.1.0-plugin.tar.gz'), 'corrupt');
  await writeFile(resolve(built, 'component-source.json'), JSON.stringify({ schemaVersion: 1, component: 'plugin', sourceSha: newSha,
    releaseVersion: '1.1.0', version: '1.1.0', verified: requiredVerification.plugin,
    staged: [{ path: 'plugins/benchgo/package.json', field: 'benchgo.releaseVersion', value: '1.1.0' }],
    artifact: 'benchgo-1.1.0-plugin.tar.gz', files: [{ name: 'benchgo-1.1.0-plugin.tar.gz', size: 7, sha256: hash }] }));
  await assert.rejects(assembleRelease({ plan: value, buildRoot: directory, outDir: resolve(directory, 'out'), enforceSource: false }), /checksum mismatch/);
});

test('first release combines independently versioned verified components under one immutable public tag', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'benchgo-unified-first-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = plan({ previous: null }), folders = { plugin: 'benchgo-plugin-update', windows: 'benchgo-windows-x64', android: 'benchgo-1.0.0-android.apk' };
  for (const component of ['plugin', 'windows', 'android']) {
    const folder = resolve(directory, folders[component]); await mkdir(folder);
    const artifact = component === 'plugin' ? 'benchgo-1.0.0-plugin.tar.gz' : component === 'windows' ? 'benchgo-1.0.0-win-x64-setup.exe' : 'benchgo-1.0.0-android.apk';
    const bytes = Buffer.from(component === 'windows' ? 'MZ-test-fixture' : 'unit-test-build-fixture');
    await writeFile(resolve(folder, artifact), bytes);
    const files = [{ name: artifact, sha256: sha256(bytes), size: bytes.length }];
    if (component === 'windows') {
      const proof = Buffer.from(JSON.stringify({ schemaVersion: 1, sourceSha: newSha, version: '1.0.0', verified: requiredVerification.windows }));
      await writeFile(resolve(folder, 'build-source.json'), proof);
      files.push({ name: 'build-source.json', sha256: sha256(proof), size: proof.length });
    }
    await writeFile(resolve(folder, 'component-source.json'), JSON.stringify({ schemaVersion: 1, component, sourceSha: newSha, releaseVersion: '1.1.0', version: '1.0.0',
      ...(component === 'android' ? { versionCode: 10 } : {}), artifact, files, verified: requiredVerification[component],
      staged: [{ path: 'plugins/benchgo/package.json', field: 'benchgo.releaseVersion', value: '1.1.0' }] }));
  }
  const keys = generateKeyPairSync('ed25519', { privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
  const out = resolve(directory, 'release');
  const result = await assembleRelease({ plan: value, buildRoot: directory, outDir: out, notes: 'unit test only', ...keys, enforceSource: false });
  assert.equal(result.manifest.releaseVersion, '1.1.0');
  assert.equal(result.manifest.android.version, '1.0.0');
  assert.match(result.manifest.android.url, /download\/v1\.1\.0\/benchgo-1\.0\.0-android\.apk$/);
  const feed = JSON.parse(await readFile(resolve(out, 'latest.yml'), 'utf8'));
  assert.equal(feed.files[0].url, `https://ghfast.top/${result.manifest.app.url}`);
  assert.equal(feed.path, feed.files[0].url);
  assert.match(result.manifest.app.url, /^https:\/\/github\.com\//);
  assert.equal(feed.releaseDate, value.createdAt);
});
