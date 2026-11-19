import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { bash, requiresBash } from '../../plugins/link/test/platform.mjs';

const tar = createRequire(new URL('../../plugins/base/package.json', import.meta.url))('tar');
const script = fileURLToPath(new URL('../../install-server.sh', import.meta.url));
const shellPath = path => process.platform === 'win32' ? path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase()) : path;
const name = 'benchgo-0.1.4-linux-server';
const archive = name + '.tar.gz';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, { extraFile = false, corrupted = false, linked = false, failingInstaller = false, failedDownload = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-install-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, 'stage'), directory = join(stage, name), mocks = join(root, 'mocks'), home = join(root, 'home');
  await mkdir(directory, { recursive: true }); await mkdir(mocks); await mkdir(home);
  for (const file of ['bootstrap.sh', 'bootstrap.mjs', 'manifest.json', 'server-seed.tar.gz', 'SHA256SUMS.txt']) await writeFile(join(directory, file), 'fixture');
  await writeFile(join(directory, 'install.sh'), `#!/usr/bin/env bash\nprintf '%s' "$*" > "$HOME/executed"\n${failingInstaller ? "echo 'fixture installation failed' >&2; exit 1" : `printf '%s\\n' '{"token":"private-test-token","port":12345}'`}\n`);
  if (extraFile) await writeFile(join(directory, 'unexpected.sh'), 'untrusted');
  await tar.c({ file: join(root, archive), cwd: stage, gzip: true, portable: true, noMtime: true }, [name]);
  if (linked) {
    const original = gunzipSync(await readFile(join(root, archive))), chunks = [];
    for (let offset = 0; offset < original.length;) {
      const header = Buffer.from(original.subarray(offset, offset + 512));
      const size = parseInt(header.subarray(124, 136).toString().replaceAll('\0', '').trim() || '0', 8);
      const length = 512 + Math.ceil(size / 512) * 512;
      if (header.subarray(0, 100).toString().split('\0')[0].endsWith('/install.sh')) {
        header.write('00000000000\0', 124, 'ascii'); header[156] = '2'.charCodeAt(0);
        header.fill(0, 157, 257); header.write('bootstrap.sh', 157, 'ascii');
        header.fill(32, 148, 156);
        const checksum = header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0');
        header.write(checksum + '\0 ', 148, 'ascii'); chunks.push(header);
      } else chunks.push(original.subarray(offset, offset + length));
      offset += length;
    }
    await writeFile(join(root, archive), gzipSync(Buffer.concat(chunks)));
  }
  const bytes = await readFile(join(root, archive));
  await writeFile(join(root, archive + '.sha256'), `${corrupted ? '0'.repeat(64) : hash(bytes)}  ${archive}\n`);
  await writeFile(join(mocks, 'uname'), '#!/usr/bin/env bash\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n', { mode: 0o755 });
  await writeFile(join(mocks, 'curl'), '#!/usr/bin/env bash\nwhile [ "$#" -gt 0 ]; do case "$1" in https:*) url=$1;; -o) shift; out=$1;; esac; shift; done\nprintf "%s\\n" "$url" >> "$TEST_ROOT/downloads"\n' + (failedDownload ? 'exit 22\n' : 'cp "$TEST_ROOT/${url##*/}" "$out"\n'), { mode: 0o755 });
  const run = args => spawnSync(bash, ['--noprofile', '--norc', '-c', 'export PATH="$TEST_MOCK:$PATH"; export HOME="$TEST_HOME"; bash "$TEST_SCRIPT" "$@"', 'benchgo-test', ...args], {
    encoding: 'utf8', timeout: 20000, windowsHide: true,
    env: { ...process.env, BENCHGO_VERSION: '0.1.4', BENCHGO_RELEASE_VERSION: '0.1.5', TEST_ROOT: shellPath(root), TEST_MOCK: shellPath(mocks), TEST_HOME: shellPath(home), TEST_SCRIPT: shellPath(script) },
  });
  return { root, home, run };
}

test('script downloads exact release, reuses shared installer and keeps connection credentials private', requiresBash, async t => {
  const f = await fixture(t), result = f.run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '安装完成');
  assert.equal(await readFile(join(f.home, 'executed'), 'utf8'), 'github connect');
  const connection = await readFile(join(f.home, '.local/share/benchgo/server/connection.json'), 'utf8');
  assert.equal(JSON.parse(connection).token, 'private-test-token');
  assert(!result.stdout.includes('private-test-token')); assert(!result.stderr.includes('private-test-token'));
  const downloads = await readFile(join(f.root, 'downloads'), 'utf8');
  assert(downloads.includes('https://github.com/zhuogo/BenchGo/releases/download/v0.1.5/' + archive));
  assert(!downloads.includes('ghfast.top'));
});

test('mirror and update are explicit and passed unchanged to the common installer', requiresBash, async t => {
  const f = await fixture(t), result = f.run(['mirror', 'update']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(f.home, 'executed'), 'utf8'), 'mirror update');
  const downloads = (await readFile(join(f.root, 'downloads'), 'utf8')).trim().split('\n');
  assert.equal(downloads.length, 2);
  assert.equal(downloads[0], 'https://ghfast.top/https://github.com/zhuogo/BenchGo/releases/download/v0.1.5/' + archive);
  assert.equal(downloads[1], 'https://github.com/zhuogo/BenchGo/releases/download/v0.1.5/' + archive + '.sha256');
});

test('a local server archive runs the shared installer without contacting GitHub', requiresBash, async t => {
  const f = await fixture(t, { failedDownload: true });
  const result = f.run(['github', 'connect', shellPath(join(f.root, archive))]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(f.home, 'executed'), 'utf8'), 'github connect');
  await assert.rejects(readFile(join(f.root, 'downloads')), { code: 'ENOENT' });
});

for (const options of [{ corrupted: true }, { extraFile: true }, { linked: true }]) test(`unsafe resource never executes installer (${JSON.stringify(options)})`, requiresBash, async t => {
  const f = await fixture(t, options), result = f.run([]);
  assert.notEqual(result.status, 0);
  await assert.rejects(readFile(join(f.home, 'executed')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.home, '.local/share/benchgo/server/connection.json')), { code: 'ENOENT' });
});

test('failed mirror download fails without silently requesting GitHub', requiresBash, async t => {
  const f = await fixture(t, { failedDownload: true }), result = f.run(['mirror']);
  assert.notEqual(result.status, 0);
  const downloads = (await readFile(join(f.root, 'downloads'), 'utf8')).trim().split('\n');
  assert.equal(downloads.length, 1);
  assert(downloads[0].startsWith('https://ghfast.top/https://github.com/'));
  await assert.rejects(readFile(join(f.home, 'executed')), { code: 'ENOENT' });
});

test('failed install preserves previous private connection response', requiresBash, async t => {
  const f = await fixture(t, { failingInstaller: true });
  const directory = join(f.home, '.local/share/benchgo/server'); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'connection.json'), 'previous-response');
  const result = f.run([]);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(join(directory, 'connection.json'), 'utf8'), 'previous-response');
  assert(!result.stdout.includes('安装完成'));
});
