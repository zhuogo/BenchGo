#!/usr/bin/env node
/** Rebuild BenchGo module, client and Link artifacts for Harness HMR, without a server seed. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { syncDesktopBrowserArtifacts } from './desktop/sync-browser-artifacts.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: { profile: { type: 'string' }, 'no-desktop-sync': { type: 'boolean', default: false } } });
const child = spawn(process.execPath, [fileURLToPath(new URL('../plugins/benchgo/scripts/build-client.mjs', import.meta.url)), '--client'], {
  cwd: root,
  stdio: 'inherit',
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', async code => {
  if (code !== 0) { process.exitCode = code ?? 1; return; }
  if (values['no-desktop-sync']) { console.log('已跳过桌面浏览器产物同步 (--no-desktop-sync)'); return; }
  try {
    const result = await syncDesktopBrowserArtifacts({ root, ...(values.profile ? { profile: values.profile } : {}) });
    console.log(result.synced ? `桌面浏览器产物已同步：${result.target}（${result.files} 个文件）；请刷新当前窗口。` : `桌面浏览器产物未同步：${result.reason === 'disabled' ? '插件已停用' : '未发现受管安装'}（${result.profile}）`);
  } catch (error) { console.error(`桌面浏览器产物同步失败：${error.message}`); process.exitCode = 1; }
});
