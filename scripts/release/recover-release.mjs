/** Recover only the original verified, signed release artifact. Never build or sign. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { github, githubJson, releaseKind, sha256 } from './github.mjs';
import { fileDigest } from './record-artifact.mjs';
import { validateReceipt } from './assemble.mjs';
import { downloadPlatforms, validatePlatformReceipt, verifyDownloads } from './downloads.mjs';
import { releaseDownloadUrl, validateReleaseManifest, verifySignedJson } from '../../plugins/base/shared/update-feed.mjs';

const execute = promisify(execFile);
const safeName = name => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
const sourceSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const version = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
export const recoveryJobs = ['plan', 'linux / package', 'android / package', 'plugin / package',
  'macos / package (macos-15, arm64)', 'macos / package (macos-15-intel, x64)', 'windows / package'];

export function validateRecoveryContext({ runId, productSource, releaseVersion, publisherSource, run, jobs, artifacts, comparison }) {
  if (!/^\d+$/.test(String(runId)) || !sourceSha(productSource) || !sourceSha(publisherSource) || !version(releaseVersion)) throw new Error('Invalid explicit recovery identity');
  if (String(run.id) !== String(runId) || run.head_sha !== productSource || run.head_branch !== 'main'
    || run.event !== 'workflow_dispatch' || run.path !== '.github/workflows/unified-release.yml'
    || run.repository?.full_name !== 'zhuogo/BenchGo' || run.head_repository?.full_name !== 'zhuogo/BenchGo'
    || run.status !== 'completed' || run.conclusion !== 'failure') throw new Error('Recovery requires the original failed main-branch unified release run');
  if (!['ahead', 'identical'].includes(comparison?.status) || comparison.merge_base_commit?.sha !== productSource) throw new Error('Product source must be an ancestor of the real recovery publisher checkout');
  if (!Array.isArray(jobs) || jobs.length !== recoveryJobs.length + 1) throw new Error('Recovery job set is incomplete or ambiguous');
  for (const name of recoveryJobs) {
    const matches = jobs.filter(job => job.name === name);
    if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') throw new Error(`Recovery source verification did not succeed: ${name}`);
  }
  const publish = jobs.filter(job => job.name === 'publish');
  if (publish.length !== 1 || publish[0].status !== 'completed' || publish[0].conclusion !== 'failure') throw new Error('Only a failed publication after successful builds can be recovered');
  const steps = publish[0].steps ?? [];
  for (const name of ['Verify provenance and checksums, reuse unchanged immutable assets, then sign one manifest', 'Run actions/upload-artifact@v4']) {
    if (steps.filter(step => step.name === name && step.conclusion === 'success').length !== 1) throw new Error('Original assembly or signed artifact retention did not succeed');
  }
  if (steps.filter(step => step.name === 'Publish complete immutable release, then advance signed channels' && step.conclusion === 'failure').length !== 1
    || steps.some(step => step.conclusion === 'failure' && step.name !== 'Publish complete immutable release, then advance signed channels')) throw new Error('Failure is not confined to the final publisher');
  const selected = {};
  for (const name of ['benchgo-release-plan', 'benchgo-release-ready']) {
    const matches = artifacts.filter(artifact => artifact.name === name && !artifact.expired);
    const artifact = matches[0];
    if (matches.length !== 1 || !Number.isSafeInteger(artifact.id) || !Number.isSafeInteger(artifact.size_in_bytes)
      || artifact.size_in_bytes < 1 || artifact.size_in_bytes > (name.endsWith('plan') ? 1024 * 1024 : 8 * 1024 ** 3)
      || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) || artifact.workflow_run?.id !== Number(runId)
      || artifact.workflow_run?.head_sha !== productSource) throw new Error(`Original signed artifact is missing or not source-bound: ${name}`);
    selected[name] = artifact;
  }
  return selected;
}

export async function verifyRecoveryRun({ runId, productSource, releaseVersion, request = githubJson, env = process.env }) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_WORKFLOW !== 'Recover BenchGo verified release' || !sourceSha(env.GITHUB_SHA)) throw new Error('Recovery is restricted to its explicit main-branch workflow');
  if (!/^\d+$/.test(String(runId)) || !sourceSha(productSource) || !version(releaseVersion)) throw new Error('Invalid recovery request');
  const [run, listedJobs, listedArtifacts, comparison] = await Promise.all([
    request(`/actions/runs/${runId}`), request(`/actions/runs/${runId}/jobs?per_page=100&filter=latest`),
    request(`/actions/runs/${runId}/artifacts?per_page=100`), request(`/compare/${productSource}...${env.GITHUB_SHA}`),
  ]);
  if (listedJobs.total_count !== listedJobs.jobs?.length || listedArtifacts.total_count !== listedArtifacts.artifacts?.length) throw new Error('Recovery inventory requires an unambiguous complete API page');
  const artifacts = validateRecoveryContext({ runId, productSource, releaseVersion, publisherSource: env.GITHUB_SHA,
    run, jobs: listedJobs.jobs, artifacts: listedArtifacts.artifacts, comparison });
  return { runId: Number(runId), productSource, releaseVersion, publisherSource: env.GITHUB_SHA, artifacts };
}

export async function verifyArchive(path, artifact) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.size_in_bytes || `sha256:${await fileDigest(path)}` !== artifact.digest) throw new Error('Original workflow artifact ZIP digest or size differs');
}

async function downloadArchive(artifact, path) {
  try { await stat(path); await verifyArchive(path, artifact); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await github(`/actions/artifacts/${artifact.id}/zip`, { signal: AbortSignal.timeout(20 * 60_000) });
  const hash = createHash('sha256'); let size = 0;
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, done) {
    size += chunk.length; hash.update(chunk);
    done(size > artifact.size_in_bytes ? new Error('Workflow artifact exceeds its authenticated size') : null, chunk);
  } }), createWriteStream(`${path}.part`, { flags: 'wx' }));
  if (size !== artifact.size_in_bytes || `sha256:${hash.digest('hex')}` !== artifact.digest) throw new Error('Downloaded original artifact does not match its GitHub digest');
  await rename(`${path}.part`, path);
}

// Python's standard ZIP reader verifies CRCs. Only flat regular release files
// are allowed; no paths, links, devices, duplicate names, or unchecked zip bombs.
export async function inspectArchive(archive, destination) {
  const code = `import hashlib,json,os,re,stat,sys,zipfile
archive,target=sys.argv[1:3]
with zipfile.ZipFile(archive) as z:
 entries=z.infolist()
 if not entries or len(entries)>100: raise ValueError('invalid ZIP inventory')
 names=set(); total=0; result=[]
 for e in entries:
  if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*',e.filename) or e.filename.lower() in names: raise ValueError('unsafe or duplicate ZIP name')
  names.add(e.filename.lower()); mode=e.external_attr>>16
  if e.is_dir() or stat.S_IFMT(mode) not in (0,stat.S_IFREG): raise ValueError('non-regular ZIP entry')
  total+=e.file_size
  if e.file_size>2*1024**3 or total>8*1024**3: raise ValueError('oversized ZIP inventory')
 if target: os.mkdir(target)
 for e in entries:
  h=hashlib.sha256(); size=0
  out=open(os.path.join(target,e.filename),'xb') if target else None
  try:
   with z.open(e) as source:
    while True:
     block=source.read(1024*1024)
     if not block: break
     size+=len(block); h.update(block)
     if out: out.write(block)
   if size!=e.file_size: raise ValueError('ZIP entry size mismatch')
  finally:
   if out: out.close()
  result.append(dict(name=e.filename,size=size,sha256=h.hexdigest()))
 print(json.dumps(result))`;
  const { stdout } = await execute(process.platform === 'win32' ? 'python' : 'python3', ['-c', code, resolve(archive), destination ? resolve(destination) : ''],
    { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}

export function recoveryStagingPath(sourcePaths) {
  const matches = sourcePaths.filter(path => path === 'plugins/base/package.json' || path === 'plugins/benchgo/package.json');
  if (matches.length !== 1) throw new Error('Original product source must identify one plugin staging path');
  return matches[0];
}

export async function verifyRecoveryBundle({ plan, directory, inventory, publicKey, stagingPath }) {
  if (plan.schemaVersion !== 1 || plan.kind !== releaseKind || plan.tag !== `v${plan.releaseVersion}`
    || !sourceSha(plan.sourceSha) || !version(plan.releaseVersion) || Object.values(plan.builds).some(value => value !== true)
    || Object.keys(plan.builds).sort().join(',') !== 'android,plugin,windows') throw new Error('Recovery requires the original complete release plan');
  const expected = new Map(inventory.map(file => [file.name, file]));
  if (expected.size !== inventory.length || inventory.some(file => !safeName(file.name))) throw new Error('Invalid original archive inventory');
  assert.deepEqual((await readdir(directory)).sort(), [...expected.keys()].sort(), 'Unaccounted files were injected into the original release');
  for (const file of inventory) {
    const path = resolve(directory, file.name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size || await fileDigest(path) !== file.sha256) throw new Error(`Original release file changed: ${file.name}`);
  }
  const bytes = name => readFile(resolve(directory, name));
  const manifest = validateReleaseManifest(verifySignedJson(await bytes('benchgo-update.json'), await bytes('benchgo-update.json.sig'), publicKey));
  if (manifest.sourceSha !== plan.sourceSha || manifest.releaseVersion !== plan.releaseVersion
    || manifest.minAppVersion !== plan.minAppVersion || manifest.engine.min !== plan.versions.engine
    || manifest.engine.max !== plan.versions.engine) throw new Error('Original signed manifest differs from the requested product source');
  const catalog = await verifyDownloads({ directory, plan, publicKey });
  const catalogFiles = [];
  const sums = (await bytes('SHA256SUMS.txt')).toString('utf8').trim().split('\n').map(line => /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line));
  if (sums.some(row => !row) || new Set(sums.map(row => row[2])).size !== sums.length) throw new Error('Invalid original checksum inventory');
  assert.deepEqual(sums.map(row => row[2]).sort(), inventory.map(file => file.name).filter(name => !['SHA256SUMS.txt', 'release-notes.md'].includes(name)).sort());
  for (const row of sums) if (expected.get(row[2])?.sha256 !== row[1]) throw new Error('Original checksum inventory differs from the authenticated ZIP');
  const source = JSON.parse(await bytes('release-source.json'));
  if (source.schemaVersion !== 1 || source.kind !== releaseKind || source.sourceSha !== plan.sourceSha || source.releaseVersion !== plan.releaseVersion
    || source.manifestSha256 !== sha256(await bytes('benchgo-update.json'))) throw new Error('Original release source receipt differs');
  assert.deepEqual(source.builds, plan.builds);
  assert.deepEqual(source.baseline, plan.previous ? { tag: plan.previous.tag, sourceSha: plan.previous.sourceSha, manifestSha256: plan.previous.manifestSha256 } : null);
  const accounted = new Set(['benchgo-update.json', 'benchgo-update.json.sig', 'downloads.json', 'downloads.json.sig', 'release-source.json', 'latest.yml', 'SHA256SUMS.txt', 'release-notes.md']);
  const matchFile = file => {
    const original = expected.get(file.name);
    if (!original || original.size !== file.size || original.sha256 !== file.sha256) throw new Error(`Original component receipt checksum differs: ${file.name}`);
    accounted.add(file.name);
  };
  for (const component of ['plugin', 'windows', 'android']) {
    const receiptName = `${component}-source.json`;
    const receipt = validateReceipt(JSON.parse(await bytes(receiptName)), plan, component, { stagingPath });
    accounted.add(receiptName);
    const payload = receipt.files.find(file => file.name === receipt.artifact), artifact = component === 'windows' ? manifest.app : manifest[component];
    if (artifact.version !== receipt.version || artifact.url !== releaseDownloadUrl(payload.name, plan.tag) || artifact.size !== payload.size || artifact.sha256 !== payload.sha256
      || component === 'android' && artifact.versionCode !== receipt.versionCode) throw new Error('Signed component differs from its original receipt');
    catalogFiles.push({ target: component === 'windows' ? 'windows-x64' : component, ...artifact });
    assert.deepEqual(source.components[component], { version: receipt.version, sourceSha: plan.sourceSha, releaseVersion: plan.releaseVersion, receiptUrl: releaseDownloadUrl(receiptName, plan.tag) });
    for (const file of receipt.files) if (component === 'windows' && /(?:\.exe|\.blockmap)$/.test(file.name)
      || component === 'plugin' && file.name.endsWith('.tar.gz') || component === 'android' && /\.apk(?:\.sha256)?$/.test(file.name)) matchFile(file);
  }
  for (const platform of downloadPlatforms) {
    const receiptName = `${platform}-source.json`, receipt = JSON.parse(await bytes(receiptName));
    const { expected: payloads } = validatePlatformReceipt(receipt, plan, platform); accounted.add(receiptName);
    for (const file of receipt.files) {
      matchFile(file);
      if (payloads.includes(file.name)) catalogFiles.push({ target: platform, version: receipt.version,
        url: releaseDownloadUrl(file.name, plan.tag), size: file.size, sha256: file.sha256,
        ...(platform.startsWith('mac-') ? { signing: receipt.signing, notarized: false } : { kind: 'server', arch: 'x64', systems: ['Ubuntu', 'Debian'] }) });
    }
  }
  const byTargetAndUrl = (a, b) => `${a.target}:${a.url}`.localeCompare(`${b.target}:${b.url}`);
  assert.deepEqual([...catalog.files].sort(byTargetAndUrl), catalogFiles.sort(byTargetAndUrl), 'Signed catalog must contain exactly the original verified component and platform payloads');
  assert.deepEqual([...accounted].sort(), [...expected.keys()].sort(), 'Unsigned or unknown release files are forbidden');
  const { validateNativeFeed } = await import('./publish.mjs');
  const feed = validateNativeFeed(await bytes('latest.yml'), manifest);
  if (feed.sha512 !== await fileDigest(resolve(directory, basename(new URL(manifest.app.url).pathname)), 'sha512')) throw new Error('Native updater checksum differs from the immutable Windows installer');
  return { manifestSha256: source.manifestSha256, files: inventory.length, signedProductSource: manifest.sourceSha };
}

export async function verifyRecoveryPublication({ plan, directory, recovery }) {
  const context = await verifyRecoveryRun({ runId: recovery.runId, productSource: plan.sourceSha, releaseVersion: plan.releaseVersion });
  await verifyArchive(recovery.planArchive, context.artifacts['benchgo-release-plan']);
  await verifyArchive(recovery.readyArchive, context.artifacts['benchgo-release-ready']);
  const planInventory = await inspectArchive(recovery.planArchive);
  if (planInventory.length !== 1 || planInventory[0].name !== 'release-plan.json') throw new Error('Invalid original planning archive');
  const planBytes = await readFile(recovery.planPath);
  if (sha256(planBytes) !== planInventory[0].sha256) throw new Error('Original plan bytes changed');
  assert.deepEqual(JSON.parse(planBytes), plan);
  const inventory = await inspectArchive(recovery.readyArchive);
  const { stdout } = await execute('git', ['ls-tree', '-r', '--name-only', context.productSource, '--', 'plugins/base/package.json', 'plugins/benchgo/package.json'],
    { cwd: fileURLToPath(new URL('../../', import.meta.url)) });
  const stagingPath = recoveryStagingPath(stdout.trim().split(/\r?\n/));
  const verified = await verifyRecoveryBundle({ plan, directory, inventory, stagingPath,
    publicKey: await readFile(new URL('../../plugins/base/shared/update-public-key.pem', import.meta.url)) });
  const proof = { schemaVersion: 1, runId: context.runId, productSource: context.productSource, publisherSource: context.publisherSource,
    releaseVersion: plan.releaseVersion, originalArtifacts: Object.values(context.artifacts).map(({ id, name, size_in_bytes, digest }) => ({ id, name, size: size_in_bytes, digest })),
    ...verified, rebuilt: false, resigned: false };
  await writeFile(resolve(dirname(directory), 'recovery-verification.json'), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify(proof));
  return proof;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { run: { type: 'string' }, source: { type: 'string' }, version: { type: 'string' }, directory: { type: 'string' } } });
  (async () => {
    const context = await verifyRecoveryRun({ runId: values.run, productSource: values.source, releaseVersion: values.version });
    const root = resolve(values.directory || 'artifacts/recovery'); await mkdir(root, { recursive: true });
    const planArchive = resolve(root, 'release-plan.zip'), readyArchive = resolve(root, 'release-ready.zip');
    await downloadArchive(context.artifacts['benchgo-release-plan'], planArchive);
    await downloadArchive(context.artifacts['benchgo-release-ready'], readyArchive);
    const planDirectory = resolve(root, 'plan'), directory = resolve(root, 'ready');
    await inspectArchive(planArchive, planDirectory); await inspectArchive(readyArchive, directory);
    const planPath = resolve(planDirectory, 'release-plan.json'), plan = JSON.parse(await readFile(planPath, 'utf8'));
    if (plan.sourceSha !== values.source || plan.releaseVersion !== values.version) throw new Error('Downloaded plan differs from explicit recovery request');
    const { publishRelease } = await import('./publish.mjs');
    await publishRelease({ plan, directory, recovery: { runId: context.runId, planArchive, readyArchive, planPath } });
  })().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
