import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { desktopTargetBuildPaths, resolveDesktopBuildTarget } from '../../deepseek-harness/apps/desktop/scripts/desktop-build-paths.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const sourceHelper = join(repository, 'scripts/desktop/install-cleanup.mjs');
const id = number => `{00000000-0000-0000-0000-${String(number).padStart(12, '0')}}`;

test('real Electron removes physical ASAR files without changing archive access or cleanup safety', { timeout: 60_000 }, async t => {
  const packaged = process.env.BENCHGO_TEST_PACKAGED_ROOT;
  const electron = packaged ? join(resolve(packaged), 'BenchGo.exe') : join(
    desktopTargetBuildPaths(resolveDesktopBuildTarget()).electron,
    process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron.exe',
  );
  const helper = packaged ? join(resolve(packaged), 'resources/benchgo/install-cleanup.mjs') : sourceHelper;
  assert.ok(existsSync(electron), `Prepare the actual Electron runtime before this test: ${electron}`);
  assert.deepEqual(await readFile(helper), await readFile(sourceHelper), 'the packaged cleanup helper must match the current source');
  const require = createRequire(join(repository, 'deepseek-harness/apps/desktop/package.json'));
  const { createPackage } = createRequire(require.resolve('app-builder-lib'))('@electron/asar');
  const base = await realpath(tmpdir());
  const directory = await realpath(await mkdtemp(join(base, 'benchgo-cleanup-electron-')));
  const inside = relative(base, directory);
  assert.ok(inside && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const current = join(directory, 'BenchGo');
  const resources = join(current, 'resources');
  const profile = join(directory, 'home/profiles/desktop');
  const outside = join(directory, 'outside');
  const archiveSource = join(directory, 'archive-source');
  const retired = [1, 2, 3, 4, 5].map(number => `${current}.old-${id(number)}`);
  await Promise.all([resources, profile, outside, join(archiveSource, 'dsh')].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(archiveSource, 'dsh/desktop-runtime.json'), '{"fixture":true}\n');
  await createPackage(archiveSource, join(resources, 'app.asar'));
  await writeFile(join(current, 'BenchGo.exe'), 'preserve current executable');
  await writeFile(join(profile, 'config.json'), '{"preserve":"profile"}\n');
  await writeFile(join(outside, 'keep.txt'), 'preserve link target');
  for (const index of [0, 1, 2, 4]) {
    await mkdir(join(retired[index], 'resources'), { recursive: true });
    await writeFile(join(retired[index], 'BenchGo.exe'), 'retired executable');
  }
  for (const index of [1, 2, 4]) await copyFile(join(resources, 'app.asar'), join(retired[index], 'resources/app.asar'));
  await mkdir(join(retired[1], 'resources/app.asar.unpacked/dsh'), { recursive: true });
  await writeFile(join(retired[1], 'resources/app.asar.unpacked/dsh/native.dat'), 'physical unpacked file');
  await symlink(outside, join(retired[1], 'linked'), 'junction');
  await symlink(outside, retired[3], 'junction');
  const childScript = join(directory, 'verify.mjs');
  await writeFile(childScript, `
import assert from 'node:assert/strict';
import * as patched from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const disk = createRequire(import.meta.url)('original-fs').promises;
const [helperUrl, current, resources, profile, outside, ...retired] = process.argv.slice(2);
const beforeNoAsar = Object.getOwnPropertyDescriptor(process, 'noAsar');
const archive = join(resources, 'app.asar');
assert.equal((await patched.lstat(archive)).isDirectory(), true, 'the real Electron ASAR patch must be active');
assert.equal((await disk.lstat(archive)).isFile(), true);
const files = [join(current, 'BenchGo.exe'), archive, join(profile, 'config.json'), join(outside, 'keep.txt')];
const before = await Promise.all(files.map(path => disk.readFile(path)));
const { queueRetiredInstall, cleanupRetiredInstalls } = await import(helperUrl);
for (const retiredDirectory of retired.slice(0, 2)) await queueRetiredInstall({ resources, retiredDirectory });
const results = await cleanupRetiredInstalls({ resources });
assert.deepEqual(results.map(row => row.status), ['removed', 'removed'], JSON.stringify(results));
for (const row of results) {
  for (const path of [row.receipt, row.retiredDirectory]) await assert.rejects(disk.lstat(path), { code: 'ENOENT' });
}
await queueRetiredInstall({ resources, retiredDirectory: retired[2] });
await disk.writeFile(retired[2] + '.benchgo-cleanup.json', JSON.stringify({ schemaVersion: 2, installRoot: current, retiredDirectory: retired[2] }));
await assert.rejects(queueRetiredInstall({ resources, retiredDirectory: retired[3] }), /links are not allowed/);
await disk.writeFile(retired[3] + '.benchgo-cleanup.json', JSON.stringify({ schemaVersion: 1, installRoot: current, retiredDirectory: retired[3] }));
const rejected = await cleanupRetiredInstalls({ resources });
assert.deepEqual(rejected.map(row => row.status), ['failed', 'failed']);
assert.match(rejected[0].error, /receipt does not match/);
assert.match(rejected[1].error, /links are not allowed/);
assert.equal((await disk.lstat(join(retired[2], 'resources/app.asar'))).isFile(), true);
assert.equal((await disk.lstat(retired[3])).isSymbolicLink(), true);
assert.equal((await disk.lstat(join(retired[4], 'resources/app.asar'))).isFile(), true, 'an orphan ASAR tree is not authorized for deletion');
for (const index of [2, 3]) assert.equal((await disk.lstat(retired[index] + '.benchgo-cleanup.json')).isFile(), true);
assert.deepEqual(await Promise.all(files.map(path => disk.readFile(path))), before, 'current executable, archive, profile and junction target must stay unchanged');
assert.deepEqual(Object.getOwnPropertyDescriptor(process, 'noAsar'), beforeNoAsar, 'cleanup must not change the global ASAR switch');
assert.equal((await patched.lstat(archive)).isDirectory(), true, 'archive virtualization stays available after cleanup');
assert.deepEqual(JSON.parse(await patched.readFile(join(archive, 'dsh/desktop-runtime.json'), 'utf8')), { fixture: true });
console.log(JSON.stringify({ electron: process.versions.electron, removed: results.length, rejected: rejected.length, physicalAsarRemoved: true, currentAndProfilePreserved: true, junctionTargetPreserved: true, orphanPreserved: true, globalAsarUnchanged: true }));
`);
  const ran = await new Promise((resolveResult, reject) => {
    execFile(electron, ['--expose-internals', childScript, pathToFileURL(helper).href, current, resources, profile, outside, ...retired], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => error ? reject(new Error(`Real Electron cleanup failed:\n${stdout}\n${stderr}`, { cause: error })) : resolveResult({ stdout, stderr }));
  });
  const report = JSON.parse(ran.stdout);
  assert.equal(report.removed, 2);
  assert.equal(report.rejected, 2);
  t.diagnostic(JSON.stringify({ ...report, packagedHelperVerified: !!packaged }));
});
