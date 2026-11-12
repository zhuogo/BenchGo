import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { currentVersions } from './plan.mjs';

export async function fileDigest(path, algorithm = 'sha256') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(algorithm === 'sha512' ? 'base64' : 'hex');
}

export async function recordArtifact({ component, directory, releaseVersion, sourceSha, verified }) {
  if (!['plugin', 'windows', 'android'].includes(component)) throw new Error('Unknown release component');
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (actual !== sourceSha || process.env.GITHUB_SHA && sourceSha !== process.env.GITHUB_SHA) throw new Error('Artifact source SHA does not match this workflow');
  const versions = await currentVersions(), plugin = JSON.parse(await readFile('plugins/benchgo/package.json', 'utf8'));
  if (releaseVersion && plugin.benchgo?.releaseVersion !== releaseVersion) throw new Error('Plugin package is missing unified release staging');
  const names = (await readdir(directory)).filter(name => /(?:\.exe|\.blockmap|\.tar\.gz|\.apk|\.sha256|latest\.yml|build-source\.json)$/.test(name)).sort();
  const expected = component === 'plugin' ? `benchgo-${versions.plugin}-plugin.tar.gz` : component === 'windows'
    ? `benchgo-${versions.windows}-win-x64-setup.exe` : `benchgo-${versions.android}-android.apk`;
  if (!names.includes(expected)) throw new Error(`Missing ${component} payload: ${expected}`);
  if (!Array.isArray(verified) || !verified.length) throw new Error('Artifact verification receipt is required');
  const files = [];
  for (const name of names) {
    const path = resolve(directory, name), { size } = await (await import('node:fs/promises')).stat(path);
    files.push({ name, size, sha256: await fileDigest(path) });
  }
  const receipt = { schemaVersion: 1, component, sourceSha, releaseVersion: releaseVersion ?? null,
    version: versions[component], ...(component === 'android' ? { versionCode: versions.androidVersionCode } : {}),
    artifact: expected, verified, staged: releaseVersion ? [{ path: 'plugins/benchgo/package.json', field: 'benchgo.releaseVersion', value: releaseVersion }] : [], files };
  await writeFile(resolve(directory, 'component-source.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { component: { type: 'string' }, directory: { type: 'string' },
    'source-sha': { type: 'string' }, 'release-version': { type: 'string' }, verified: { type: 'string' } } });
  recordArtifact({ component: values.component, directory: values.directory, sourceSha: values['source-sha'],
    releaseVersion: values['release-version'] || undefined, verified: values.verified?.split(',') })
    .then(result => console.log(`${result.component}: verified ${basename(result.artifact)} from ${result.sourceSha}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
