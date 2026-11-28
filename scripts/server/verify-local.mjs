/** Opt-in Linux connection integration with an isolated HOME and the real Harness. */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
if (process.platform !== 'linux') throw new Error('此验证需要 Linux 环境');
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'dsh-server-local-'));
const home = join(directory, 'home'), base = join(home, '.local/share/benchgo/server');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = async () => { const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const value = server.address().port; await new Promise(r => server.close(r)); return value; };
let host;
try {
  const assets = join(directory, 'assets'); await cp(join(root, 'plugins/link/dist/server'), assets, { recursive: true });
  const manifest = JSON.parse(await readFile(join(assets, 'manifest.json'), 'utf8'));
  const profile = join(base, 'home/profiles/web'), runtime = join(base, 'runtimes', manifest.harnessVersion);
  const dataDir = join(base, 'data'), owner = join(base, 'owner.json');
  await mkdir(join(runtime, 'node_modules/@deepseek-ai'), { recursive: true });
  await symlink(join(root, 'deepseek-harness/apps/cli'), join(runtime, 'node_modules/@deepseek-ai/dsh'), 'dir');
  for (const name of ['dsh-app-boot', 'dsh-atomic-write']) await symlink(join(root, 'deepseek-harness/apps/cli/node_modules/@deepseek-ai', name), join(runtime, 'node_modules/@deepseek-ai', name), 'dir');
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dependencies: { 'benchgo-plugin': 'link:' + join(root, 'plugins/base') }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'benchgo-plugin'] } } }));
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  await symlink(join(root, 'plugins/base'), join(profile, 'node_modules/benchgo-plugin'), 'dir');
  await writeFile(join(profile, 'cordis.yml'), '[]\n');
  await writeFile(join(profile, 'cordis.patch.yml'), ['- id: commander', '  config:', '    dataDir: ' + JSON.stringify(dataDir), '- id: session-log-deepseek', '  config:', '    enabled: false', '- id: session-telemetry-otel', '  disabled: true', ''].join('\n'));
  const webPort = await port(), linkPort = await port();
  const state = { schemaVersion: 1, harnessVersion: manifest.harnessVersion, pluginVersion: manifest.pluginVersion, runtime, profile, dataDir, webPort, port: linkPort };
  await writeFile(join(base, 'installation.json'), JSON.stringify(state));
  let output = '';
  host = spawn(process.execPath, ['--import', join(root, 'deepseek-harness/node_modules/tsx/dist/esm/index.mjs'), join(root, 'deepseek-harness/apps/cli/src/bin.ts'), '--profile', 'web', '--host', '127.0.0.1', '--port', String(webPort), '--no-open'], { cwd: directory, env: { ...process.env, DSH_HOME: join(base, 'home'), DSH_TELEMETRY_DISABLED: '1', TSX_TSCONFIG_PATH: join(root, 'deepseek-harness/tsconfig.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [host.stdout, host.stderr]) stream.on('data', data => { output = (output + data.toString()).slice(-50000); });
  let login;
  for (let i = 0; i < 180; i++) { login = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)?.[1]; if (login) break; if (host.exitCode !== null) throw new Error('isolated Harness exited: ' + output.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]').slice(-3000)); await wait(250); }
  assert(login, 'real Harness booted'); await writeFile(owner, JSON.stringify({ url: login }), { mode: 0o600 });
  const bin = join(directory, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(join(bin, 'loginctl'), '#!/bin/sh\nprintf "yes\\n"\n', { mode: 0o700 });
  const invoke = operation => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(assets, 'bootstrap.mjs'), 'mirror', operation], { env: { ...process.env, HOME: home, PATH: bin + ':' + process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error('bootstrap failed: ' + stderr.slice(-1500))));
  });
  const result = await invoke('connect');
  assert.equal(result.port, linkPort); assert.match(result.pin, /^[A-Za-z0-9+/]{43}=$/); assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
  const devices = JSON.parse(await readFile(join(dataDir, 'link/devices.json'))).devices; assert.equal(devices.length, 1); assert(!JSON.stringify(devices).includes(result.token));
  console.log(JSON.stringify({ passed: ['real isolated Harness', 'existing installation reuse', 'owner token login', 'loopback Link configure', 'SSH bootstrap local approval', 'TLS SPKI and authorized token', 'no plaintext token in remote device store'], persistent: result.persistent }));
} finally {
  if (host && host.exitCode === null) { host.kill('SIGTERM'); await Promise.race([new Promise(r => host.once('exit', r)), wait(10000)]); if (host.exitCode === null) { host.kill('SIGKILL'); await new Promise(r => host.once('exit', r)); } }
  await rm(directory, { recursive: true, force: true });
}
