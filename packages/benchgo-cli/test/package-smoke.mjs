/** Verify the actual npm archive without repository source fallbacks or a global installation. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as tar from 'tar';

if (!process.argv[2]) throw new Error('Provide the packed CLI tgz');
const temporary = await mkdtemp(join(tmpdir(), 'benchgo-cli-package-'));
try {
  await tar.x({ file: resolve(process.argv[2]), cwd: temporary, strict: true });
  const root = join(temporary, 'package');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const run = args => {
    const result = spawnSync(process.execPath, [join(root, 'bin/benchgo.mjs'), ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  assert.equal(run(['--version']), manifest.version);
  assert.match(run(['--help']), /benchgo install/);
  const api = await import(pathToFileURL(join(root, 'src/artifacts.mjs')).href);
  const metadata = await api.loadInstallMetadata(); assert.ok(metadata.engineVersion);
  const { sharedDirectory } = await import(pathToFileURL(join(root, 'src/shared.mjs')).href);
  assert.equal(resolve(sharedDirectory), join(root, 'resources/shared'));
  assert.match(await readFile(join(root, 'resources/LICENSE'), 'utf8'), /MIT License/);
  const files = [];
  await tar.t({ file: resolve(process.argv[2]), onReadEntry: entry => files.push(entry.path) });
  assert.ok(files.includes('package/resources/server/resources.json'));
  assert.ok(!files.some(file => /server-seed\.tar\.gz$|bootstrap\.(?:sh|mjs)$/.test(file)));
  console.log(JSON.stringify({ package: manifest.name, version: manifest.version, metadata, files: files.length,
    repoFallback: false, legacyServerSeed: false, license: 'MIT', success: true }));
} finally { await rm(temporary, { recursive: true, force: true }); }
