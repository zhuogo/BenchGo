import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeWatchdogProfile, watchdogLaunchSpec, watchdogProfileStatus, startWatchdogProfile,
  WATCHDOG_PROFILE } from '../../../scripts/watchdog/profile.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const { parse: parseYaml } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('yaml');
const secret = 'watchdog-fixture-' + '9'.repeat(48);

async function fixture(t, config) {
  const temporary = await mkdtemp(join(tmpdir(), 'benchgo-watchdog-profile-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const tokenFile = join(temporary, 'supervisor.token');
  await writeFile(tokenFile, secret, { mode: 0o600 });
  const directory = join(temporary, 'isolated');
  const installation = await initializeWatchdogProfile({ directory, targetId: 'main-fixture', targetUrl: 'http://127.0.0.1:12345', tokenFile, config });
  return { temporary, tokenFile, directory, installation };
}

test('init keeps one BenchGo package and isolates all state without copying its credential', async t => {
  const { directory, tokenFile, installation } = await fixture(t);
  const manifest = JSON.parse(await readFile(join(installation.profile, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'benchgo-plugin']);
  assert.deepEqual(Object.keys(manifest.dependencies), ['benchgo-plugin']);
  const patches = parseYaml(await readFile(join(installation.profile, 'cordis.patch.yml'), 'utf8'));
  const root = patches.find(row => row.id === 'commander');
  assert.equal(root.config.dataDir, join(directory, 'data'));
  assert.equal(root.config.watchdog.tokenFile, tokenFile);
  assert.equal(root.config.watchdog.enabled, true);
  assert.equal(root.config.watchdog.intervalSeconds, 60);
  for (const id of ['commander-harness', 'commander-superagent', 'commander-voice', 'commander-link', 'tool-schedule'])
    assert.equal(patches.find(row => row.id === id).disabled, true);
  assert.deepEqual(patches.find(row => row.id === 'permission').config, {
    defaultPreset: 'benchgo-watchdog-read-only', presets: { 'benchgo-watchdog-read-only': { sandbox: 'read-only', approval: 'ask' } },
  });
  assert.equal(patches.some(row => row.name?.includes('watchdog')), false);
  assert.equal(JSON.stringify({ manifest, patches, installation }).includes(secret), false);
  assert.equal(await readFile(tokenFile, 'utf8'), secret);
  assert.deepEqual(await readdir(installation.dataDir), []);
});

test('init never replaces an existing archive and rejects invalid settings before writing', async t => {
  const { temporary, directory, tokenFile } = await fixture(t);
  const marker = join(directory, 'keep.txt'); await writeFile(marker, 'user-owned');
  await assert.rejects(initializeWatchdogProfile({ directory, targetId: 'main', targetUrl: 'http://localhost', tokenFile }), { code: 'WATCHDOG_EXISTS' });
  assert.equal(await readFile(marker, 'utf8'), 'user-owned');
  for (const config of [{ intervalSeconds: 59 }, { secret: secret }, { paused: 'yes' }, { maintenanceUntil: 'yesterday' }, []]) {
    const invalid = join(temporary, 'invalid');
    await assert.rejects(initializeWatchdogProfile({ directory: invalid, targetId: 'main', targetUrl: 'http://localhost', tokenFile, config }), { code: 'WATCHDOG_CONFIG_INVALID' });
    await assert.rejects(readFile(join(invalid, 'installation.json')), { code: 'ENOENT' });
  }
  await assert.rejects(initializeWatchdogProfile({ directory: join(temporary, 'bad-url'), targetId: 'main', targetUrl: `http://user:${secret}@localhost`, tokenFile }), { code: 'WATCHDOG_CONFIG_INVALID' });
});

test('launch uses only the official profile CLI with hidden, local, isolated options', async t => {
  const { directory, installation } = await fixture(t);
  const spec = await watchdogLaunchSpec({ directory, env: { DSH_HOME: 'do-not-use', EXAMPLE: 'preserved' } });
  assert.equal(spec.command, process.execPath);
  assert(spec.args.includes('--profile'));
  assert.equal(spec.args[spec.args.indexOf('--profile') + 1], WATCHDOG_PROFILE);
  assert(spec.args.includes('--no-open'));
  assert.equal(spec.args[spec.args.indexOf('--host') + 1], '127.0.0.1');
  assert.equal(spec.args.includes('--from-default-profile'), false);
  assert.equal(spec.options.env.DSH_HOME, installation.home);
  assert.equal(spec.options.env.EXAMPLE, 'preserved');
  assert.equal(spec.options.env.DSH_PERMISSION_MODE, 'read-only');
  assert.equal(spec.options.cwd, resolve(directory));
  assert.equal(spec.options.windowsHide, true);
  assert.equal(spec.options.shell, false);
  assert.equal(JSON.stringify(spec.args).includes(secret), false);
});

test('status distinguishes absent checks, incomplete checks and delivery backlog without exposing logged text', async t => {
  const { directory, installation } = await fixture(t);
  let status = await watchdogProfileStatus({ directory });
  assert.equal(status.stateAvailable, false); assert.equal(status.lastCheckAt, null); assert.deepEqual(status.degraded, ['NOT_OBSERVED']);
  await mkdir(join(installation.dataDir, 'watchdog'));
  const at = '2026-11-09T00:00:00.000Z';
  await writeFile(join(installation.dataDir, 'watchdog/state.json'), JSON.stringify({ schemaVersion: 1, targetId: 'main-fixture', lastCheckAt: at,
    checks: [{ id: 'completed', completedAt: at, degraded: ['MODEL_JUDGE_UNCONFIGURED'], raw: secret },
      { id: 'working', status: 'running', startedAt: at, raw: secret }],
    signals: [{ state: 'pending', raw: secret }, { state: 'accepted' }, { state: 'superseded' }],
    config: { token: secret }, transcript: secret,
  }));
  status = await watchdogProfileStatus({ directory });
  assert.equal(status.lastCheckAt, at); assert.equal(status.currentCheck.id, 'working');
  assert.equal(status.incomplete, 1); assert.equal(status.pendingSignals, 1); assert.deepEqual(status.degraded, ['MODEL_JUDGE_UNCONFIGURED']);
  assert.equal(JSON.stringify(status).includes(secret), false);
});

test('attached CLI child preserves credential secrecy and removes only its own startup lock', async t => {
  const { temporary, directory, installation } = await fixture(t);
  const cli = join(temporary, 'official-cli-fixture.mjs');
  await writeFile(cli, `import {readFile} from 'node:fs/promises';\n`
    + `const p=JSON.parse(await readFile(process.env.DSH_HOME+'/profiles/${WATCHDOG_PROFILE}/cordis.patch.yml','utf8'));\n`
    + `const token=await readFile(p[0].config.watchdog.tokenFile,'utf8');\n`
    + `console.log('fixture token='+token);console.error('http://127.0.0.1:1/?token=owner-cookie');\n`
    + `console.log(JSON.stringify({args:process.argv.slice(2),home:process.env.DSH_HOME}));\n`
    + `setTimeout(()=>process.exit(0),150);\n`);
  let stdout = '', stderr = '';
  const running = await startWatchdogProfile({ directory, cli }, { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
  await assert.rejects(startWatchdogProfile({ directory, cli }), { code: 'WATCHDOG_RUNNING' });
  assert.deepEqual(await running.completion, { code: 0, signal: null });
  assert.equal(stdout.includes(secret), false); assert.equal(stderr.includes('owner-cookie'), false);
  assert(stdout.includes('[redacted]')); assert(stderr.includes('[redacted]'));
  assert(stdout.includes(installation.home.replaceAll('\\', '\\\\')));
  assert.equal((await watchdogProfileStatus({ directory })).process.state, 'exited');
  await assert.rejects(readFile(join(directory, 'launch.lock')), { code: 'ENOENT' });
});

const officialCli = process.env.BENCHGO_WATCHDOG_TEST_CLI;
test('the locked official CLI composes the isolated profile without booting an app', {
  timeout: 60000,
  skip: !officialCli && !existsSync(join(repository, 'deepseek-harness/apps/cli/lib/bin.js'))
    ? '需要已构建官方 CLI；设置 BENCHGO_WATCHDOG_TEST_CLI 指向匹配 upstream.json 的官方 bin.js' : false,
}, async t => {
  const { directory, installation } = await fixture(t);
  const spec = await watchdogLaunchSpec({ directory, cli: officialCli, dumpConfig: true });
  let output = '', errors = '';
  const child = spawn(spec.command, spec.args, spec.options);
  const timer = setTimeout(() => { child.kill('SIGTERM'); }, 45000);
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGTERM'); });
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
  clearTimeout(timer);
  assert.equal(code, 0, errors.slice(-4000));
  assert(output.includes('benchgo-plugin'));
  assert(output.includes('watchdog:'));
  assert(output.includes('benchgo-watchdog-read-only'));
  assert(output.includes(installation.dataDir.replaceAll('\\', '\\\\')) || output.includes(installation.dataDir));
  assert.equal(output.includes(secret), false);
  // The package bundle remains the only source of these five rows.
  for (const id of ['commander', 'commander-harness', 'commander-superagent', 'commander-voice', 'commander-link'])
    assert.equal((output.match(new RegExp(`id: ${id}(?:\\r?\\n|$)`, 'g')) || []).length, 1, id);
});
