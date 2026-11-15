/** Explicit, headless Windows integration smoke against a prepared, already bundled native app. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

if (process.platform !== 'win32' || !process.argv[2]) throw new Error('用法: node test/native-windows.mjs <packaged-app-directory>');
const app = resolve(process.argv[2]), resources = join(app, 'resources');
const isolated = await mkdtemp(join(tmpdir(), 'benchgo-cli-native-'));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = isolated;
process.env.DSH_HOME = join(isolated, 'dsh'); process.env.DSH_TELEMETRY_DISABLED = '1';
const { installWorkbench, workbenchStatus, stopWorkbench, startWorkbench } = await import('../src/installer.mjs');
const runtime = join(resources, 'app.asar.unpacked/dsh');
const descriptor = JSON.parse(await readFile(join(runtime, 'desktop-runtime.json'), 'utf8'));
const seed = join(resources, 'benchgo/seed');
const manifest = JSON.parse(await readFile(join(seed, 'release.json'), 'utf8'));
const metadata = { schemaVersion: 1, releaseVersion: manifest.version, pluginVersion: manifest.version, engineVersion: descriptor.release.version };
const options = { home: process.env.DSH_HOME, root: seed, runtime, offline: true, open: false };
const report = { isolated, app, engine: metadata.engineVersion, plugin: metadata.pluginVersion, checks: [] };
const initializeProfile = async (runtime, paths) => {
  const boot = await import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')).href);
  const official = await import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai/dsh-official-bundles/lib/index.js')).href);
  boot.initProfile(paths.profile, official.PROFILE_TEMPLATES.web.bundles);
  const probe = join(paths.profile, 'native-probe.mjs');
  const inspector = new URL('../../../scripts/desktop/packaged-profile-probe.mjs', import.meta.url).href;
  await writeFile(probe, `import { inspectPackagedProfile } from ${JSON.stringify(inspector)};\nexport const inject = ['connection','tools'];\nexport function apply(ctx) { ctx.effect(() => ctx.connection.fetch.register({path:'/api/benchgo-cli-native',methods:['POST'],requestBody:'buffered',fetch:async()=>Response.json({...await inspectPackagedProfile(ctx), dependencies:await ctx.tools.get('load_workspace_dependencies').execute({})})})); }\n`);
  await writeFile(join(paths.profile, 'cordis.patch.yml'), `- insert:\n    - id: benchgo-cli-native-probe\n      name: ${JSON.stringify(probe)}\n`);
};
let running;
try {
  await mkdir(join(isolated, '.benchgo/link'), { recursive: true });
  await writeFile(join(isolated, '.benchgo/link/devices.json'), JSON.stringify({ host: '127.0.0.1', port: 0 }));
  const result = await installWorkbench(options, { metadata, initializeProfile }); running = true;
  assert.ok(result.url); assert.equal(result.installation.node, join(app, 'BenchGo.exe'));
  const first = await workbenchStatus(options);
  const repeated = await installWorkbench(options, { metadata, initializeProfile });
  assert.equal(repeated.pid, first.pid); assert.equal(repeated.installation.id, first.installation.id);
  assert.equal((await readFile(join(options.home, 'profiles/desktop/lock'), 'utf8')).trim(), String(first.pid));
  report.checks.push('install/status/repeated install reuse identical PID and installation identity; official PID lock held');
  const login = await fetch(first.url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); assert.ok(cookie);
  const response = await fetch(new URL('/api/commander', first.url), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'state' }), signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200); const state = await response.json(); assert.ok(Array.isArray(state.sessions));
  report.checks.push('authenticated BenchGo API returns actual session state');
  const probeResponse = await fetch(new URL('/api/benchgo-cli-native', first.url), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(300_000) });
  assert.equal(probeResponse.status, 200); const probe = await probeResponse.json();
  assert.equal(probe.modules.length, 5); assert.ok(probe.modules.every(row => row.available && row.state === 2));
  report.checks.push('all five installed Cordis entries are active and services available');
  const primary = join(options.home, 'dsh-runtimes/dsh-primary-runtime');
  await readFile(join(primary, 'runtime.json'));
  await new Promise((done, fail) => {
    const child = spawn(join(primary, 'dependencies/python/python.exe'), ['-c', 'import docx,pptx,openpyxl,PIL,lxml,numpy,pandas; print("python-office-ok")'], { env: process.env, windowsHide: true, stdio: 'inherit' });
    child.once('error', fail); child.once('exit', code => code === 0 ? done() : fail(new Error(`bundled Python failed ${code}`)));
  });
  report.checks.push('official load_workspace_dependencies installed complete runtime; bundled Office/Python imports pass');
  await stopWorkbench(options); running = false;
  assert.equal((await workbenchStatus(options)).running, false);
  await assert.rejects(() => readFile(join(options.home, 'profiles/desktop/lock')), { code: 'ENOENT' });
  report.checks.push('stop acknowledges full official shutdown and releases both ownership locks');
  const restarted = await startWorkbench(options); running = true; assert.notEqual(restarted.pid, first.pid);
  assert.equal(restarted.installation.id, first.installation.id);
  await stopWorkbench(options); running = false;
  report.checks.push('start after stop uses same installation and a fresh process; second stop succeeds');
  console.log(JSON.stringify({ ...report, success: true }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ...report, success: false, error: error.stack }, null, 2));
  try { console.error(await readFile(join(options.home, '.benchgo/workbench/host.log'), 'utf8')); } catch {}
  throw error;
} finally {
  if (running) await stopWorkbench(options).catch(error => console.error(error.message));
  const status = await workbenchStatus(options).catch(() => null);
  if (!status?.running) await rm(isolated, { recursive: true, force: true });
}
