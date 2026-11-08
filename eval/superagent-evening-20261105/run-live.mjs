import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { preflight } from './preflight.mjs';
import { runCase } from './cases.mjs';
import { assertNoCredentials, canRemoveState } from './retention.mjs';
import { createPrivateDirectory } from './private-access.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2), option = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const selectedCase = option('--case') || 'attention-1';
assert.ok(['attention-1', 'attention-2', 'attention-3', 'pause-resume', 'adjustment'].includes(selectedCase), 'Unknown case');
const output = resolve(root, option('--output-dir') || `eval/superagent-evening-20261105/${selectedCase}-attempt-1`);
const outputBase = resolve(root, 'eval/superagent-evening-20261105');
assert.ok(output.startsWith(outputBase + '\\') || output.startsWith(outputBase + '/'), 'Output must be a new evening evidence subdirectory');
const prepared = await preflight({ credentials: args.includes('--run') });
if (!args.includes('--run')) {
  console.log(JSON.stringify({ prepared: true, requiresExplicitRun: true, selectedCase, ...prepared.evidence }));
  process.exit(0);
}
assertNoCredentials(prepared.providers, prepared.secrets);
await createPrivateDirectory(output); // Never overwrite an earlier attempt.
let child, ended, directory, log = '';
const redact = value => Object.values(prepared.secrets).reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), String(value))
  .replace(/([?&]token=)[^\s&"']+/g, '$1[REDACTED]');
const report = { kind: 'isolated-controlled-real-supplier', selectedCase, startedAt: new Date().toISOString(), preflight: prepared.evidence,
  limitation: 'Original user task includes a verification workflow; no review/worker/result injection. Not natural occurrence or desktop end-to-end acceptance.',
  monetaryBudget: { status: 'unsupported', reason: 'No reliable pricing source; cost is not substituted with tokens, requests or elapsed time.' }, scenarios: [] };
const save = () => writeFile(join(output, 'results.json'), redact(JSON.stringify(report, null, 2)));
try {
  report.build = { pluginVersion: JSON.parse(await readFile(join(root, 'plugins/benchgo/package.json'), 'utf8')).version, files: [] };
  for (const name of ['worker-attention.mjs', 'attention-store.mjs', 'ticket-review.mjs', 'auxiliary-request.mjs', 'ticket-revisions.mjs', 'routing.mjs']) {
    const path = `plugins/benchgo/lib/modules/superagent/src/${name}`;
    report.build.files.push({ path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') });
  }
  directory = join(output, 'isolated-state');
  await mkdir(directory);
  const isolatedUser = join(directory, 'user'), dshHome = join(isolatedUser, '.dsh'), profile = join(dshHome, 'profiles/web');
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  for (const [name, source] of [['@deepseek-ai', join(root, 'deepseek-harness/apps/cli/node_modules/@deepseek-ai')], ['benchgo-plugin', join(root, 'plugins/benchgo')]]) {
    await symlink(source, join(profile, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir');
  }
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'benchgo-evening-isolated-live', private: true,
    dependencies: { 'benchgo-plugin': `link:${join(root, 'plugins/benchgo')}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'benchgo-plugin'] } } }));
  await writeFile(join(profile, 'cordis.yml'), '[]\n');
  const streamPath = join(output, 'stream-frames.jsonl');
  const requestPath = join(output, 'supplier-requests.jsonl');
  await writeFile(streamPath, '');
  await writeFile(requestPath, '');
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([
    { id: 'session-log-deepseek', config: { enabled: false } }, { id: 'session-telemetry-otel', disabled: true }, { id: 'commander-link', disabled: true },
    { id: 'llm-pi-ai', config: { providers: prepared.providers } },
    { insert: [{ id: 'evening-observation', name: pathToFileURL(join(root, 'eval/superagent-evening-20261105/observe-runtime.mjs')).href, config: { streamPath, requestPath } }] },
  ]));
  child = spawn(process.execPath, ['--import', pathToFileURL(join(root, 'scripts/source-host-loader.mjs')).href,
    '--import', pathToFileURL(join(root, 'deepseek-harness/node_modules/tsx/dist/esm/index.mjs')).href,
    join(root, 'deepseek-harness/apps/cli/src/bin.ts'), '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: directory, TMP: directory, HOME: isolatedUser,
      USERPROFILE: isolatedUser, DSH_HOME: dshHome, DSH_AGENTS_HOME: join(isolatedUser, 'agents'),
      TSX_TSCONFIG_PATH: join(root, 'deepseek-harness/tsconfig.json'), DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1', ...prepared.secrets },
  });
  report.loader = { pid: child.pid, isolated: true, noOpen: true };
  ended = new Promise(resolveExit => { child.once('exit', (code, signal) => resolveExit({ code, signal })); child.once('error', error => { log += error.message; resolveExit({ error: error.message }); }); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk.toString(); });
  let login;
  for (const deadline = Date.now() + 90000; Date.now() < deadline;) {
    const match = log.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/);
    if (match) { login = new URL(match[1]); break; }
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Official loader exited: ${redact(log).slice(-4000)}`);
    await delay(200);
  }
  assert.ok(login, 'Official loader did not become ready');
  report.loader.origin = login.origin;
  const signed = await fetch(login, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const cookie = signed.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(cookie, 'Isolated authentication failed');
  const call = async input => {
    let response;
    for (const deadline = Date.now() + 20000;;) {
      response = await fetch(new URL('/api/commander/assistant', login), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(25000) });
      if (response.status !== 404 || Date.now() >= deadline) break;
      await response.text(); await delay(200);
    }
    const text = await response.text();
    assert.match(response.headers.get('content-type') || '', /application\/json/, `HTTP ${response.status}: ${redact(text).slice(0, 1000)}`);
    const body = JSON.parse(text);
    assert.equal(response.status, 200, redact(JSON.stringify(body)).slice(0, 2000));
    return body;
  };
  const current = await call({ action: 'state' });
  const desired = { name: '晚间隔离真实验收', models: prepared.assistant.models, workerModels: prepared.assistant.workerModels || [], auxiliary: prepared.assistant.auxiliary || null };
  await call({ action: 'config', revision: current.config.revision, patch: desired });
  const loaded = (await call({ action: 'state' })).config;
  for (const key of ['models', 'workerModels', 'auxiliary']) assert.deepEqual(loaded[key], desired[key], `Isolated ${key} saved/reloaded differently`);
  report.isolatedConfig = { models: loaded.models, workerModels: loaded.workerModels, auxiliary: loaded.auxiliary, revision: loaded.revision };
  await save();
  await runCase({ call, report, save, output, redact, selectedCase, directory, fixture: join(root, 'eval/superagent-evening-20261105/fixture.md') });
} catch (error) {
  report.fatal = redact(error.stack || error.message); process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill(); await Promise.race([ended, delay(10000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended; }
  }
  let mainConfigurationUnchanged = false;
  try {
    const configHash = createHash('sha256').update(await readFile(prepared.configPath, 'utf8')).digest('hex');
    mainConfigurationUnchanged = configHash === prepared.configHash;
  } catch (error) {
    report.configCheckError = redact(error.message);
  }
  const childStopped = !child || child.exitCode !== null || child.signalCode !== null;
  let removed = false;
  if (directory && canRemoveState({ childStopped, mainConfigurationUnchanged, fatal: report.fatal, scenarios: report.scenarios })) {
    assert.equal(resolve(directory), join(output, 'isolated-state'), 'Unexpected cleanup path');
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); removed = true;
  }
  report.finishedAt = new Date().toISOString();
  report.cleanup = { childStopped, isolatedDirectoryRemoved: removed, isolatedDirectory: directory && !removed ? directory : null, mainConfigurationUnchanged };
  await writeFile(join(output, 'loader.log'), redact(log)); await save();
  console.log(JSON.stringify({ output, scenarios: report.scenarios.map(row => ({ id: row.id, status: row.status, error: row.error })), fatal: report.fatal, cleanup: report.cleanup }));
  if (!report.cleanup.childStopped || !report.cleanup.mainConfigurationUnchanged || report.scenarios.length === 0 || report.scenarios.some(row => row.status !== 'pass')) process.exitCode = 1;
}
