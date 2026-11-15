import { createReadStream } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { compareVersions, resolveUpdateUrl, validateReleaseManifest } from '../../plugins/benchgo/shared/update-feed.mjs';
import { github, githubJson, assetBytes, findPreviousRelease, readSignedRelease, releaseKind, sha256 } from './github.mjs';
import { fileDigest } from './record-artifact.mjs';
import { immutableArtifact } from './assemble.mjs';
import { verifyDownloads } from './downloads.mjs';
import { publishWebCatalog } from './publish-web-catalog.mjs';
import { verifyRecoveryPublication } from './recover-release.mjs';

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

export const appChannelNames = ['latest.yml', 'stable.yml'];

async function readAppChannel(release, name = 'latest.yml') {
  const matches = release?.assets?.filter(row => row.name === name) ?? [], asset = matches[0];
  if (!asset) return null;
  if (matches.length !== 1) throw new Error(`Application channel has duplicate metadata: ${name}`);
  try {
    const bytes = await assetBytes(asset);
    if (asset.digest && asset.digest !== `sha256:${sha256(bytes)}`) throw new Error('metadata digest mismatch');
    return { feed: JSON.parse(bytes.toString('utf8')), bytes };
  }
  catch { throw new Error('Existing application feed must be valid JSON/YAML-compatible metadata before it can be advanced safely'); }
}

async function validateAppChannels(release, manifest) {
  const channels = {};
  for (const name of appChannelNames) {
    channels[name] = await readAppChannel(release, name);
    validateAppChannelAdvance(channels[name]?.feed, manifest);
  }
  return channels;
}

export function validateNativeFeed(bytes, manifest) {
  const feed = JSON.parse(bytes.toString('utf8')), app = immutableArtifact(manifest.app);
  const file = feed.files?.[0], checksum = file?.sha512;
  if (feed.version !== app.version || basename(new URL(app.url).pathname) !== `benchgo-${app.version}-win-x64-setup.exe`
    || !Array.isArray(feed.files) || feed.files.length !== 1 || file.size !== app.size
    || ![app.url, resolveUpdateUrl(app.url)].includes(file.url) || feed.path !== file.url
    || typeof checksum !== 'string' || Buffer.from(checksum, 'base64').length !== 64
    || Buffer.from(checksum, 'base64').toString('base64') !== checksum || feed.sha512 !== checksum) throw new Error('Native application feed does not match the verified immutable Windows artifact');
  return feed;
}

async function readPublicStableRelease(releaseVersion, { publicKey } = {}) {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(releaseVersion)) throw new Error('A public stable release version is required');
  const tag = `v${releaseVersion}`, release = await getRelease(tag);
  if (!release || release.draft || release.prerelease || release.tag_name !== tag) throw new Error('Application channel source must be a public stable release');
  const signed = await readSignedRelease(release, { publicKey });
  const sources = release.assets?.filter(row => row.name === 'release-source.json') ?? [];
  if (sources.length !== 1) throw new Error('Application channel release source receipt is missing or ambiguous');
  const source = JSON.parse((await assetBytes(sources[0])).toString('utf8'));
  if (source.schemaVersion !== 1 || source.kind !== releaseKind || source.releaseVersion !== releaseVersion
    || signed.manifest.releaseVersion !== releaseVersion || source.sourceSha !== signed.manifest.sourceSha
    || !/^[a-f0-9]{40}$/.test(source.sourceSha)
    || source.manifestSha256 !== signed.manifestSha256 || release.target_commitish !== source.sourceSha
    || (await githubJson(`/commits/${tag}`)).sha !== source.sourceSha) throw new Error('Application channel release source does not match its signed manifest');
  return { release, ...signed };
}

async function readImmutableAppFeed(manifest, { publicKey } = {}) {
  const app = immutableArtifact(manifest.app), tag = new URL(app.url).pathname.split('/').at(-2);
  const owner = await readPublicStableRelease(tag.slice(1), { publicKey });
  if (['version', 'url', 'size', 'sha256'].some(key => owner.manifest.app?.[key] !== app[key])) throw new Error('Windows artifact differs between the signed unified and native releases');
  const names = owner.release.assets?.filter(row => row.name === basename(new URL(app.url).pathname)) ?? [];
  if (names.length !== 1 || names[0].size !== app.size || names[0].digest !== `sha256:${app.sha256}`) throw new Error('Immutable Windows asset digest or size differs from the signed manifest');
  const original = await readAppChannel(owner.release);
  if (!original) throw new Error('Immutable Windows release is missing latest.yml');
  if (owner.release.assets.find(row => row.name === 'latest.yml').digest !== `sha256:${sha256(original.bytes)}`) throw new Error('Immutable native feed is missing its verified asset digest');
  validateNativeFeed(original.bytes, manifest);
  return original.bytes;
}

/** Copy verified native metadata without rebuilding or rewriting immutable assets. */
export async function publishAppChannel({ manifest, directory, windowsBuilt = false, repairOnly = false, publicKey }) {
  const bytes = windowsBuilt ? await readFile(resolve(directory, 'latest.yml')) : await readImmutableAppFeed(manifest, { publicKey });
  const feed = validateNativeFeed(bytes, manifest);
  let apps = await getRelease('app-updates');
  const channels = await validateAppChannels(apps, manifest);
  for (const [name, previous] of Object.entries(channels)) if (previous?.feed.version === feed.version && !previous.bytes.equals(bytes)) throw new Error(`Refusing to replace different ${name} bytes for the same application version`);
  if (repairOnly && !channels['latest.yml']?.bytes.equals(bytes)) throw new Error('Repair requires the existing latest.yml to match the verified immutable native feed');
  if (!apps) apps = await sendJson('/releases', 'POST', { tag_name: 'app-updates', target_commitish: manifest.sourceSha,
    name: 'BenchGo application update channel', body: 'Windows feed referencing immutable verified release assets.', draft: false, make_latest: 'false' });
  const temporary = await mkdtemp(resolve(tmpdir(), 'benchgo-app-channel-')), changed = [];
  try {
    for (const name of repairOnly ? ['stable.yml'] : appChannelNames) {
      const path = resolve(temporary, name); await writeFile(path, bytes);
      if (await upload(apps, path, { replace: true })) changed.push(name);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return { releaseVersion: manifest.releaseVersion, appVersion: manifest.app.version, changed };
}

/** Explicit maintenance: recover only stable.yml from an already public signed release. */
export async function repairAppChannel({ releaseVersion, publicKey }) {
  const signed = await readPublicStableRelease(releaseVersion, { publicKey });
  return publishAppChannel({ manifest: signed.manifest, repairOnly: true, publicKey });
}

/** Supply the pinned GenericProvider's old-map URL only within this new Windows release. */
export async function stagePreviousAppBlockmap({ plan, manifest, directory, publicKey }) {
  if (!plan.builds.windows || !plan.previous?.manifest.app) return null;
  const previous = immutableArtifact(plan.previous.manifest.app), app = immutableArtifact(manifest.app);
  if (compareVersions(app.version, previous.version) <= 0) throw new Error('New Windows builds must increase the application version');
  const current = new URL(app.url), oldName = `${basename(new URL(previous.url).pathname)}.blockmap`;
  if (basename(current.pathname) !== `benchgo-${app.version}-win-x64-setup.exe` || oldName !== `benchgo-${previous.version}-win-x64-setup.exe.blockmap`) throw new Error('Previous Windows blockmap requires canonical installer names');
  const derived = `${current.pathname.replaceAll(app.version, previous.version)}.blockmap`;
  if (derived !== new URL(oldName, current).pathname) return { status: 'fallback', reason: 'old-blockmap-is-in-another-directory' };
  const tag = new URL(previous.url).pathname.split('/').at(-2);
  const owner = await readPublicStableRelease(tag.slice(1), { publicKey });
  if (['version', 'url', 'size', 'sha256'].some(key => owner.manifest.app?.[key] !== previous[key])) throw new Error('Previous Windows artifact differs from its signed owner release');
  const installers = owner.release.assets.filter(row => row.name === basename(new URL(previous.url).pathname));
  if (installers.length !== 1 || installers[0].size !== previous.size || installers[0].digest !== `sha256:${previous.sha256}`) throw new Error('Previous Windows asset digest or size differs from its signed manifest');
  const maps = owner.release.assets.filter(row => row.name === oldName);
  if (!maps.length) return { status: 'fallback', reason: 'previous-blockmap-is-unavailable' };
  const asset = maps[0];
  if (maps.length !== 1 || asset.browser_download_url !== `${previous.url}.blockmap` || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error('Previous Windows blockmap identity or digest is invalid');
  const bytes = await assetBytes(asset, { maxBytes: 8 * 1024 * 1024 });
  if (`sha256:${sha256(bytes)}` !== asset.digest) throw new Error('Previous Windows blockmap checksum mismatch');
  const destination = resolve(directory, oldName);
  let existing;
  try { existing = await readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && !existing.equals(bytes)) throw new Error('Refusing to replace different previous Windows blockmap bytes');
  if (!existing) await writeFile(destination, bytes, { flag: 'wx' });
  return { status: 'staged', name: oldName, size: bytes.length, sha256: sha256(bytes) };
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
    if (existing.size === metadata.size && await remoteDigest(existing) === digest) return false;
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
  return true;
}

async function verifyReferencedArtifacts(manifest, downloads) {
  const releaseCache = new Map();
  for (const artifact of [manifest.plugin, manifest.app, manifest.android, ...(downloads?.files ?? [])]) {
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

export async function publishRelease({ plan, directory, recovery }) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Publishing is restricted to explicit main-branch release workflow dispatch');
  if (recovery) await verifyRecoveryPublication({ plan, directory, recovery });
  else if (process.env.GITHUB_SHA !== plan.sourceSha) throw new Error('Publishing checkout differs from the planned product source');
  const output = resolve(directory), raw = await readFile(resolve(output, 'benchgo-update.json'));
  const signatureBytes = await readFile(resolve(output, 'benchgo-update.json.sig'));
  const signature = signatureBytes.toString('utf8');
  const publicKey = createPublicKey(await readFile(new URL('../../plugins/benchgo/shared/update-public-key.pem', import.meta.url)));
  if (!verify(null, raw, publicKey, Buffer.from(signature.trim(), 'base64'))) throw new Error('Cannot publish an invalid signed manifest');
  const manifest = validateReleaseManifest(JSON.parse(raw.toString('utf8'))), source = JSON.parse(await readFile(resolve(output, 'release-source.json'), 'utf8'));
  if (manifest.releaseVersion !== plan.releaseVersion || manifest.sourceSha !== plan.sourceSha || source.kind !== releaseKind
    || source.sourceSha !== plan.sourceSha || source.manifestSha256 !== sha256(raw) || source.releaseVersion !== plan.releaseVersion) throw new Error('Release metadata is not bound to the planned source');
  const downloads = await verifyDownloads({ directory: output, plan, publicKey });
  validatePublishBaseline({ plan, current: await findPreviousRelease() });
  const channelRelease = await getRelease('plugin-updates');
  const channel = await readChannelForPublication(channelRelease, plan, raw, signatureBytes, publicKey);
  validateChannelAdvance(channel, manifest);
  await validateAppChannels(await getRelease('app-updates'), manifest);
  const previousBlockmap = await stagePreviousAppBlockmap({ plan, manifest, directory: output, publicKey });
  if (previousBlockmap?.status === 'fallback') console.log(`Previous Windows blockmap: ${previousBlockmap.reason}; native full-download fallback remains available.`);
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
  await verifyReferencedArtifacts(manifest, downloads);
  await publishWebCatalog({ directory: output, releaseVersion: plan.releaseVersion, sourceSha: plan.sourceSha });
  // Recheck after uploads: a newer channel written outside this serialized workflow must win.
  const refreshedChannel = await getRelease('plugin-updates');
  validateChannelAdvance(await readChannelForPublication(refreshedChannel, plan, raw, signatureBytes, publicKey), manifest);
  const plugins = refreshedChannel ?? await sendJson('/releases', 'POST', { tag_name: 'plugin-updates', target_commitish: plan.sourceSha,
    name: 'BenchGo update channel', body: 'Signed metadata for verified unified BenchGo releases.', draft: false, make_latest: 'false' });
  // All immutable components exist and are verified before either mutable channel is advanced.
  // Advance the native app feed first, so the unified visible point can never demand
  // a new application while native updaters still observe the previous feed.
  // Reused Windows binaries still need their native channel contract repaired.
  await publishAppChannel({ manifest, directory: output, windowsBuilt: plan.builds.windows });
  // The signature/JSON pair fails closed during the short two-asset replacement window.
  // Its JSON is the final unified-version visible point after the native feed is ready.
  await upload(plugins, resolve(output, 'benchgo-update.json.sig'), { replace: true });
  await upload(plugins, resolve(output, 'benchgo-update.json'), { replace: true });
  await sendJson(`/releases/${release.id}`, 'PATCH', { make_latest: 'true' });
  console.log(`Published BenchGo ${manifest.releaseVersion}; every channel references verified immutable component assets.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { plan: { type: 'string' }, directory: { type: 'string' }, 'repair-app-channel': { type: 'boolean' }, 'release-version': { type: 'string' } } });
  if (values['repair-app-channel'] && (values.plan || values.directory)) throw new Error('Application channel repair cannot publish a local release');
  if (values['release-version'] && !values['repair-app-channel']) throw new Error('--release-version is only valid for application channel repair');
  const operation = values['repair-app-channel']
    ? repairAppChannel({ releaseVersion: values['release-version'] })
    : publishRelease({ plan: JSON.parse(await readFile(values.plan, 'utf8')), directory: values.directory });
  operation.then(result => { if (result) console.log(JSON.stringify(result)); })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
