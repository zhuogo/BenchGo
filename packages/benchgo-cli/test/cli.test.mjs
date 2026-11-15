import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseArgs, run } from '../src/cli.mjs';

test('parses global CLI options without changing command arguments', () => {
  const parsed = parseArgs(['--json', '--source', 'github', 'server', 'install']);
  assert.equal(parsed.options.json, true);
  assert.equal(parsed.options.source, 'github');
  assert.deepEqual(parsed.positionals, ['server', 'install']);
});

test('reports the workbench help entry', async () => {
  const value = await run(['--help']);
  assert.match(value, /benchgo install/);
  assert.match(value, /benchgo server/);
  assert.doesNotMatch(value, /benchgo relay/);
});

test('returns the CLI version without requiring a service', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, '0.1.1');
  assert.equal(await run(['--version']), manifest.version);
  assert.match(await run(['--help']), /^BenchGo CLI 0\.1\.1\b/);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
});

test('rejects unknown scopes', async () => {
  await assert.rejects(() => run(['unknown']), /未知命令/);
});

test('refuses to install a relay from the workbench package', async () => {
  await assert.rejects(() => run(['relay', 'install', '--config', '/tmp/relay.json']), /benchgo-relay/);
});
