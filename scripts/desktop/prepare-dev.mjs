import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncDevelopmentPlugin } from './sync-dev-plugin.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const artifacts = join(root, 'artifacts');
const defaultApp = join(artifacts, 'windows/win-unpacked');
const configuredApp = process.env.BENCHGO_DEV_APP_DIR;
const app = configuredApp
  ? resolve(root, configuredApp)
  : existsSync(join(defaultApp, 'BenchGo.exe'))
    ? defaultApp
    : existsSync(artifacts)
      ? readdirSync(artifacts, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^windows(?:-|$)/i.test(entry.name))
        .map(entry => join(artifacts, entry.name, 'win-unpacked'))
        .filter(directory => existsSync(join(directory, 'BenchGo.exe')))
        .sort((left, right) => statSync(join(right, 'BenchGo.exe')).mtimeMs - statSync(join(left, 'BenchGo.exe')).mtimeMs)[0]
        ?? defaultApp
      : defaultApp;
const executable = join(app, 'BenchGo.exe');
const resources = join(app, 'resources');

if (!existsSync(executable)) {
  throw new Error('BenchGo.exe 不存在。先运行 npm run package:plus:win。开发预览启动 BenchGo，不启动官方 Desktop。');
}

// Use current enrollment validation for the locally updated plugin layout;
// the packaged seed remains the source for a profile's first installation.
// The executable already carries the BenchGo icon, splash, and welcome page.
const enrolled = await new Promise((resolve, reject) => {
  let output = '';
  const child = spawn(executable, [
    '--expose-internals', join(root, 'scripts/desktop/plugin-bundle.mjs'), 'init-profile',
    '--resources', resources,
    '--runtime', join(resources, 'app.asar.unpacked/dsh'),
  ], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
  child.once('error', reject);
  child.once('close', code => {
    if (code !== 0) return reject(new Error(`BenchGo 插件登记失败 (${code})`));
    try { resolve(JSON.parse(output.trim())); }
    catch (error) { reject(new Error('BenchGo 插件登记返回了无效的 JSON，未启动桌面', { cause: error })); }
  });
});
await syncDevelopmentPlugin({ root, enrollment: enrolled });

// The desktop outlives this launcher; inherited terminal pipes can close and cause EPIPE.
const appProcess = spawn(executable, [], { stdio: 'ignore', detached: true });
appProcess.unref();
console.log(`BenchGo started: ${executable}`);
