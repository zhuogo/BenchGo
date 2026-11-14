/** Verify supplemental platform builds before adding them to an immutable release. */
import { sign, verify } from 'node:crypto';
import { cp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileDigest } from './record-artifact.mjs';
import { releaseDownloadUrl } from '../../plugins/benchgo/shared/update-feed.mjs';

export const downloadPlatforms = ['mac-arm64', 'mac-x64', 'linux-server'];
const safeName = name => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
const specs = {
  'mac-arm64': { folder: 'benchgo-macos-arm64', platform: 'darwin', arch: 'arm64', suffixes: ['mac-arm64.dmg', 'mac-arm64.zip'],
    verified: ['packaged-runtime', 'external-plugin-seed', 'enrollment-source-match', 'startup-brand'] },
  'mac-x64': { folder: 'benchgo-macos-x64', platform: 'darwin', arch: 'x64', suffixes: ['mac-x64.dmg', 'mac-x64.zip'],
    verified: ['packaged-runtime', 'external-plugin-seed', 'enrollment-source-match', 'startup-brand'] },
  'linux-server': { folder: 'benchgo-linux-server', platform: 'linux', arch: 'x64', suffixes: ['linux-server.tar.gz'],
    verified: ['server-seed-sha256', 'server-seed-safe-paths', 'linux-x64-native-worker', 'current-bootstrap', 'distribution-inventory', 'server-install-and-start'] },
};

export function validatePlatformReceipt(receipt, plan, target) {
  const spec = specs[target];
  if (!spec || receipt?.schemaVersion !== 1 || receipt.sourceSha !== plan.sourceSha || receipt.version !== plan.versions.windows
    || receipt.platform !== spec.platform || receipt.arch !== spec.arch) throw new Error(`Wrong ${target} build source or platform`);
  if (!Array.isArray(receipt.verified) || spec.verified.some(value => !receipt.verified.includes(value))) throw new Error(`Incomplete ${target} build verification`);
  if (spec.platform === 'darwin' && (receipt.signing !== 'ad-hoc' || receipt.notarized !== false)) throw new Error('macOS signing status must match the qualified build');
  if (!Array.isArray(receipt.files) || !receipt.files.length || new Set(receipt.files.map(row => row.name)).size !== receipt.files.length) throw new Error('Invalid platform inventory');
  const expected = spec.suffixes.map(suffix => `benchgo-${receipt.version}-${suffix}`);
  for (const row of receipt.files) if (!safeName(row.name) || !Number.isSafeInteger(row.size) || row.size < 1 || !/^[a-f0-9]{64}$/.test(row.sha256)
    || !expected.some(name => row.name === name || row.name === `${name}.blockmap` || row.name === `${name}.sha256`)) throw new Error('Unexpected platform artifact');
  for (const name of expected) if (!receipt.files.some(row => row.name === name)) throw new Error(`Missing platform payload: ${name}`);
  return { spec, expected };
}

export async function assembleDownloads({ plan, manifest, buildRoot, output, platforms = downloadPlatforms, privateKey }) {
  if (new Set(platforms).size !== platforms.length) throw new Error('Duplicate download platform');
  const files = [];
  for (const [target, artifact] of [['windows-x64', manifest.app], ['android', manifest.android], ['plugin', manifest.plugin]]) {
    if (artifact) files.push({ target, ...artifact });
  }
  for (const target of platforms) {
    const spec = specs[target];
    if (!spec) throw new Error('Unknown download platform');
    const directory = resolve(buildRoot, spec.folder);
    const receipt = JSON.parse(await readFile(resolve(directory, 'build-source.json'), 'utf8'));
    const { expected } = validatePlatformReceipt(receipt, plan, target);
    const names = (await readdir(directory)).filter(name => name !== 'build-source.json').sort();
    if (JSON.stringify(names) !== JSON.stringify(receipt.files.map(row => row.name).sort())) throw new Error(`Unaccounted ${target} artifact files`);
    for (const row of receipt.files) {
      const path = resolve(directory, row.name);
      if ((await stat(path)).size !== row.size || await fileDigest(path) !== row.sha256) throw new Error(`${target} checksum mismatch`);
      await cp(path, resolve(output, row.name));
      if (expected.includes(row.name)) files.push({ target, version: receipt.version, url: releaseDownloadUrl(row.name, plan.tag), size: row.size, sha256: row.sha256,
        ...(spec.platform === 'darwin' ? { signing: receipt.signing, notarized: false } : { kind: 'server', arch: 'x64', systems: ['Ubuntu', 'Debian'] }) });
    }
    await cp(resolve(directory, 'build-source.json'), resolve(output, `${target}-source.json`));
  }
  const catalog = { schemaVersion: 1, releaseVersion: plan.releaseVersion, sourceSha: plan.sourceSha, files };
  const raw = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);
  const signature = sign(null, raw, privateKey).toString('base64');
  await writeFile(resolve(output, 'downloads.json'), raw);
  await writeFile(resolve(output, 'downloads.json.sig'), `${signature}\n`);
  const sums = [];
  for (const name of (await readdir(output)).filter(name => name !== 'SHA256SUMS.txt' && name !== 'release-notes.md').sort()) {
    if (!safeName(name)) throw new Error('Unsafe release output name');
    sums.push(`${await fileDigest(resolve(output, name))}  ${name}`);
  }
  await writeFile(resolve(output, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
  return catalog;
}

export async function verifyDownloads({ directory, plan, publicKey }) {
  const raw = await readFile(resolve(directory, 'downloads.json'));
  const signature = await readFile(resolve(directory, 'downloads.json.sig'), 'utf8');
  if (!verify(null, raw, publicKey, Buffer.from(signature.trim(), 'base64'))) throw new Error('Invalid signed downloads catalog');
  const catalog = JSON.parse(raw);
  if (catalog.schemaVersion !== 1 || catalog.releaseVersion !== plan.releaseVersion || catalog.sourceSha !== plan.sourceSha || !Array.isArray(catalog.files)) throw new Error('Wrong downloads source');
  for (const target of ['windows-x64', 'android', 'plugin', ...downloadPlatforms]) if (!catalog.files.some(file => file.target === target)) throw new Error(`Missing download target: ${target}`);
  for (const file of catalog.files) {
    const url = new URL(file.url), name = url.pathname.split('/').at(-1);
    if (!safeName(name) || !file.url.startsWith('https://github.com/zhuogo/BenchGo/releases/download/v') || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid download descriptor');
    if (url.pathname.split('/').at(-2) === plan.tag && ((await stat(resolve(directory, name))).size !== file.size || await fileDigest(resolve(directory, name)) !== file.sha256)) throw new Error('Download catalog checksum mismatch');
  }
  return catalog;
}
