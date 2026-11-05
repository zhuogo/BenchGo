// Real supplier + official CLI/Web + product plugin; no GUI or user-session mutation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runCases } from './cases.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const option = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const selectedCases = option('--case') || 'all';
const output = resolve(root, option('--output-dir') || 'eval/superagent-p0-20261105/latest');
const deadlineMs = Number(option('--deadline-ms') || 720000);
assert.ok(Number.isSafeInteger(deadlineMs) && deadlineMs >= 30000 && deadlineMs <= 1800000, 'Invalid deadline');
assert.ok(['all', 'no-files', 'fourteen', 'router-block', 'worker-block', 'router-stream'].includes(selectedCases), 'Unknown live case');

if (!args.includes('--run')) {
  console.log(JSON.stringify({ prepared: true, requiresExplicitRun: true, cases: selectedCases, officialLoader: true, supplier: 'existing SuperAgent primary model (exact opaque IDs)', isolated: true, note: 'No provider request made. --run requires parent integration authorization.' }));
  process.exit(0);
}

await mkdir(output, { recursive: true });
const report = { kind: 'isolated-controlled-scenarios-with-real-supplier-and-runtime', startedAt: new Date().toISOString(), selectedCases, scenarios: [], limitation: '受控条件仅追加到Worker首轮已记录输入；不改变Mandate、验收、结果、日志和review。不是自然发生场景。' };
let secret = '', child, ended, directory, log = '';
const redact = value => String(value).replaceAll(secret || '\0', '[REDACTED]').replace(/([?&]token=)[^\s&"']+/g, '$1[REDACTED]');
const save = async () => writeFile(join(output, 'results.json'), redact(JSON.stringify(report, null, 2)));
try {
  const require = createRequire(join(root, 'deepseek-harness/packages/credentials/credentials-local/package.json'));
  const { parse } = require('yaml');
  const existingHome = homedir(), existingDsh = join(existingHome, '.dsh');
  const assistant = JSON.parse(await readFile(join(existingHome, '.benchgo/assistant/config.json'), 'utf8'));
  const route = assistant.models?.[0];
  assert.ok(route?.providerId && route.modelId, 'Existing SuperAgent route is unavailable');
  const patches = parse(await readFile(join(existingDsh, 'profiles/desktop/cordis.patch.yml'), 'utf8'));
  const provider = patches.find(entry => entry.id === 'llm-pi-ai')?.config.providers[route.providerId];
  assert.equal(provider?.api, 'openai-completions', 'Unsupported existing supplier protocol');
  assert.ok(provider.models?.some(model => model.id === route.modelId), 'Configured exact model is not registered');
  const credentials = parse(await readFile(join(existingDsh, '.credentials.yaml'), 'utf8'));
  const entry = credentials.refs?.[provider.apiKeyEnv];
  secret = typeof entry === 'string' ? entry : entry?.value;
  assert.ok(secret && provider.baseURL, 'Existing supplier credential/base URL is unavailable');
  report.supplier = { providerId: route.providerId, modelId: route.modelId, api: provider.api, origin: new URL(provider.baseURL).origin, configRevision: assistant.revision };
  report.plugin = { path: 'plugins/benchgo', sourcePackage: 'plugins/superagent', version: JSON.parse(await readFile(join(root, 'plugins/benchgo/package.json'), 'utf8')).version };
  directory = await mkdtemp(join(tmpdir(), 'benchgo-p0-real-'));
  const home = join(directory, 'user'), dshHome = join(home, '.dsh'), profile = join(dshHome, 'profiles/web');
  const controlsPath = join(output, 'worker-controls.jsonl'), activePath = join(output, 'active-case.json'), streamPath = join(output, 'router-stream-frames.jsonl');
  await writeFile(controlsPath, '');
  await writeFile(activePath, '{}');
  await writeFile(streamPath, '');
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  for (const [name, source] of [['@deepseek-ai', join(root, 'deepseek-harness/apps/cli/node_modules/@deepseek-ai')], ['benchgo-plugin', join(root, 'plugins/benchgo')]]) {
    await symlink(source, join(profile, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir');
  }
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'benchgo-p0-isolated-live', private: true, dependencies: { 'benchgo-plugin': `link:${join(root, 'plugins/benchgo')}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'benchgo-plugin'] } } }));
  await writeFile(join(profile, 'cordis.yml'), '[]\n');
  const isolatedProvider = { api: provider.api, baseURL: provider.baseURL, apiKeyEnv: 'BENCHGO_P0_SUPPLIER_KEY', models: provider.models.filter(model => model.id === route.modelId) };
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([
    { id: 'session-log-deepseek', config: { enabled: false } }, { id: 'session-telemetry-otel', disabled: true }, { id: 'commander-link', disabled: true },
    { id: 'llm-pi-ai', config: { providers: { [route.providerId]: isolatedProvider } } },
    { insert: [{ id: 'p0-live-worker-controls', name: pathToFileURL(join(root, 'eval/superagent-p0-20261105/worker-controls.mjs')).href, config: { recordPath: controlsPath, activePath, streamPath } }] },
  ]));
  child = spawn(process.execPath, ['--import', pathToFileURL(join(root, 'deepseek-harness/node_modules/tsx/dist/esm/index.mjs')).href, join(root, 'deepseek-harness/apps/cli/src/bin.ts'), '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: directory, TMP: directory, HOME: home, USERPROFILE: home, DSH_HOME: dshHome, DSH_AGENTS_HOME: join(home, 'agents'), TSX_TSCONFIG_PATH: join(root, 'deepseek-harness/tsconfig.json'), DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1', BENCHGO_P0_SUPPLIER_KEY: secret },
  });
  report.loader = { pid: child.pid, isolated: true, noOpen: true };
  ended = new Promise(resolveExit => { child.once('exit', (code, signal) => resolveExit({ code, signal })); child.once('error', error => { log += error.message; resolveExit({ error: error.message }); }); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk.toString(); });
  let login;
  for (const deadline = Date.now() + 90000; Date.now() < deadline;) {
    const match = log.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/);
    if (match) { login = new URL(match[1]); break; }
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Isolated Harness exited: ${redact(log).slice(-5000)}`);
    await delay(200);
  }
  assert.ok(login, 'Official isolated loader did not become ready');
  report.loader.origin = login.origin;
  const signed = await fetch(login, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const cookie = signed.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(cookie, 'Isolated loader authentication failed');
  const call = async input => {
    let response;
    for (const deadline = Date.now() + 20000;;) {
      response = await fetch(new URL('/api/commander/assistant', login), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(20000) });
      if (response.status !== 404 || Date.now() >= deadline) break;
      await response.text(); await delay(200);
    }
    const text = await response.text();
    assert.match(response.headers.get('content-type') || '', /application\/json/, `HTTP ${response.status}: ${redact(text).slice(0, 1000)}`);
    const body = JSON.parse(text);
    assert.equal(response.status, 200, redact(JSON.stringify(body)).slice(0, 2000));
    return body;
  };
  const state = await call({ action: 'state' });
  await call({ action: 'config', revision: state.config.revision, patch: { name: 'P0隔离真实验收', models: [route], auxiliary: assistant.auxiliary || null } });
  await runCases({ call, report, save, output, redact, deadlineMs, selectedCases, directory });
} catch (error) {
  report.fatal = redact(error.stack || error.message);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await Promise.race([ended, delay(10000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended; }
  }
  if (directory) {
    const absolute = resolve(directory), tempBase = resolve(tmpdir());
    assert.ok(absolute.startsWith(tempBase + '\\') || absolute.startsWith(tempBase + '/'), 'Unexpected temporary path');
    assert.ok(absolute.includes('benchgo-p0-real-'), 'Unexpected temporary directory');
    await rm(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  report.finishedAt = new Date().toISOString();
  report.cleanup = { childStopped: !child || child.exitCode !== null || child.signalCode !== null, isolatedDirectoryRemoved: !!directory };
  await writeFile(join(output, 'loader.log'), redact(log));
  await save();
  console.log(JSON.stringify({ output, scenarios: report.scenarios.map(item => ({ id: item.id, status: item.status, error: item.error })), fatal: report.fatal, cleanup: report.cleanup }));
  if (report.scenarios.some(item => item.status !== 'pass')) process.exitCode = 1;
}
