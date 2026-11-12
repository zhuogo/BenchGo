import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validateReleaseManifest, compareVersions } from '../../plugins/benchgo/shared/update-feed.mjs';

export const repository = 'zhuogo/BenchGo';
export const releaseKind = 'benchgo-unified-release';
const base = `https://api.github.com/repos/${repository}`;
export const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function github(path, options = {}) {
  const response = await fetch(path.startsWith('https://') ? path : `${base}${path}`, {
    ...options,
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
      ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}), ...options.headers },
    signal: options.signal ?? AbortSignal.timeout(60_000),
  });
  if (options.missing && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub ${options.method ?? 'GET'} ${new URL(response.url).pathname}: HTTP ${response.status}`);
  return response;
}

export async function githubJson(path, options = {}) {
  const response = await github(path, options);
  return response ? response.json() : null;
}

export async function assetBytes(asset, { maxBytes = 512 * 1024 } = {}) {
  if (!asset || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > maxBytes) throw new Error('Release metadata is missing or oversized');
  const response = await github(`/releases/assets/${asset.id}`, { headers: { accept: 'application/octet-stream' } });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== asset.size || bytes.length > maxBytes) throw new Error('Release metadata size mismatch');
  return bytes;
}

export async function readSignedRelease(release, { publicKey } = {}) {
  const byName = name => release.assets?.find(asset => asset.name === name);
  const raw = await assetBytes(byName('benchgo-update.json'));
  const signature = await assetBytes(byName('benchgo-update.json.sig'), { maxBytes: 4096 });
  const trusted = createPublicKey(publicKey ?? await readFile(new URL('../../plugins/benchgo/shared/update-public-key.pem', import.meta.url)));
  if (!verify(null, raw, trusted, Buffer.from(signature.toString('utf8').trim(), 'base64'))) throw new Error('Previous release signature is invalid');
  const manifest = validateReleaseManifest(JSON.parse(raw.toString('utf8')));
  return { manifest, raw, signature, manifestSha256: sha256(raw) };
}

export async function readChannelBaseline() {
  const release = await githubJson('/releases/tags/plugin-updates', { missing: true });
  if (!release) return null;
  const signed = await readSignedRelease(release);
  return { manifest: signed.manifest, rawBase64: signed.raw.toString('base64'), signatureBase64: signed.signature.toString('base64') };
}

export async function findPreviousRelease() {
  const candidates = [];
  for (let page = 1; page <= 20; page++) {
    const rows = await githubJson(`/releases?per_page=100&page=${page}`);
    for (const release of rows) if (!release.draft && !release.prerelease && /^v\d+\.\d+\.\d+$/.test(release.tag_name)
      && release.assets?.some(asset => asset.name === 'release-source.json')) candidates.push(release);
    if (rows.length < 100) break;
    if (page === 20) throw new Error('Too many releases; cannot prove the latest unified baseline');
  }
  candidates.sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)));
  if (!candidates.length) return null;
  const release = candidates[0], signed = await readSignedRelease(release);
  const source = JSON.parse((await assetBytes(release.assets.find(asset => asset.name === 'release-source.json'))).toString('utf8'));
  if (source.schemaVersion !== 1 || source.kind !== releaseKind || source.releaseVersion !== signed.manifest.releaseVersion
    || release.tag_name !== `v${source.releaseVersion}` || source.sourceSha !== signed.manifest.sourceSha
    || source.manifestSha256 !== signed.manifestSha256 || !/^[a-f0-9]{40}$/.test(source.sourceSha)) throw new Error('Unified release source receipt does not match its signed manifest');
  const commit = await githubJson(`/commits/${encodeURIComponent(release.tag_name)}`);
  if (commit.sha !== source.sourceSha) throw new Error('Previous release tag points to another source commit');
  return { releaseVersion: source.releaseVersion, tag: release.tag_name, sourceSha: source.sourceSha,
    manifestSha256: signed.manifestSha256, manifest: signed.manifest, source };
}
