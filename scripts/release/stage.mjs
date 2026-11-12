import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export async function stageRelease({ sourceSha, releaseVersion, cwd = process.cwd() }) {
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || actual !== sourceSha || process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sourceSha) throw new Error('Release staging requires the exact workflow source checkout');
  if (!releaseVersion) return { sourceSha, staged: [] };
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(releaseVersion)) throw new Error('Unified release version must be stable X.Y.Z');
  const file = resolve(cwd, 'plugins/benchgo/package.json');
  const pkg = JSON.parse(await readFile(file, 'utf8'));
  pkg.benchgo = { ...pkg.benchgo, releaseVersion };
  await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`);
  return { sourceSha, staged: [{ path: 'plugins/benchgo/package.json', field: 'benchgo.releaseVersion', value: releaseVersion }] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'source-sha': { type: 'string' }, 'release-version': { type: 'string' } } });
  stageRelease({ sourceSha: values['source-sha'], releaseVersion: values['release-version'] }).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
