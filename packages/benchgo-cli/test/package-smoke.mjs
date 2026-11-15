/** Verify the actual npm archive and command from an isolated global prefix. */
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as tar from 'tar';

if (!process.argv[2]) throw new Error('Provide the packed CLI tgz');
const temporary = await mkdtemp(join(tmpdir(), 'benchgo-cli-package-'));
try {
  const npm = process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath) ? process.env.npm_execpath
    : join(dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
  const installed = spawnSync(process.execPath, [npm, 'install', '--global', '--prefix', temporary, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', resolve(process.argv[2])],
    { cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.equal(installed.status, 0, installed.stderr || installed.error?.message);
  const root = join(temporary, process.platform === 'win32' ? 'node_modules/benchgo' : 'lib/node_modules/benchgo');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const command = join(temporary, process.platform === 'win32' ? 'benchgo.cmd' : 'bin/benchgo');
  if (process.platform === 'win32') {
    for (const suffix of ['', '.cmd', '.ps1']) assert.ok((await lstat(join(temporary, `benchgo${suffix}`))).isFile());
  } else assert.ok((await lstat(command)).isSymbolicLink());
  const commandResult = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `& '${command.replace(/'/g, "''")}' --version`], { cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 15_000 })
    : spawnSync(command, ['--version'], { cwd: temporary, encoding: 'utf8', timeout: 15_000 });
  assert.equal(commandResult.status, 0, commandResult.stderr || commandResult.error?.message);
  assert.equal(commandResult.stdout.trim(), manifest.version);
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
    repoFallback: false, legacyServerSeed: false, globalPrefix: true, commandShim: true, license: 'MIT', success: true }));
} finally { await rm(temporary, { recursive: true, force: true }); }
