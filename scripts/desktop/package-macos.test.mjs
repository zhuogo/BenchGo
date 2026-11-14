import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordMacArtifacts, resolveMacPackageTarget } from './package-macos.mjs';
import { createMacOSConfig } from './electron-builder.macos.config.mjs';

test('macOS packaging requires a real matching native runner', () => {
  for (const arch of ['arm64', 'x64']) assert.equal(resolveMacPackageTarget(arch, 'darwin', arch).name, `mac-${arch}`);
  assert.throws(() => resolveMacPackageTarget('arm64', 'win32', 'x64'), /native macOS/);
  assert.throws(() => resolveMacPackageTarget('arm64', 'darwin', 'x64'), /matching arm64/);
  assert.throws(() => resolveMacPackageTarget('x64', 'darwin', 'arm64'), /matching x64/);
  assert.throws(() => resolveMacPackageTarget('universal', 'darwin', 'arm64'), /Usage:/);
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
