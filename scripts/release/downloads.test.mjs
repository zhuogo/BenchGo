import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleDownloads, validatePlatformReceipt, verifyDownloads } from './downloads.mjs';
import { sha256 } from './github.mjs';

const plan = { sourceSha: 'a'.repeat(40), releaseVersion: '0.1.2', tag: 'v0.1.2', versions: { windows: '0.1.2' } };
const mac = arch => ({ schemaVersion: 1, sourceSha: plan.sourceSha, version: '0.1.2', platform: 'darwin', arch,
  signing: 'ad-hoc', notarized: false, verified: ['packaged-runtime', 'external-plugin-seed', 'enrollment-source-match', 'startup-brand'],
  files: ['dmg', 'zip'].map(ext => ({ name: `benchgo-0.1.2-mac-${arch}.${ext}`, size: 4, sha256: sha256('test') })) });

test('platform provenance rejects wrong source, architecture, notarization claims and missing formats', () => {
  assert.equal(validatePlatformReceipt(mac('arm64'), plan, 'mac-arm64').expected.length, 2);
  for (const change of [{ sourceSha: 'b'.repeat(40) }, { arch: 'x64' }, { notarized: true }, { files: mac('arm64').files.slice(0, 1) }, { verified: [] }]) {
    assert.throws(() => validatePlatformReceipt({ ...mac('arm64'), ...change }, plan, 'mac-arm64'));
  }
});

test('Linux publication requires the completed native fresh-install and service smoke', () => {
  const receipt = { schemaVersion: 1, sourceSha: plan.sourceSha, version: '0.1.2', platform: 'linux', arch: 'x64',
    verified: ['server-seed-sha256', 'server-seed-safe-paths', 'linux-x64-native-worker', 'current-bootstrap', 'distribution-inventory'],
    files: [{ name: 'benchgo-0.1.2-linux-server.tar.gz', size: 4, sha256: sha256('test') }] };
  assert.throws(() => validatePlatformReceipt(receipt, plan, 'linux-server'), /Incomplete/);
  receipt.verified.push('server-install-and-start');
  assert.equal(validatePlatformReceipt(receipt, plan, 'linux-server').expected.length, 1);
});

test('complete catalog binds every platform to checked bytes and verifies its signature', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-downloads-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const buildRoot = join(directory, 'builds'), output = join(directory, 'out');
  await mkdir(output, { recursive: true });
  const keys = generateKeyPairSync('ed25519');
  for (const arch of ['arm64', 'x64']) {
    const folder = join(buildRoot, `benchgo-macos-${arch}`), receipt = mac(arch);
    await mkdir(folder, { recursive: true });
    for (const file of receipt.files) await writeFile(join(folder, file.name), 'test');
    await writeFile(join(folder, 'build-source.json'), JSON.stringify(receipt));
  }
  const linux = join(buildRoot, 'benchgo-linux-server'), name = 'benchgo-0.1.2-linux-server.tar.gz';
  await mkdir(linux, { recursive: true });
  await writeFile(join(linux, name), 'test');
  await writeFile(join(linux, 'build-source.json'), JSON.stringify({ schemaVersion: 1, sourceSha: plan.sourceSha, version: '0.1.2', platform: 'linux', arch: 'x64',
    verified: ['server-seed-sha256', 'server-seed-safe-paths', 'linux-x64-native-worker', 'current-bootstrap', 'distribution-inventory', 'server-install-and-start'], files: [{ name, size: 4, sha256: sha256('test') }] }));
  const manifest = {};
  for (const [key, suffix] of [['app', 'win-x64-setup.exe'], ['android', 'android.apk'], ['plugin', 'plugin.tar.gz']]) {
    const filename = `benchgo-0.1.2-${suffix}`;
    manifest[key] = { version: '0.1.2', url: `https://github.com/zhuogo/BenchGo/releases/download/v0.1.2/${filename}`, size: 4, sha256: sha256('test') };
    await writeFile(join(output, filename), 'test');
  }
  const catalog = await assembleDownloads({ plan, manifest, buildRoot, output, privateKey: keys.privateKey });
  assert.equal(catalog.files.length, 8);
  assert.deepEqual(await verifyDownloads({ directory: output, plan, publicKey: keys.publicKey }), catalog);
  assert.match(await readFile(join(output, 'SHA256SUMS.txt'), 'utf8'), /downloads.json.sig/);
  await writeFile(join(output, 'benchgo-0.1.2-mac-arm64.dmg'), 'evil');
  await assert.rejects(verifyDownloads({ directory: output, plan, publicKey: keys.publicKey }), /checksum/);
});
