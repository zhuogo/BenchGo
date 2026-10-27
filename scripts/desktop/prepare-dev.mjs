import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const app = join(root, 'artifacts/windows/win-unpacked');
const executable = join(app, 'BenchGo.exe');
const resources = join(app, 'resources');

if (!existsSync(executable)) {
  throw new Error('BenchGo.exe 不存在。先运行 npm run package:plus:win。开发预览启动 BenchGo，不启动官方 Desktop。');
}

// Enroll the plugin shipped inside this BenchGo build, then open the app.
// The executable already carries the BenchGo icon, splash, and welcome page.
const enrolled = await new Promise((resolve, reject) => {
  const child = spawn(executable, [
    '--expose-internals', join(resources, 'benchgo/plugin-bundle.mjs'), 'init-profile',
    '--resources', resources,
    '--runtime', join(resources, 'app.asar.unpacked/dsh'),
  ], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`BenchGo 插件登记失败 (${code})`)));
});
void enrolled;

const appProcess = spawn(executable, [], { stdio: 'inherit', detached: true });
appProcess.unref();
console.log(`BenchGo started: ${executable}`);
