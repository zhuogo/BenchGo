import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseArgs, run } from '../src/cli.mjs';

test('parses relay config and root', () => {
  const value = parseArgs(['--config=/tmp/relay.json', '--root', '/tmp/benchgo', 'run']);
  assert.equal(value.options.config, '/tmp/relay.json');
  assert.equal(value.options.root, '/tmp/benchgo');
  assert.deepEqual(value.positionals, ['run']);
});

test('exposes relay help and version', async () => {
  assert.match(await run(['--help']), /benchgo-relay run/);
  const { version, dependencies } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(version, '0.1.1');
  assert.equal(await run(['--version']), version);
  assert.match(await run(['--help']), /^BenchGo relay 0\.1\.1\b/);
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
  assert.equal(dependencies.ws, '8.19.0');
  assert.equal(lock.packages[''].dependencies.ws, dependencies.ws);
  assert.equal(lock.packages['node_modules/ws'].version, dependencies.ws);
  const script = await readFile(new URL('../../../install-relay.sh', import.meta.url), 'utf8');
  assert.ok(script.includes('version=${BENCHGO_VERSION:-' + version + '}'));
});

test('requires a prepared relay config for local installation', async () => {
  const expected = process.platform === 'linux'
    ? /ENOENT|不存在|no such file/i
    : /中继服务安装当前仅支持 Linux/;
  await assert.rejects(() => run(['install', '--config', '/tmp/benchgo-missing-relay.json']), expected);
});
