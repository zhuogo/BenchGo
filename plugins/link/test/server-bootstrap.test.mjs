import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { bash, requiresBash } from './platform.mjs';
import { openStore } from '../src/pairing/store.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
test('bootstrap rejects a modified payload before creating an installation or running commands', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bootstrap-integrity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(root, 'scripts/server/bootstrap.mjs'), join(directory, 'bootstrap.mjs'));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, harnessVersion: '0.2.1-alpha.3', pluginVersion: '0.1.5', sha256: '0'.repeat(64) }));
  await writeFile(join(directory, 'server-seed.tar.gz'), 'modified');
  const result = spawnSync(process.execPath, [join(directory, 'bootstrap.mjs'), 'mirror', 'connect'], { env: { ...process.env, HOME: join(directory, 'home') }, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /插件包校验失败/); assert.equal(result.stdout, '');
});
test('installer fails closed for unsupported source and never accepts command-shaped parameters', requiresBash, async () => {
  const source = (await readFile(join(root, 'scripts/server/bootstrap.sh'), 'utf8')).replace(/\r\n/g, '\n');
  const result = spawnSync(bash, ['-s', '--', 'mirror;touch /tmp/not-allowed', 'connect'], { input: source, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /无效下载源/);
});

test('server installer rejects ARM64 and other unsupported CPUs before systemd or Node downloads', requiresBash, async () => {
  const source = (await readFile(join(root, 'scripts/server/bootstrap.sh'), 'utf8')).replace(/\r\n/g, '\n');
  for (const architecture of ['aarch64', 'arm64', 'riscv64']) {
    const input = `uname() { if [ "$1" = -s ]; then printf 'Linux\\n'; else printf '${architecture}\\n'; fi; }\n`
      + "curl() { echo unexpected-download >&2; return 99; }\nsystemctl() { echo unexpected-service >&2; return 99; }\n" + source;
    const result = spawnSync(bash, ['-s', '--', 'github', 'connect'], { input, encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
    assert.match(result.stderr, /当前服务器包仅支持 Linux x64，暂不支持 ARM64/);
    assert(!result.stderr.includes('unexpected-'));
  }
});

async function serverLinkInitializer(allocatePort) {
  const source = await readFile(join(root, 'scripts/server/bootstrap.mjs'), 'utf8');
  const start = source.indexOf('async function initializeServerLink('), end = source.indexOf('\nasync function ownerAdmin(', start);
  assert(start >= 0 && end > start);
  return new Function('mkdir', 'readFile', 'writeFile', 'join', 'freePort', `return (${source.slice(start, end)});`)(mkdir, readFile, writeFile, join, allocatePort);
}

test('server first start seeds the real persistent Link store as enabled loopback on its assigned port', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-server-link-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const initialize = await serverLinkInitializer(async () => 52341);
  assert.equal(await initialize(directory), 52341);
  const value = JSON.parse(await readFile(join(directory, 'devices.json'), 'utf8'));
  assert.deepEqual(value, { enabled: true, host: '127.0.0.1', port: 52341, publicUrl: '', devices: [] });
  const store = await openStore(directory);
  assert.equal(store.state.enabled, true); assert.equal(store.state.host, '127.0.0.1'); assert.equal(store.state.port, 52341);
  const source = await readFile(join(root, 'scripts/server/bootstrap.mjs'), 'utf8');
  assert(source.indexOf('await initializeServerLink(') < source.indexOf('await helper.activateRelease('));
  assert(!source.includes("action: 'configure'"), 'authorization never silently reconfigures a persistent listener');
});

test('server bootstrap reuses a valid initial listener after interruption without rewriting device credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-server-link-existing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'devices.json');
  const bytes = JSON.stringify({ enabled: true, host: '127.0.0.1', port: 52342, publicUrl: '', name: 'Existing server', devices: [{ id: 'kept', tokenHash: 'kept-hash' }], relayPool: [{ id: 'keep' }] }, null, 2) + '\n';
  await writeFile(file, bytes);
  const initialize = await serverLinkInitializer(async () => { throw new Error('Existing listener must retain its port'); });
  assert.equal(await initialize(directory), 52342); assert.equal(await readFile(file, 'utf8'), bytes);
});

test('server bootstrap refuses incompatible or corrupt saved listeners while preserving their bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-server-link-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'devices.json'), initialize = await serverLinkInitializer(async () => 52343);
  for (const bytes of [JSON.stringify({ enabled: true, host: '0.0.0.0', port: 48721, devices: [{ id: 'kept' }] }),
    JSON.stringify({ enabled: false, host: '127.0.0.1', port: 52344 }), JSON.stringify({ enabled: true, host: '127.0.0.1', port: 65536 }), '{invalid-json']) {
    await writeFile(file, bytes); await assert.rejects(initialize(directory), /原文件已保留/); assert.equal(await readFile(file, 'utf8'), bytes);
  }
});
test('generated launcher is valid JavaScript and redacts split token chunks before journald', async t => {
  const source = await readFile(join(root, 'scripts/server/bootstrap.mjs'), 'utf8');
  const functionText = source.slice(source.indexOf('function launchServer('));
  const directory = await mkdtemp(join(tmpdir(), 'dsh-launcher-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fake = join(directory, 'runtime/node_modules/@deepseek-ai/dsh/lib'); await mkdir(fake, { recursive: true });
  await writeFile(join(fake, 'bin.js'), "process.stdout.write('dsh web: http://127.0.0.1:3456/?tok');setTimeout(()=>{process.stdout.write('en=sensitive-server-secret\\n');process.exit(0)},20)");
  const launcher = join(directory, 'start.mjs'), owner = join(directory, 'owner.json');
  const args = [process.execPath, join(directory, 'runtime'), owner, directory, 3456].map(JSON.stringify).join(',');
  await writeFile(launcher, '(' + functionText + ')(' + args + ');');
  const result = spawnSync(process.execPath, [launcher], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert(!result.stdout.includes('sensitive-server-secret')); assert.match(result.stdout, /redacted/);
  assert.equal(JSON.parse(await readFile(owner, 'utf8')).url, 'http://127.0.0.1:3456/?token=sensitive-server-secret');
});
