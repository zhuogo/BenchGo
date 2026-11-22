import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { assembleRelease, requiredVerification } from './assemble.mjs';
import { fileDigest } from './record-artifact.mjs';
import { readSignedRelease, releaseKind, sha256 } from './github.mjs';
import { publishRelease } from './publish.mjs';
import { inspectArchive, recoveryJobs, recoveryStagingPath, validateRecoveryContext, verifyArchive, verifyRecoveryBundle, verifyRecoveryRun } from './recover-release.mjs';

const source = 'a'.repeat(40), publisher = 'b'.repeat(40), runId = 123;
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const keys = () => generateKeyPairSync('ed25519', { privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
const environment = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW: 'Recover BenchGo verified release', GITHUB_SHA: publisher };
function origin() {
  return { runId, productSource: source, releaseVersion: '1.0.0', publisherSource: publisher,
    run: { id: runId, head_sha: source, head_branch: 'main', event: 'workflow_dispatch', path: '.github/workflows/unified-release.yml',
      repository: { full_name: 'zhuogo/BenchGo' }, head_repository: { full_name: 'zhuogo/BenchGo' }, status: 'completed', conclusion: 'failure' },
    jobs: [...recoveryJobs.map(name => ({ name, status: 'completed', conclusion: 'success' })), { name: 'publish', status: 'completed', conclusion: 'failure', steps: [
      { name: 'Verify provenance and checksums, reuse unchanged immutable assets, then sign one manifest', conclusion: 'success' },
      { name: 'Run actions/upload-artifact@v4', conclusion: 'success' },
      { name: 'Publish complete immutable release, then advance signed channels', conclusion: 'failure' },
    ] }],
    artifacts: ['benchgo-release-plan', 'benchgo-release-ready'].map((name, i) => ({ id: i + 1, name, size_in_bytes: 42, digest: `sha256:${'c'.repeat(64)}`, expired: false, workflow_run: { id: runId, head_sha: source } })),
    comparison: { status: 'ahead', merge_base_commit: { sha: source } } };
}

test('previous signed release accepts PEM and public KeyObject; incorrect keys and signatures fail', async t => {
  const pair = keys(), raw = json({ schemaVersion: 1, version: '1.0.0', releaseVersion: '1.0.0', sourceSha: source,
    engine: { min: '0.2.2-rc.5', max: '0.2.2-rc.5' }, plugin: { version: '1.0.0', url: 'https://github.com/zhuogo/BenchGo/releases/download/v1.0.0/benchgo-1.0.0-plugin.tar.gz', size: 4, sha256: sha256('test') } });
  let signature = Buffer.from(`${sign(null, raw, pair.privateKey).toString('base64')}\n`);
  const release = { assets: [{ id: 1, name: 'benchgo-update.json', size: raw.length }, { id: 2, name: 'benchgo-update.json.sig', size: signature.length }] };
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async url => new Response(String(url).endsWith('/1') ? raw : signature);
  for (const publicKey of [pair.publicKey, createPublicKey(pair.publicKey)]) assert.equal((await readSignedRelease(release, { publicKey })).manifest.sourceSha, source);
  await assert.rejects(readSignedRelease(release, { publicKey: createPublicKey(keys().publicKey) }), /signature/);
  signature = Buffer.from(`${sign(null, Buffer.from('different bytes'), pair.privateKey).toString('base64')}\n`);
  await assert.rejects(readSignedRelease(release, { publicKey: pair.publicKey }), /signature/);
});

test('only complete successful original gates with failed final publication and source-bound retained artifacts can recover', () => {
  assert.equal(validateRecoveryContext(origin())['benchgo-release-ready'].id, 2);
  const cases = [
    value => { value.run.id++; }, value => { value.run.head_sha = publisher; }, value => { value.run.head_branch = 'other'; },
    value => { value.run.repository.full_name = 'other/BenchGo'; }, value => { value.run.head_repository.full_name = 'other/BenchGo'; },
    value => { value.run.path = '.github/workflows/other.yml'; }, value => { value.run.event = 'pull_request'; },
    value => { value.run.conclusion = 'success'; }, value => { value.comparison.status = 'diverged'; },
    value => { value.comparison.merge_base_commit.sha = publisher; }, value => { value.jobs.pop(); },
    value => { value.jobs.push(value.jobs[0]); }, value => { value.jobs[0].conclusion = 'skipped'; },
    value => { value.jobs[2].conclusion = 'failure'; }, value => { value.jobs.at(-1).steps[0].conclusion = 'failure'; },
    value => { value.jobs.at(-1).steps[1].conclusion = 'skipped'; }, value => { value.jobs.at(-1).steps[2].conclusion = 'success'; },
    value => { value.artifacts[0].workflow_run.head_sha = publisher; }, value => { value.artifacts[0].workflow_run.id++; },
    value => { value.artifacts[1].digest = ''; }, value => { value.artifacts[1].expired = true; },
    value => { value.artifacts.push(value.artifacts[1]); },
  ];
  for (const change of cases) { const value = origin(); change(value); assert.throws(() => validateRecoveryContext(value)); }
});

test('recovery reads original API identity without rewriting the real publisher environment; truncated inventories fail', async () => {
  const value = origin(), paths = [];
  const request = async path => { paths.push(path); if (path.includes('/compare/')) return value.comparison;
    if (path.includes('/jobs?')) return { total_count: value.jobs.length, jobs: value.jobs };
    if (path.includes('/artifacts?')) return { total_count: value.artifacts.length, artifacts: value.artifacts }; return value.run; };
  const env = { ...environment }, result = await verifyRecoveryRun({ runId, productSource: source, releaseVersion: '1.0.0', request, env });
  assert.equal(result.publisherSource, publisher); assert.deepEqual(env, environment); assert.equal(paths.length, 4);
  for (const replacement of [{ GITHUB_WORKFLOW: 'BenchGo unified release' }, { GITHUB_REF: 'refs/heads/other' }, { GITHUB_EVENT_NAME: 'push' }])
    await assert.rejects(verifyRecoveryRun({ runId, productSource: source, releaseVersion: '1.0.0', request, env: { ...env, ...replacement } }), /restricted/);
  await assert.rejects(verifyRecoveryRun({ runId, productSource: source, releaseVersion: '1.0.0', env, request: async path => {
    const response = await request(path); return path.includes('/jobs?') ? { ...response, total_count: 1000 } : response;
  } }), /complete API page/);
});

test('normal publisher cannot bypass product source checks with an arbitrary recovery flag', async t => {
  const previous = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]));
  Object.assign(process.env, environment, { GITHUB_WORKFLOW: 'BenchGo unified release' });
  t.after(() => { for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  await assert.rejects(publishRelease({ plan: { sourceSha: source }, directory: 'missing' }), /differs from the planned/);
  await assert.rejects(publishRelease({ plan: { sourceSha: source }, directory: 'missing', recovery: {} }), /restricted/);
});

test('ZIP inspection extracts only original flat regular files and refuses paths, links and duplicate names', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'benchgo-recovery-zip-')); t.after(() => rm(root, { recursive: true, force: true }));
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const create = (path, names, symlink = false) => execFileSync(python, ['-c', `import json,sys,zipfile,stat\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for name in json.loads(sys.argv[2]):\n  e=zipfile.ZipInfo(name); e.create_system=3; e.external_attr=(stat.S_IFLNK|0o777)<<16 if sys.argv[3]=='true' else 0\n  z.writestr(e,b'test')`, path, JSON.stringify(names), String(symlink)], { windowsHide: true, stdio: 'pipe' });
  const archive = resolve(root, 'good.zip'); create(archive, ['release-plan.json']);
  const authenticated = { size_in_bytes: (await stat(archive)).size, digest: `sha256:${await fileDigest(archive)}` };
  await verifyArchive(archive, authenticated);
  await assert.rejects(verifyArchive(archive, { ...authenticated, size_in_bytes: authenticated.size_in_bytes + 1 }), /digest or size/);
  await assert.rejects(verifyArchive(archive, { ...authenticated, digest: `sha256:${'0'.repeat(64)}` }), /digest or size/);
  assert.deepEqual(await inspectArchive(archive, resolve(root, 'extracted')), [{ name: 'release-plan.json', size: 4, sha256: sha256('test') }]);
  assert.equal(await readFile(resolve(root, 'extracted/release-plan.json'), 'utf8'), 'test');
  for (const [index, names] of [['../escape'], ['/absolute'], ['folder/file'], ['folder/'], ['a', 'a'], ['A', 'a']].entries()) {
    const path = resolve(root, `bad-${index}.zip`); create(path, names); await assert.rejects(inspectArchive(path));
  }
  const link = resolve(root, 'link.zip'); create(link, ['safe-name'], true); await assert.rejects(inspectArchive(link));
});

async function bundle(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'benchgo-recovery-signed-')); t.after(() => rm(root, { recursive: true, force: true }));
  const pair = keys(), directory = resolve(root, 'ready'), builds = resolve(root, 'builds');
  const plan = { schemaVersion: 1, kind: releaseKind, sourceSha: source, releaseVersion: '1.0.0', tag: 'v1.0.0', minAppVersion: '1.0.0',
    createdAt: '2026-11-15T00:00:00Z', versions: { plugin: '1.0.0', windows: '1.0.0', android: '1.0.0', androidVersionCode: 1, engine: '0.2.2-rc.5' },
    builds: { plugin: true, windows: true, android: true }, previous: null };
  const putFiles = async (folder, files) => { await mkdir(folder, { recursive: true }); const inventory = [];
    for (const [name, content] of Object.entries(files)) { const bytes = Buffer.from(content); await writeFile(resolve(folder, name), bytes); inventory.push({ name, size: bytes.length, sha256: sha256(bytes) }); } return inventory; };
  for (const component of ['plugin', 'windows', 'android']) {
    const artifact = `benchgo-1.0.0-${component === 'windows' ? 'win-x64-setup.exe' : component === 'plugin' ? 'plugin.tar.gz' : 'android.apk'}`;
    const folder = resolve(builds, component === 'plugin' ? 'benchgo-plugin-update' : component === 'windows' ? 'benchgo-windows-x64' : 'benchgo-1.0.0-android.apk');
    const files = { [artifact]: `verified-${component}` };
    if (component === 'windows') { files[`${artifact}.blockmap`] = 'verified-map'; files['build-source.json'] = json({ schemaVersion: 1, sourceSha: source, version: '1.0.0', verified: requiredVerification.windows }); }
    const receipt = { schemaVersion: 1, component, sourceSha: source, releaseVersion: '1.0.0', version: '1.0.0', ...(component === 'android' ? { versionCode: 1 } : {}),
      verified: requiredVerification[component], staged: [{ path: 'plugins/base/package.json', field: 'benchgo.releaseVersion', value: '1.0.0' }], artifact, files: await putFiles(folder, files) };
    await writeFile(resolve(folder, 'component-source.json'), json(receipt));
  }
  for (const arch of ['arm64', 'x64']) {
    const folder = resolve(builds, `benchgo-macos-${arch}`), receipt = { schemaVersion: 1, sourceSha: source, version: '1.0.0', platform: 'darwin', arch, signing: 'ad-hoc', notarized: false,
      verified: ['packaged-runtime', 'external-plugin-seed', 'enrollment-source-match', 'startup-brand'],
      files: await putFiles(folder, { [`benchgo-1.0.0-mac-${arch}.dmg`]: 'mac-dmg', [`benchgo-1.0.0-mac-${arch}.zip`]: 'mac-zip' }) };
    await writeFile(resolve(folder, 'build-source.json'), json(receipt));
  }
  const linux = resolve(builds, 'benchgo-linux-server');
  const receipt = { schemaVersion: 1, sourceSha: source, version: '1.0.0', platform: 'linux', arch: 'x64',
    verified: ['server-seed-sha256', 'server-seed-safe-paths', 'linux-x64-native-worker', 'current-bootstrap', 'distribution-inventory', 'server-install-and-start'],
    files: await putFiles(linux, { 'benchgo-1.0.0-linux-server.tar.gz': 'linux-tar' }) };
  await writeFile(resolve(linux, 'build-source.json'), json(receipt));
  await assembleRelease({ plan, buildRoot: builds, outDir: directory, ...pair, enforceSource: false, platforms: ['mac-arm64', 'mac-x64', 'linux-server'] });
  const inventory = async () => Promise.all((await readdir(directory)).map(async name => ({ name, size: (await stat(resolve(directory, name))).size, sha256: await fileDigest(resolve(directory, name)) })));
  const refreshSums = async () => { const rows = (await inventory()).filter(row => !['SHA256SUMS.txt', 'release-notes.md'].includes(row.name)).sort((a, b) => a.name.localeCompare(b.name));
    await writeFile(resolve(directory, 'SHA256SUMS.txt'), rows.map(row => `${row.sha256}  ${row.name}\n`).join('')); };
  return { root, directory, plan, ...pair, inventory, refreshSums };
}

test('a release with skipped builds recovers from the original signed artifacts', async t => {
  const f = await bundle(t);
  const work = origin();
  work.jobs = ['plan', 'publish'].map(name => work.jobs.find(job => job.name === name));
  for (const name of ['plugin', 'windows', 'android', 'macos', 'linux']) work.jobs.push({ name, status: 'completed', conclusion: 'skipped' });
  assert.equal(validateRecoveryContext(work)['benchgo-release-ready'].id, 2);
  work.jobs.find(job => job.name === 'macos').conclusion = 'failure';
  assert.throws(() => validateRecoveryContext(work), /did not succeed: macos/);
  const previous = { tag: f.plan.tag, sourceSha: f.plan.sourceSha, releaseVersion: f.plan.releaseVersion,
    manifest: JSON.parse(await readFile(resolve(f.directory, 'benchgo-update.json'))),
    manifestSha256: await fileDigest(resolve(f.directory, 'benchgo-update.json')),
    downloads: JSON.parse(await readFile(resolve(f.directory, 'downloads.json'))),
    source: JSON.parse(await readFile(resolve(f.directory, 'release-source.json'))) };
  const plan = { ...f.plan, previous, sourceSha: publisher, releaseVersion: '1.1.0', tag: 'v1.1.0',
    versions: { ...f.plan.versions, macos: '1.0.0', linux: '1.0.0' },
    builds: { plugin: false, windows: false, android: false, macos: false, linux: false } };
  const directory = resolve(f.root, 'reuse');
  await assembleRelease({ ...f, plan, outDir: directory, buildRoot: resolve(f.root, 'no-builds'), enforceSource: false,
    platforms: ['mac-arm64', 'mac-x64', 'linux-server'] });
  const inventory = await Promise.all((await readdir(directory)).map(async name => {
    const path = resolve(directory, name);
    return { name, size: (await stat(path)).size, sha256: await fileDigest(path) };
  }));
  assert.equal((await verifyRecoveryBundle({ ...f, plan, directory, inventory })).signedProductSource, publisher);
});

test('complete unchanged signed original bundle recovers; modified bytes and unsigned extras fail', async t => {
  const f = await bundle(t), inventory = await f.inventory();
  assert.equal((await verifyRecoveryBundle({ ...f, inventory })).signedProductSource, source);
  const path = resolve(f.directory, 'benchgo-1.0.0-plugin.tar.gz'), original = await readFile(path);
  await writeFile(path, 'corrupt'); await assert.rejects(verifyRecoveryBundle({ ...f, inventory }), /changed/); await writeFile(path, original);
  await rm(path); await assert.rejects(verifyRecoveryBundle({ ...f, inventory }), /Unaccounted/); await writeFile(path, original);
  await writeFile(resolve(f.directory, 'unsigned.exe'), 'unverified'); await f.refreshSums();
  await assert.rejects(verifyRecoveryBundle({ ...f, inventory: await f.inventory() }), /Unsigned or unknown/);
});

test('recovery accepts historical staging only when the original source used that path', async t => {
  const f = await bundle(t);
  const legacy = 'plugins/benchgo/package.json', current = 'plugins/base/package.json';
  assert.throws(() => recoveryStagingPath([]), /one plugin staging path/);
  assert.throws(() => recoveryStagingPath([legacy, current]), /one plugin staging path/);
  for (const component of ['plugin', 'windows', 'android']) {
    const file = resolve(f.directory, `${component}-source.json`);
    const receipt = JSON.parse(await readFile(file));
    receipt.staged[0].path = legacy;
    await writeFile(file, json(receipt));
  }
  await f.refreshSums();
  const inventory = await f.inventory();
  assert.equal((await verifyRecoveryBundle({ ...f, inventory, stagingPath: recoveryStagingPath([legacy]) })).signedProductSource, source);
  await assert.rejects(verifyRecoveryBundle({ ...f, inventory, stagingPath: recoveryStagingPath([current]) }), /Unexpected build staging changes/);
});

test('a forged receipt, broken signature, wrong source, native checksum, or signed extra catalog entry is refused', async t => {
  const f = await bundle(t);
  const attempt = async (name, mutate, pattern) => { const path = resolve(f.directory, name), original = await readFile(path);
    await writeFile(path, mutate(original)); await f.refreshSums(); await assert.rejects(verifyRecoveryBundle({ ...f, inventory: await f.inventory() }), pattern);
    await writeFile(path, original); await f.refreshSums(); };
  await attempt('plugin-source.json', bytes => json({ ...JSON.parse(bytes), verified: [] }), /verification/);
  await attempt('plugin-source.json', bytes => { const receipt = JSON.parse(bytes); receipt.files[0].sha256 = '0'.repeat(64); return json(receipt); }, /Signed component differs/);
  await attempt('linux-server-source.json', bytes => json({ ...JSON.parse(bytes), sourceSha: publisher }), /source or platform/);
  await attempt('release-source.json', bytes => json({ ...JSON.parse(bytes), manifestSha256: '0'.repeat(64) }), /receipt differs/);
  await attempt('benchgo-update.json.sig', bytes => Buffer.from('A'.repeat(bytes.length)), /signature|签名|UPDATE_SIGNATURE/i);
  await attempt('latest.yml', bytes => { const feed = JSON.parse(bytes); const checksum = Buffer.alloc(64).toString('base64'); feed.sha512 = checksum; feed.files[0].sha512 = checksum; return json(feed); }, /updater checksum/);
  const path = resolve(f.directory, 'downloads.json'), catalog = JSON.parse(await readFile(path)); catalog.files.push(catalog.files[0]);
  const raw = json(catalog); await writeFile(path, raw); await writeFile(resolve(f.directory, 'downloads.json.sig'), `${sign(null, raw, f.privateKey).toString('base64')}\n`); await f.refreshSums();
  await assert.rejects(verifyRecoveryBundle({ ...f, inventory: await f.inventory() }), /exactly the original/);
});
