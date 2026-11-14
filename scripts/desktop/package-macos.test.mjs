import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macSigningNodeOptions, recordMacArtifacts, resolveMacPackageTarget, validateMacFileLimit } from './package-macos.mjs';
import { createMacOSConfig } from './electron-builder.macos.config.mjs';
import { dmgVendor, renderDmgWrapper } from './macos-dmg-tool.mjs';

test('macOS packaging requires a real matching native runner', () => {
  for (const arch of ['arm64', 'x64']) assert.equal(resolveMacPackageTarget(arch, 'darwin', arch).name, `mac-${arch}`);
  assert.throws(() => resolveMacPackageTarget('arm64', 'win32', 'x64'), /native macOS/);
  assert.throws(() => resolveMacPackageTarget('arm64', 'darwin', 'x64'), /matching arm64/);
  assert.throws(() => resolveMacPackageTarget('x64', 'darwin', 'arm64'), /matching x64/);
  assert.throws(() => resolveMacPackageTarget('universal', 'darwin', 'arm64'), /Usage:/);
});

test('descriptor capacity fails before a full build and the preload preserves Node options', () => {
  for (const value of ['256', '65535', '', 'unknown']) assert.throws(() => validateMacFileLimit(value), /ulimit -n >= 65536/);
  for (const value of ['65536', '262144', 'unlimited']) assert.equal(validateMacFileLimit(value), value);
  assert.match(macSigningNodeOptions('--max-old-space-size=6144'), /^--max-old-space-size=6144 --import=file:.*macos-signing-fs\.mjs$/);
});

test('DMG adapter uses the pinned official vendor and bounded clean-detach retries', async () => {
  const desktopRequire = createRequire(new URL('../../deepseek-harness/apps/desktop/package.json', import.meta.url));
  const builderRequire = createRequire(desktopRequire.resolve('app-builder-lib'));
  const source = await readFile(builderRequire.resolve('dmg-builder/out/dmgUtil.js'), 'utf8');
  assert.ok(source.includes('CUSTOM_DMGBUILD_PATH'));
  assert.ok(source.includes(dmgVendor.releaseName));
  for (const [name, checksum] of Object.entries(dmgVendor.checksums)) { assert.ok(source.includes(name)); assert.ok(source.includes(checksum)); }
  assert.equal(renderDmgWrapper('/official/tool path/dmgbuild'), '#!/bin/sh\nexec \'/official/tool path/dmgbuild\' --detach-retries 10 "$@"\n');
  assert.ok(renderDmgWrapper("/official/it's/dmgbuild").includes("'\"'\"'"));
  assert.doesNotMatch(renderDmgWrapper('/official/dmgbuild'), /-force|\/Volumes|\bkill\b/);
  assert.throws(() => renderDmgWrapper('/bad\npath'), /Invalid/);
});

test('signing preload survives actual osx-sign traversal under simulated descriptor exhaustion without skipping binaries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-signing-descriptors-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (let index = 0; index < 96; index++) await writeFile(join(directory, `file-${index}${index % 12 === 0 ? '.node' : '.js'}`), index % 12 === 0 ? Buffer.from([0, 0, 0, 0, 1, 2, 3, 4]) : 'export const text = true;');
  // Make the real scanner's fs.open encounter EMFILE at eight simultaneous
  // descriptors. The production preload must recover rather than omit a path.
  const limitedFs = `import fs from 'node:fs';
    const open = fs.open, close = fs.close; let active = 0;
    fs.open = (...args) => { const callback = args.pop();
      if (active >= 8) { process.nextTick(() => callback(Object.assign(new Error('EMFILE simulation'), { code: 'EMFILE' }))); return; }
      active++; open(...args, (error, descriptor) => { if (error) active--; callback(error, descriptor); }); };
    fs.close = (descriptor, callback) => close(descriptor, error => { if (!error) active--; callback(error); });`;
  const desktopRequire = createRequire(new URL('../../deepseek-harness/apps/desktop/package.json', import.meta.url));
  const builderRequire = createRequire(desktopRequire.resolve('app-builder-lib'));
  const scanner = builderRequire.resolve('@electron/osx-sign/dist/cjs/util.js');
  const script = `const { walkAsync } = require(${JSON.stringify(scanner)}); walkAsync(${JSON.stringify(directory)}).then(paths => { console.log(JSON.stringify(paths.map(path => require('node:path').basename(path)).sort())); }).catch(error => { console.error(error.code || error.message); process.exitCode = 1; });`;
  const mock = `data:text/javascript,${encodeURIComponent(limitedFs)}`;
  const plain = spawnSync(process.execPath, ['--import', mock, '-e', script], { encoding: 'utf8', timeout: 15_000 });
  assert.notEqual(plain.status, 0);
  assert.match(plain.stderr, /EMFILE/);
  // Mirror pnpm exec launching another Node process: NODE_OPTIONS must carry
  // both the simulated limit and production preload into the actual scanner.
  const driver = `const child = require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(script)}], { stdio: 'inherit', env: process.env }); process.exitCode = child.status ?? 1;`;
  const queued = spawnSync(process.execPath, ['-e', driver], { encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, NODE_OPTIONS: macSigningNodeOptions(`${process.env.NODE_OPTIONS ?? ''} --import=${mock}`) } });
  assert.equal(queued.status, 0, queued.stderr);
  const paths = JSON.parse(queued.stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(paths, Array.from({ length: 8 }, (_, index) => `file-${index * 12}.node`).sort());
});

test('macOS outputs keep target architecture, BenchGo identity and honest signing metadata', async () => {
  const version = JSON.parse(await readFile(new URL('../../package.json', import.meta.url))).version;
  for (const arch of ['arm64', 'x64']) {
    const config = createMacOSConfig(arch);
    assert.equal(config.appId, 'cn.draftgo.benchgo');
    assert.equal(config.productName, 'BenchGo');
    assert.equal(config.extraMetadata.version, version);
    assert.equal(config.artifactName, `benchgo-${version}-mac-${arch}.\${ext}`);
    assert.ok(config.directories.output.endsWith(join('artifacts', `macos-${arch}`)));
    assert.equal(config.mac.identity, '-');
    assert.equal(config.mac.forceCodeSigning, false);
    assert.equal(config.mac.notarize, false);
    assert.equal(config.dmg.sign, false);
    assert.deepEqual(config.mac.target, ['dmg', 'zip']);
    assert.equal(config.publish, null);
    assert.match(config.electronDist, new RegExp(`mac-${arch}[\\\\/]electron$`));
    assert.ok(config.extraResources.some(item => item.to === 'benchgo/seed/node_modules' && item.from.endsWith(join(`mac-${arch}`, 'plus-seed/node_modules'))));
    assert.ok(config.files.some(item => typeof item === 'object' && item.to === 'renderer'));
    assert.equal(typeof config.afterPack, 'function');
  }
});

test('macOS receipt binds both real artifact formats to source and discloses missing notarization', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-mac-artifacts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identity = { version: '1.2.3', arch: 'arm64', sourceSha: 'a'.repeat(40) };
  await assert.rejects(recordMacArtifacts(directory, identity), /Missing macOS artifact/);
  for (const extension of ['dmg', 'zip']) await writeFile(join(directory, `benchgo-1.2.3-mac-arm64.${extension}`), 'fixture');
  const receipt = await recordMacArtifacts(directory, identity);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'build-source.json'), 'utf8')), receipt);
  assert.equal(receipt.sourceSha, identity.sourceSha);
  assert.equal(receipt.signing, 'ad-hoc');
  assert.equal(receipt.notarized, false);
  assert.equal(receipt.files.length, 2);
  for (const file of receipt.files) { assert.equal(file.size, 7); assert.match(file.sha256, /^[a-f0-9]{64}$/); }
});

test('macOS packaging reuses official preparation and verifies the external seed', async () => {
  const source = await readFile(new URL('./package-macos.mjs', import.meta.url), 'utf8');
  assert.match(source, /\['runtime', 'packages', 'dsh'\]/);
  assert.match(source, /release:pack/);
  assert.match(source, /plugin-bundle\.mjs/);
  assert.match(source, /seal-runtime\.mjs/);
  assert.match(source, /--publish', 'never'/);
});
