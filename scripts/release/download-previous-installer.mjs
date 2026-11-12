import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { compareVersions } from '../../plugins/benchgo/shared/update-feed.mjs';
import { assetBytes, findPreviousRelease, github, githubJson, repository } from './github.mjs';

export function selectLegacyInstaller(releases, currentVersion) {
  return releases.filter(release => !release.draft && !release.prerelease && /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(release.tag_name)
    && !release.assets?.some(asset => asset.name === 'release-source.json')
    && compareVersions(release.tag_name.slice(1), currentVersion) < 0
    && release.assets?.some(asset => asset.name === `benchgo-${release.tag_name.slice(1)}-win-x64-setup.exe`))
    .sort((left, right) => compareVersions(right.tag_name.slice(1), left.tag_name.slice(1)))[0] ?? null;
}

export function legacyInstallerChecksum(text, filename) {
  const matching = text.split(/\r?\n/).map(line => /^([a-f0-9]{64})[ \t]+\*?(.+)$/i.exec(line))
    .filter(row => row?.[2] === filename);
  if (matching.length !== 1) throw new Error('Legacy SHA256SUMS must contain exactly one matching Windows installer');
  return matching[0][1].toLowerCase();
}

export function checkedLegacyAsset(release, name) {
  const asset = release.assets.find(row => row.name === name);
  if (!asset || !Number.isSafeInteger(asset.id) || !Number.isSafeInteger(asset.size) || asset.size < 1
    || asset.browser_download_url !== `https://github.com/${repository}/releases/download/${release.tag_name}/${name}`) throw new Error('Legacy installer asset is missing or belongs to another repository/tag');
  return asset;
}

export async function saveInstaller(response, { name, size, sha256, output }) {
  if (!response.ok || !response.body) throw new Error(`Previous installer download failed: HTTP ${response.status}`);
  await mkdir(output, { recursive: true });
  const destination = resolve(output, name), temporary = `${destination}.download-${randomUUID()}`;
  const hash = createHash('sha256'); let received = 0, magic = Buffer.alloc(0);
  try {
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > size) { callback(new Error('Previous installer exceeds its recorded size')); return; }
      if (magic.length < 2) magic = Buffer.concat([magic, chunk]).subarray(0, 2);
      hash.update(chunk); callback(null, chunk);
    } }), createWriteStream(temporary, { flags: 'wx' }));
    if (received !== size || hash.digest('hex') !== sha256 || magic.toString() !== 'MZ') throw new Error('Previous installer checksum mismatch');
    await rename(temporary, destination);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}

export async function downloadPreviousInstaller({ output = 'previous' } = {}) {
  const previous = await findPreviousRelease();
  if (previous?.manifest.app) {
    const app = previous.manifest.app, name = new URL(app.url).pathname.split('/').at(-1);
    if (!/^benchgo-\d+\.\d+\.\d+-win-x64-setup\.exe$/.test(name) || !/^[a-f0-9]{64}$/.test(app.sha256) || !Number.isSafeInteger(app.size)) throw new Error('Previous signed Windows artifact is invalid');
    await saveInstaller(await fetch(app.url, { signal: AbortSignal.timeout(600_000) }), { ...app, name, output });
    console.log(`Verified previous installer ${name} from signed unified release ${previous.tag}`);
    return;
  }
  // Only initial unified adoption uses legacy installers. They never become a release-planning baseline.
  const currentVersion = JSON.parse(await readFile('package.json', 'utf8')).version, releases = [];
  for (let page = 1; page <= 20; page++) {
    const rows = await githubJson(`/releases?per_page=100&page=${page}`); releases.push(...rows);
    if (rows.length < 100) break;
    if (page === 20) throw new Error('Too many releases to identify a legacy Windows upgrade source');
  }
  const legacy = selectLegacyInstaller(releases, currentVersion);
  if (!legacy) { console.log('No older official Windows installer; fresh-install verification remains required.'); return; }
  const name = `benchgo-${legacy.tag_name.slice(1)}-win-x64-setup.exe`, installer = checkedLegacyAsset(legacy, name);
  const checksumAsset = checkedLegacyAsset(legacy, 'SHA256SUMS.txt');
  const checksum = legacyInstallerChecksum((await assetBytes(checksumAsset)).toString('utf8'), name);
  const commit = await githubJson(`/commits/${encodeURIComponent(legacy.tag_name)}`);
  if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error('Legacy release tag cannot be resolved to an immutable repository commit');
  await saveInstaller(await github(`/releases/assets/${installer.id}`, { headers: { accept: 'application/octet-stream' }, signal: AbortSignal.timeout(600_000) }),
    { name, size: installer.size, sha256: checksum, output });
  if ((await githubJson(`/commits/${encodeURIComponent(legacy.tag_name)}`)).sha !== commit.sha) throw new Error('Legacy release tag changed during download');
  console.log(`Verified legacy upgrade installer ${name} and SHA256SUMS from ${legacy.tag_name} (${commit.sha}); not used as a unified release baseline.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  downloadPreviousInstaller().catch(error => { console.error(error.message); process.exitCode = 1; });
}
