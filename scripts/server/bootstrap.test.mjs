import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { recoverAssistantGuard, waitForUpdatedService } from './bootstrap.mjs';

test('an update can become ready after the former 50 second cutoff', async () => {
  let elapsed = 0;
  let probes = 0;
  await waitForUpdatedService(12345, async () => {
    probes++;
    if (elapsed < 50000) throw new Error('owner endpoint has not started');
    return { enabled: true, port: elapsed < 51000 ? 9999 : 12345, host: '127.0.0.1' };
  }, async delay => { elapsed += delay; });
  assert.equal(elapsed, 51000);
  assert.equal(probes, 103);
});

test('the update timeout explains that the service may still be starting', async () => {
  let elapsed = 0;
  await assert.rejects(waitForUpdatedService(12345, async () => null, async delay => { elapsed += delay; }),
    /服务可能仍在启动/);
  assert.equal(elapsed, 180000);
});

test('an update waits for the workbench after the Link listener accepts requests', async () => {
  let probes = 0, elapsed = 0;
  await waitForUpdatedService(12345, async () => ({ enabled: true, port: 12345, host: '127.0.0.1' }),
    async delay => { elapsed += delay; }, async () => {
      if (++probes < 3) throw new Error('服务器总助手尚未就绪');
    });
  assert.equal(probes, 3);
  assert.equal(elapsed, 1000);
});

test('managed startup archives an old empty writer guard and preserves live ownership and nonempty guards', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-guard-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const assistant = join(directory, 'assistant');
  await mkdir(assistant);
  const guard = join(assistant, 'owner-guard.lock');
  const owner = join(assistant, 'owner.lock');
  await writeFile(guard, '');
  const metadata = await stat(guard);
  const options = { uid: metadata.uid, now: () => metadata.mtimeMs + 10_000 };
  const record = JSON.stringify({ host: hostname(), pid: process.pid, token: 'current' });
  await writeFile(owner, record);
  assert.equal(await recoverAssistantGuard(directory, options), false);
  assert.equal(await readFile(guard, 'utf8'), '');
  assert.equal(await readFile(owner, 'utf8'), record);

  await rm(owner);
  assert.equal(await recoverAssistantGuard(directory, options), true);
  await assert.rejects(readFile(guard), { code: 'ENOENT' });
  const archived = (await readdir(assistant)).find(name => name.startsWith('owner-guard.lock.recovery-'));
  assert.equal(await readFile(join(assistant, archived), 'utf8'), '');

  await writeFile(guard, `${process.pid}\n`);
  assert.equal(await recoverAssistantGuard(directory, options), false);
  assert.equal(await readFile(guard, 'utf8'), `${process.pid}\n`);
});

const script = fileURLToPath(new URL('./bootstrap.sh', import.meta.url));
const bash = process.platform === 'win32' ? ['C:/Program Files/Git/bin/bash.exe'].find(existsSync) : '/bin/bash';
const mocks = `
export PATH="$PWD/bin:$PATH"
log() { printf '%s\\n' "$*" >> "$PWD/commands"; }
uname() { if [ "$1" = -s ]; then printf Linux; else printf '%s' "\${TEST_ARCH:-x86_64}"; fi; }
getconf() { printf '%s' "\${TEST_LIBC:-glibc 2.34}"; }
id() { printf '%s' "\${TEST_UID:-1000}"; }
systemctl() {
  log systemctl "$@"
  if [ "$1" = --system ]; then [ "\${TEST_SYSTEMD:-yes}" = yes ]; return; fi
  if [ "$1" = --user ]; then [ "\${TEST_READY:-yes}" = yes ] || [ -f "$PWD/prepared" ]; return; fi
  if [ "$1" = start ]; then : > "$PWD/prepared"; return; fi
  return 1
}
loginctl() { log loginctl "$@"; if [ "$1" = show-user ]; then printf '%s' "\${TEST_LINGER:-yes}"; fi; }
sudo() {
  log sudo "$@"
  [ "\${TEST_SUDO:-no}" = yes ] || return 1
  if [ "$2" = -l ]; then return 0; fi
  shift; "$@"
}
curl() { log curl "$@"; return 99; }
npm() { return 0; }
command() {
  if [ "$1" = -v ] && [ "$2" = "\${TEST_MISSING:-none}" ]; then return 1; fi
  builtin command "$@"
}
dnf() { return 99; }
. "$1" github "$2"
`;

async function run(t, env = {}, operation = 'check') {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-bootstrap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'bin'));
  await writeFile(join(directory, 'bin/node'), '#!/bin/bash\nif [ "$1" != -e ]; then printf "node %s\\n" "$*" >> "$PWD/commands"; printf \'{"installed":true}\\n\'; fi\n');
  await chmod(join(directory, 'bin/node'), 0o755);
  const result = spawnSync(bash, ['--noprofile', '--norc', '-c', mocks, '--', script.replaceAll('\\', '/'), operation], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 10000,
  });
  assert.ifError(result.error);
  return { ...result, commands: await readFile(join(directory, 'commands'), 'utf8').catch(() => '') };
}

test('CentOS 9 compatible glibc is accepted without a distribution whitelist or mutations', { skip: !bash }, async t => {
  const result = await run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { platform: 'linux', arch: 'x64', service: 'ready' });
  assert.doesNotMatch(result.commands, /curl|enable-linger|systemctl start|node /);
});

for (const libc of ['glibc 2.27', 'musl 1.2.5', '']) test(`unsupported libc fails before installing (${libc || 'unknown'})`, { skip: !bash }, async t => {
  const result = await run(t, { TEST_LIBC: libc || 'unknown' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /glibc 2.28/);
  assert.equal(result.commands, '');
});

test('ARM architecture is rejected before installing', { skip: !bash }, async t => {
  const result = await run(t, { TEST_ARCH: 'aarch64' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /ARM64/); assert.equal(result.commands, '');
});

test('missing extraction utility produces a package-manager action', { skip: !bash }, async t => {
  const result = await run(t, { TEST_MISSING: 'xz' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /缺少命令：xz/); assert.match(result.stderr, /dnf install/);
  assert.equal(result.commands, '');
});

test('check reports root service preparation without changing systemd', { skip: !bash }, async t => {
  const result = await run(t, { TEST_UID: '0', TEST_READY: 'no', TEST_LINGER: 'no' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).service, 'prepare');
  assert.doesNotMatch(result.commands, /enable-linger|systemctl start|node /);
});

test('a container without a system manager is rejected during check', { skip: !bash }, async t => {
  const result = await run(t, { TEST_UID: '0', TEST_SYSTEMD: 'no', TEST_READY: 'no' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /systemd 未运行/);
  assert.doesNotMatch(result.commands, /enable-linger|systemctl start|node |curl/);
});

test('installation prepares the root user service and reuses compatible Node', { skip: !bash }, async t => {
  const result = await run(t, { TEST_UID: '0', TEST_READY: 'no', TEST_LINGER: 'no' }, 'connect');
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).installed, true);
  assert.match(result.commands, /loginctl enable-linger 0\nsystemctl start user@0.service/);
  assert.doesNotMatch(result.commands, /curl/);
});

test('an unprivileged missing user service gives an action without installing', { skip: !bash }, async t => {
  const result = await run(t, { TEST_READY: 'no', TEST_LINGER: 'no' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /loginctl enable-linger 1000 && systemctl start user@1000.service/);
  assert.doesNotMatch(result.commands, /^loginctl enable-linger|^systemctl start|^node |^curl/m);
});

test('authorized noninteractive sudo prepares only the current user service', { skip: !bash }, async t => {
  const result = await run(t, { TEST_READY: 'no', TEST_LINGER: 'no', TEST_SUDO: 'yes' }, 'connect');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.commands, /sudo -n loginctl enable-linger 1000/);
  assert.match(result.commands, /sudo -n systemctl start user@1000.service/);
  assert.doesNotMatch(result.commands, /curl/);
});
