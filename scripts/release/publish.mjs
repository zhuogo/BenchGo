import { createReadStream } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { compareVersions, validateReleaseManifest } from '../../plugins/benchgo/shared/update-feed.mjs';
import { github, githubJson, assetBytes, findPreviousRelease, readSignedRelease, releaseKind, sha256 } from './github.mjs';
import { fileDigest } from './record-artifact.mjs';
import { immutableArtifact } from './assemble.mjs';

const sendJson = (path, method, body) => githubJson(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const getRelease = tag => githubJson(`/releases/tags/${encodeURIComponent(tag)}`, { missing: true });

export function validatePublishBaseline({ plan, current }) {
  if (!current && !plan.previous) return;
  if (current?.releaseVersion === plan.releaseVersion && current.sourceSha === plan.sourceSha) return;
  if (!current || !plan.previous || current.tag !== plan.previous.tag || current.sourceSha !== plan.previous.sourceSha
    || current.manifestSha256 !== plan.previous.manifestSha256) throw new Error('Unified baseline changed during the build; generate a new plan before publishing');
  if (compareVersions(plan.releaseVersion, current.releaseVersion) <= 0) throw new Error('Publishing an older unified release is forbidden');
}

export function validateChannelAdvance(previous, next) {
  if (!previous) return;
  if (previous.releaseVersion && compareVersions(next.releaseVersion, previous.releaseVersion) < 0) throw new Error('Update channel cannot roll back');
  if (previous.releaseVersion === next.releaseVersion && previous.sourceSha !== next.sourceSha) throw new Error('One unified version cannot identify two source commits');
  for (const key of ['plugin', 'app', 'android']) if (previous[key] && next[key]
    && compareVersions(next[key].version, previous[key].version) < 0) throw new Error(`${key} update channel cannot roll back`);
  if (previous.android && next.android && next.android.versionCode < previous.android.versionCode) throw new Error('Android versionCode cannot roll back');
}

export function validateAppChannelAdvance(feed, manifest) {
  if (!feed) return;
  if (compareVersions(manifest.app.version, feed.version) < 0) throw new Error('Windows application feed cannot roll back');
  if (!Array.isArray(feed.files) || !feed.files.length || typeof feed.files[0].sha512 !== 'string') throw new Error('Existing Windows feed is invalid');
}

async function readAppChannel(release) {
  const asset = release?.assets?.find(row => row.name === 'latest.yml');
  if (!asset) return null;
  try { return JSON.parse((await assetBytes(asset)).toString('utf8')); }
  catch { throw new Error('Existing application feed must be valid JSON/YAML-compatible metadata before it can be advanced safely'); }
}

async function remoteDigest(asset) {
  if (/^sha256:[a-f0-9]{64}$/.test(asset.digest)) return asset.digest.slice(7);
  const response = await github(`/releases/assets/${asset.id}`, { headers: { accept: 'application/octet-stream' }, signal: AbortSignal.timeout(600_000) });
  const hash = createHash('sha256');
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest('hex');
}

async function upload(release, path, { replace = false } = {}) {
  const name = basename(path), metadata = await stat(path), digest = await fileDigest(path);
  const existing = release.assets.find(asset => asset.name === name);
  if (existing) {
    if (existing.size === metadata.size && await remoteDigest(existing) === digest) return;
    if (!replace) throw new Error(`Immutable release asset already exists with different content: ${name}`);
    await github(`/releases/assets/${existing.id}`, { method: 'DELETE' });
  }
  const uploadUrl = new URL(release.upload_url.replace(/\{.*$/, ''));
  uploadUrl.searchParams.set('name', name);
  const response = await github(uploadUrl.href, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'content-length': String(metadata.size) },
    body: createReadStream(path), duplex: 'half', signal: AbortSignal.timeout(900_000) });
  const asset = await response.json();
  if (asset.size !== metadata.size || await remoteDigest(asset) !== digest) throw new Error(`Uploaded asset verification failed: ${name}`);
  release.assets = [...release.assets.filter(item => item.name !== name), asset];
}

async function verifyReferencedArtifacts(manifest) {
  const releaseCache = new Map();
  for (const artifact of [manifest.plugin, manifest.app, manifest.android]) {
    immutableArtifact(artifact);
    const url = new URL(artifact.url), pieces = url.pathname.split('/'), tag = pieces.at(-2), name = pieces.at(-1);
    if (!releaseCache.has(tag)) releaseCache.set(tag, await getRelease(tag));
    const release = releaseCache.get(tag), asset = release?.assets?.find(row => row.name === name);
    if (!release || release.draft || !asset || asset.size !== artifact.size || await remoteDigest(asset) !== artifact.sha256) throw new Error(`Release artifact is unavailable or mismatched: ${name}`);
  }
}

async function readChannelForPublication(release, plan, nextRaw, nextSignature, publicKey) {
  if (!release) return null;
  try { return (await readSignedRelease(release)).manifest; }
  catch (error) {
    // A retry may see one half of our previously interrupted two-asset update.
    // Recover only bytes from the verified planning baseline or this signed candidate.
    const baseline = plan.channelBaseline;
    const oldRaw = baseline ? Buffer.from(baseline.rawBase64, 'base64') : null;
    const oldSignature = baseline ? Buffer.from(baseline.signatureBase64, 'base64') : null;
    if (baseline && (!verify(null, oldRaw, publicKey, Buffer.from(oldSignature.toString('utf8').trim(), 'base64'))
      || JSON.stringify(JSON.parse(oldRaw.toString('utf8'))) !== JSON.stringify(baseline.manifest))) throw new Error('Recovery baseline signature is invalid');
    for (const [name, candidate, previous] of [['benchgo-update.json', nextRaw, oldRaw], ['benchgo-update.json.sig', nextSignature, oldSignature]]) {
      const asset = release.assets?.find(row => row.name === name);
      if (!asset) continue;
      const bytes = await assetBytes(asset);
      if (!bytes.equals(candidate) && (!previous || !bytes.equals(previous))) throw new Error('Invalid channel contains unknown bytes; refusing automatic repair');
    }
    return baseline?.manifest ?? null;
  }
}

export async function publishRelease({ plan, directory }) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_SHA !== plan.sourceSha) throw new Error('Publishing is restricted to explicit main-branch release workflow dispatch');
  const output = resolve(directory), raw = await readFile(resolve(output, 'benchgo-update.json'));
  const signatureBytes = await readFile(resolve(output, 'benchgo-update.json.sig'));
  const signature = signatureBytes.toString('utf8');
  const publicKey = createPublicKey(await readFile(new URL('../../plugins/benchgo/shared/update-public-key.pem', import.meta.url)));
  if (!verify(null, raw, publicKey, Buffer.from(signature.trim(), 'base64'))) throw new Error('Cannot publish an invalid signed manifest');
  const manifest = validateReleaseManifest(JSON.parse(raw.toString('utf8'))), source = JSON.parse(await readFile(resolve(output, 'release-source.json'), 'utf8'));
  if (manifest.releaseVersion !== plan.releaseVersion || manifest.sourceSha !== plan.sourceSha || source.kind !== releaseKind
    || source.sourceSha !== plan.sourceSha || source.manifestSha256 !== sha256(raw) || source.releaseVersion !== plan.releaseVersion) throw new Error('Release metadata is not bound to the planned source');
  validatePublishBaseline({ plan, current: await findPreviousRelease() });
  const channelRelease = await getRelease('plugin-updates');
  const channel = await readChannelForPublication(channelRelease, plan, raw, signatureBytes, publicKey);
  validateChannelAdvance(channel, manifest);
  validateAppChannelAdvance(await readAppChannel(await getRelease('app-updates')), manifest);
  if (channel?.releaseVersion === manifest.releaseVersion && channel.sourceSha === manifest.sourceSha
    && JSON.stringify(channel) !== JSON.stringify(manifest)) throw new Error('Published unified metadata differs from this retry');
  const tag = plan.tag;
  let release = await getRelease(tag);
  if (release) {
    if (release.draft) {
      if (release.target_commitish !== plan.sourceSha) throw new Error('Existing draft references another source');
    } else if ((await githubJson(`/commits/${tag}`)).sha !== plan.sourceSha) throw new Error('Existing release tag references another source');
  } else {
    const ref = await githubJson(`/git/ref/tags/${tag}`, { missing: true });
    if (ref && (await githubJson(`/commits/${tag}`)).sha !== plan.sourceSha) throw new Error('Release tag already exists at another source');
    release = await sendJson('/releases', 'POST', { tag_name: tag, target_commitish: plan.sourceSha, name: `BenchGo ${plan.releaseVersion}`,
      body: await readFile(resolve(output, 'release-notes.md'), 'utf8'), draft: true, prerelease: false, make_latest: 'false' });
  }
  // Published version assets are never clobbered, including retries after a channel failure.
  const names = (await readdir(output)).filter(name => name !== 'release-notes.md').sort();
  for (const name of names) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error('Invalid release asset name');
    await upload(release, resolve(output, name));
  }
  if (release.draft) release = await sendJson(`/releases/${release.id}`, 'PATCH', { draft: false, make_latest: 'false' });
  if ((await githubJson(`/commits/${tag}`)).sha !== plan.sourceSha) throw new Error('Published release tag does not match verified source');
  await verifyReferencedArtifacts(manifest);
  // Recheck after uploads: a newer channel written outside this serialized workflow must win.
  const refreshedChannel = await getRelease('plugin-updates');
  validateChannelAdvance(await readChannelForPublication(refreshedChannel, plan, raw, signatureBytes, publicKey), manifest);
  const plugins = refreshedChannel ?? await sendJson('/releases', 'POST', { tag_name: 'plugin-updates', target_commitish: plan.sourceSha,
    name: 'BenchGo update channel', body: 'Signed metadata for verified unified BenchGo releases.', draft: false, make_latest: 'false' });
  // All immutable components exist and are verified before either mutable channel is advanced.
  // Advance the native app feed first, so the unified visible point can never demand
  // a new application while native updaters still observe the previous feed.
  if (plan.builds.windows) {
    const apps = await getRelease('app-updates') ?? await sendJson('/releases', 'POST', { tag_name: 'app-updates', target_commitish: plan.sourceSha,
      name: 'BenchGo application update channel', body: 'Windows feed referencing immutable verified release assets.', draft: false, make_latest: 'false' });
    validateAppChannelAdvance(await readAppChannel(apps), manifest);
    await upload(apps, resolve(output, 'latest.yml'), { replace: true });
  }
  // The signature/JSON pair fails closed during the short two-asset replacement window.
  // Its JSON is the final unified-version visible point after the native feed is ready.
  await upload(plugins, resolve(output, 'benchgo-update.json.sig'), { replace: true });
  await upload(plugins, resolve(output, 'benchgo-update.json'), { replace: true });
  await sendJson(`/releases/${release.id}`, 'PATCH', { make_latest: 'true' });
  console.log(`Published BenchGo ${manifest.releaseVersion}; every channel references verified immutable component assets.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { plan: { type: 'string' }, directory: { type: 'string' } } });
  publishRelease({ plan: JSON.parse(await readFile(values.plan, 'utf8')), directory: values.directory })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
