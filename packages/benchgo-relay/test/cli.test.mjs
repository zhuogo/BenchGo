import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, run } from '../src/cli.mjs';

test('parses relay config and root', () => {
  const value = parseArgs(['--config=/tmp/relay.json', '--root', '/tmp/benchgo', 'run']);
  assert.equal(value.options.config, '/tmp/relay.json');
  assert.equal(value.options.root, '/tmp/benchgo');
  assert.deepEqual(value.positionals, ['run']);
});

test('exposes relay help and version', async () => {
  assert.match(await run(['--help']), /benchgo-relay run/);
  assert.match(await run(['--version']), /^\d+\.\d+\.\d+$/);
});

test('requires a prepared relay config for local installation', async () => {
  await assert.rejects(() => run(['install', '--config', '/tmp/benchgo-missing-relay.json']), /ENOENT|不存在|no such file/i);
});
